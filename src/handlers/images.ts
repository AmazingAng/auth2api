import { Request, Response as ExpressResponse } from "express";
import { Config, isDebugLevel } from "../config";
import { ProviderRegistry } from "../providers/registry";
import { proxyWithRetry } from "../utils/http";
import { tagStatsModel, tagStatsUsage } from "../stats/recorder";
import { resolveModel } from "../upstream/translator";
import { normalizeCodexResponsesBody } from "../upstream/codex-api";
import { drainCodexResponsesSse } from "../upstream/responses-translator";

type ImageAction = "generate" | "edit";

interface UploadedPart {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
}

interface ParsedImageRequest {
  prompt: string;
  imageModel: string;
  codexModel: string;
  responseFormat: "b64_json";
  imageUrls: string[];
  maskUrl?: string;
  options: Record<string, unknown>;
}

interface GeneratedImage {
  b64?: string;
  url?: string;
  revisedPrompt?: string;
}

function openaiErrorBody(_status: number, body: string): any {
  try {
    const parsed = JSON.parse(body);
    const msg =
      parsed?.error?.message ||
      (typeof parsed?.detail === "string" ? parsed.detail : null) ||
      parsed?.error?.error?.message ||
      "Upstream request failed";
    const type = parsed?.error?.type || "upstream_error";
    return { error: { message: msg, type } };
  } catch {
    return {
      error: { message: "Upstream request failed", type: "upstream_error" },
    };
  }
}

function internalError(resp: ExpressResponse): void {
  if (!resp.headersSent) {
    resp.status(500).json({ error: { message: "Internal server error" } });
  } else if (!resp.writableEnded) {
    resp.end();
  }
}

function badRequest(resp: ExpressResponse, message: string): void {
  resp.status(400).json({ error: { message, type: "invalid_request_error" } });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function oneOf(
  body: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = stringValue(body[key]);
    if (value) return value;
  }
  return undefined;
}

function normalizeImageReference(value: unknown): string | undefined {
  const raw = stringValue(value);
  if (!raw) return undefined;
  if (
    raw.startsWith("data:") ||
    raw.startsWith("http://") ||
    raw.startsWith("https://")
  ) {
    return raw;
  }
  // Accept bare base64 for simple JSON clients.
  return `data:image/png;base64,${raw}`;
}

function collectImageReferences(...values: unknown[]): string[] {
  const refs: string[] = [];
  for (const value of values) {
    if (Array.isArray(value)) {
      refs.push(...collectImageReferences(...value));
      continue;
    }
    if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      const nested =
        normalizeImageReference(obj.url) ||
        normalizeImageReference(obj.image_url) ||
        normalizeImageReference(obj.b64_json);
      if (nested) refs.push(nested);
      continue;
    }
    const ref = normalizeImageReference(value);
    if (ref) refs.push(ref);
  }
  return refs;
}

function guessMime(filename?: string, fallback = "image/png"): string {
  const lower = (filename || "").toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return fallback;
}

function dataUrlFromPart(part: UploadedPart): string {
  const mime = part.contentType || guessMime(part.filename);
  return `data:${mime};base64,${part.data.toString("base64")}`;
}

function parseContentDisposition(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const piece of value.split(";")) {
    const [rawKey, ...rawRest] = piece.trim().split("=");
    if (!rawKey || rawRest.length === 0) continue;
    let rawValue = rawRest.join("=").trim();
    if (rawValue.startsWith('"') && rawValue.endsWith('"')) {
      rawValue = rawValue.slice(1, -1);
    }
    out[rawKey.toLowerCase()] = rawValue;
  }
  return out;
}

function stripTrailingLineBreak(data: Buffer): Buffer {
  if (
    data.length >= 2 &&
    data[data.length - 2] === 13 &&
    data[data.length - 1] === 10
  ) {
    return data.subarray(0, data.length - 2);
  }
  if (data.length >= 1 && data[data.length - 1] === 10) {
    return data.subarray(0, data.length - 1);
  }
  return data;
}

function findHeaderEnd(part: Buffer): { index: number; size: number } | null {
  const crlf = Buffer.from("\r\n\r\n");
  const lf = Buffer.from("\n\n");
  const crlfIndex = part.indexOf(crlf);
  if (crlfIndex >= 0) return { index: crlfIndex, size: crlf.length };
  const lfIndex = part.indexOf(lf);
  if (lfIndex >= 0) return { index: lfIndex, size: lf.length };
  return null;
}

function parseMultipartFormData(
  contentType: string,
  body: Buffer,
): { fields: Map<string, string[]>; files: UploadedPart[] } {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const boundaryValue = boundaryMatch?.[1] || boundaryMatch?.[2];
  if (!boundaryValue) {
    throw new Error("multipart boundary missing");
  }

  const boundary = Buffer.from(`--${boundaryValue}`);
  const fields = new Map<string, string[]>();
  const files: UploadedPart[] = [];

  let cursor = body.indexOf(boundary);
  while (cursor >= 0) {
    cursor += boundary.length;
    if (body[cursor] === 45 && body[cursor + 1] === 45) break;
    if (body[cursor] === 13 && body[cursor + 1] === 10) cursor += 2;
    else if (body[cursor] === 10) cursor += 1;

    const nextBoundary = body.indexOf(boundary, cursor);
    if (nextBoundary < 0) break;
    let rawPart = body.subarray(cursor, nextBoundary);
    rawPart = stripTrailingLineBreak(rawPart);
    cursor = nextBoundary;

    const headerEnd = findHeaderEnd(rawPart);
    if (!headerEnd) continue;
    const rawHeaders = rawPart.subarray(0, headerEnd.index).toString("utf8");
    const data = rawPart.subarray(headerEnd.index + headerEnd.size);
    const headers = new Map<string, string>();
    for (const line of rawHeaders.split(/\r?\n/)) {
      const idx = line.indexOf(":");
      if (idx < 0) continue;
      headers.set(
        line.slice(0, idx).trim().toLowerCase(),
        line.slice(idx + 1).trim(),
      );
    }

    const disposition = headers.get("content-disposition");
    if (!disposition) continue;
    const parts = parseContentDisposition(disposition);
    const name = parts.name;
    if (!name) continue;
    const filename = parts.filename;
    const contentTypeHeader = headers.get("content-type");

    if (filename || contentTypeHeader?.startsWith("image/")) {
      files.push({ name, filename, contentType: contentTypeHeader, data });
      continue;
    }
    const existing = fields.get(name) || [];
    existing.push(data.toString("utf8"));
    fields.set(name, existing);
  }

  return { fields, files };
}

function fieldValue(
  fields: Map<string, string[]>,
  name: string,
): string | undefined {
  return fields.get(name)?.[0]?.trim() || undefined;
}

function fieldValues(fields: Map<string, string[]>, name: string): string[] {
  return (fields.get(name) || []).map((v) => v.trim()).filter(Boolean);
}

function imageToolOptions(
  body: Record<string, unknown>,
  action: ImageAction,
): Record<string, unknown> {
  const tool: Record<string, unknown> = {
    type: "image_generation",
    action,
  };
  const imageModel = stringValue(body.model) || "gpt-image-2";
  tool.model = imageModel;

  for (const key of [
    "size",
    "quality",
    "background",
    "output_format",
    "output_compression",
    "moderation",
    "partial_images",
    "input_fidelity",
  ]) {
    if (body[key] !== undefined && body[key] !== null && body[key] !== "") {
      tool[key] = body[key];
    }
  }

  if (tool.output_format === undefined) tool.output_format = "png";
  return tool;
}

function parseJsonImageRequest(
  rawBody: Record<string, unknown>,
  action: ImageAction,
): ParsedImageRequest {
  const prompt = stringValue(rawBody.prompt) || "";
  const responseFormat = stringValue(rawBody.response_format) || "b64_json";
  if (responseFormat !== "b64_json") {
    throw new Error(
      "Codex-backed image routes only support response_format=b64_json",
    );
  }

  const imageUrls =
    action === "edit"
      ? collectImageReferences(
          rawBody.image,
          rawBody.images,
          rawBody.image_url,
          rawBody.image_urls,
        )
      : [];

  return {
    prompt,
    imageModel: stringValue(rawBody.model) || "gpt-image-2",
    codexModel:
      oneOf(rawBody, ["codex_model", "response_model", "routing_model"]) ||
      "gpt-5.5",
    responseFormat: "b64_json",
    imageUrls,
    maskUrl: normalizeImageReference(rawBody.mask),
    options: imageToolOptions(rawBody, action),
  };
}

function parseMultipartImageRequest(req: Request): ParsedImageRequest {
  const contentType = String(req.headers["content-type"] || "");
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const { fields, files } = parseMultipartFormData(contentType, body);
  const record: Record<string, unknown> = {};
  for (const [key, values] of fields) {
    record[key] = values.length > 1 ? values : values[0];
  }

  const parsed = parseJsonImageRequest(record, "edit");
  const imageFiles = files.filter(
    (f) => f.name === "image" || f.name === "image[]",
  );
  const maskFile = files.find((f) => f.name === "mask");
  parsed.imageUrls.push(...imageFiles.map(dataUrlFromPart));
  if (!parsed.maskUrl && maskFile) parsed.maskUrl = dataUrlFromPart(maskFile);
  return parsed;
}

function parseImageRequest(
  req: Request,
  action: ImageAction,
): ParsedImageRequest {
  const contentType = String(req.headers["content-type"] || "");
  if (contentType.startsWith("multipart/form-data")) {
    if (action !== "edit") {
      throw new Error("multipart form data is only supported for image edits");
    }
    return parseMultipartImageRequest(req);
  }
  const rawBody =
    req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)
      ? (req.body as Record<string, unknown>)
      : {};
  return parseJsonImageRequest(rawBody, action);
}

function buildCodexImageBody(
  parsed: ParsedImageRequest,
  action: ImageAction,
): any {
  const content: any[] = [{ type: "input_text", text: parsed.prompt }];
  for (const url of parsed.imageUrls) {
    content.push({ type: "input_image", image_url: url });
  }

  const tool = { ...parsed.options };
  if (parsed.maskUrl) {
    tool.input_image_mask = { image_url: parsed.maskUrl };
  }

  return normalizeCodexResponsesBody({
    model: resolveModel(parsed.codexModel),
    instructions:
      action === "edit"
        ? "Edit the supplied image using the image_generation tool. Return the generated image."
        : "Generate the requested image using the image_generation tool. Return the generated image.",
    input: [{ role: "user", content }],
    tools: [tool],
    tool_choice: { type: "image_generation" },
    store: false,
    stream: true,
  });
}

function findImagePayload(item: any): GeneratedImage | null {
  if (!item || typeof item !== "object") return null;
  if (item.type === "image_generation_call") {
    const b64 =
      stringValue(item.result) ||
      stringValue(item.b64_json) ||
      stringValue(item.image?.b64_json);
    const url = stringValue(item.url) || stringValue(item.image_url);
    if (b64 || url) {
      return {
        b64,
        url,
        revisedPrompt:
          stringValue(item.revised_prompt) ||
          stringValue(item.revisedPrompt) ||
          stringValue(item.prompt),
      };
    }
  }

  const content = Array.isArray(item.content) ? item.content : [];
  for (const part of content) {
    if (part?.type === "output_image" || part?.type === "image") {
      const b64 =
        stringValue(part.b64_json) || stringValue(part.image?.b64_json);
      const url = stringValue(part.url) || stringValue(part.image_url);
      if (b64 || url) {
        return {
          b64,
          url,
          revisedPrompt:
            stringValue(part.revised_prompt) ||
            stringValue(part.revisedPrompt) ||
            stringValue(item.revised_prompt),
        };
      }
    }
  }

  return null;
}

function extractGeneratedImages(
  outputItems: any[],
  completedResponse: any,
): GeneratedImage[] {
  const candidates = [
    ...outputItems,
    ...(Array.isArray(completedResponse?.output)
      ? completedResponse.output
      : []),
  ];
  const seen = new Set<string>();
  const images: GeneratedImage[] = [];
  for (const item of candidates) {
    const image = findImagePayload(item);
    if (!image) continue;
    const key = image.b64 || image.url || "";
    if (!key || seen.has(key)) continue;
    seen.add(key);
    images.push(image);
  }
  return images;
}

function imageResponse(images: GeneratedImage[]): any {
  return {
    created: Math.floor(Date.now() / 1000),
    data: images.map((image) => {
      const item: Record<string, string> = {};
      if (image.b64) item.b64_json = image.b64;
      if (image.url) item.url = image.url;
      if (image.revisedPrompt) item.revised_prompt = image.revisedPrompt;
      return item;
    }),
  };
}

function usageFromResponsesUsage(usage: any) {
  return {
    inputTokens: usage?.input_tokens || 0,
    outputTokens: usage?.output_tokens || 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: usage?.input_tokens_details?.cached_tokens || 0,
    reasoningOutputTokens: usage?.output_tokens_details?.reasoning_tokens || 0,
  };
}

function createImageHandler(
  config: Config,
  registry: ProviderRegistry,
  action: ImageAction,
) {
  return async (req: Request, resp: ExpressResponse): Promise<void> => {
    try {
      let parsed: ParsedImageRequest;
      try {
        parsed = parseImageRequest(req, action);
      } catch (err: any) {
        badRequest(resp, err.message);
        return;
      }

      if (!parsed.prompt) {
        badRequest(resp, "prompt is required");
        return;
      }
      if (action === "edit" && parsed.imageUrls.length === 0) {
        badRequest(resp, "image is required for image edits");
        return;
      }
      const n = Number((req.body as any)?.n ?? 1);
      if (Number.isFinite(n) && n > 1) {
        badRequest(resp, "Codex-backed image routes currently support n=1");
        return;
      }

      const provider = registry.get("codex");
      const upstreamBody = buildCodexImageBody(parsed, action);
      tagStatsModel(resp, parsed.imageModel, provider.id);

      if (isDebugLevel(config.debug, "verbose")) {
        console.log(`[DEBUG] Codex image ${action} body:`);
        console.log(JSON.stringify(upstreamBody, null, 2));
      }

      await proxyWithRetry(`Images(${action},codex)`, resp, config, {
        manager: provider.manager,
        upstream: (account, signal) =>
          provider.callMessages({
            body: upstreamBody,
            request: req,
            account,
            config,
            signal,
          }),
        success: async (upstream, account) => {
          const drained = await drainCodexResponsesSse(upstream);
          const images = extractGeneratedImages(
            drained.outputItems,
            drained.completedResponse,
          );
          if (drained.upstreamError && images.length === 0) {
            provider.manager.recordFailure(
              account.token.email,
              "server",
              drained.upstreamError,
            );
            resp.status(502).json({
              error: {
                message: drained.upstreamError,
                type: "upstream_error",
              },
            });
            return;
          }
          if (images.length === 0) {
            const message =
              "Codex did not return an image_generation_call result";
            provider.manager.recordFailure(
              account.token.email,
              "server",
              message,
            );
            resp.status(502).json({
              error: { message, type: "upstream_error" },
            });
            return;
          }

          const usage = usageFromResponsesUsage(drained.usage);
          provider.manager.recordSuccess(account.token.email, usage);
          tagStatsUsage(resp, usage);
          resp.json(imageResponse(images));
        },
        errorAdapter: openaiErrorBody,
      });
    } catch (err: any) {
      console.error(`Images ${action} handler error:`, err.message);
      internalError(resp);
    }
  };
}

export function createImageGenerationsHandler(
  config: Config,
  registry: ProviderRegistry,
) {
  return createImageHandler(config, registry, "generate");
}

export function createImageEditsHandler(
  config: Config,
  registry: ProviderRegistry,
) {
  return createImageHandler(config, registry, "edit");
}
