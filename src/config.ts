import crypto from "crypto";
import fs from "fs";
import path from "path";
import yaml from "js-yaml";

/**
 * Cloaking configuration for request fingerprinting.
 * Controls how auth2api mimics Claude Code CLI's request signature.
 */
export interface CloakingConfig {
  /** CLI version to impersonate in User-Agent and fingerprint (default: 2.1.88) */
  "cli-version"?: string;
  /** Entrypoint value for billing header (default: cli) */
  entrypoint?: string;
}

export interface TimeoutConfig {
  "messages-ms": number;
  "stream-messages-ms": number;
  "count-tokens-ms": number;
}

export type DebugMode = "off" | "errors" | "verbose";

export interface Config {
  host: string;
  port: number;
  "auth-dir": string;
  "api-keys": Set<string>;
  "body-limit": string;
  cloaking: CloakingConfig;
  timeouts: TimeoutConfig;
  debug: DebugMode;
}

// Raw config shape from YAML (api-keys is an array, not a Set)
interface RawConfig extends Omit<Config, "api-keys"> {
  "api-keys": string[];
}

const DEFAULT_RAW: RawConfig = {
  host: "",
  port: 8317,
  "auth-dir": "~/.auth2api",
  "api-keys": [],
  "body-limit": "200mb",
  cloaking: {
    "cli-version": "2.1.88",
    entrypoint: "cli",
  },
  timeouts: {
    "messages-ms": 120000,
    "stream-messages-ms": 600000,
    "count-tokens-ms": 30000,
  },
  debug: "off",
};

function normalizeDebugMode(value: unknown): DebugMode {
  if (value === true) return "errors";
  if (value === false || value == null) return "off";
  if (value === "off" || value === "errors" || value === "verbose")
    return value;
  return "off";
}

export function isDebugLevel(
  debug: DebugMode,
  level: Exclude<DebugMode, "off">,
): boolean {
  if (debug === "verbose") return true;
  return debug === level;
}

export function resolveAuthDir(dir: string): string {
  if (dir.startsWith("~")) {
    return path.join(process.env.HOME || "/root", dir.slice(1));
  }
  return path.resolve(dir);
}

export function generateApiKey(): string {
  return "sk-" + crypto.randomBytes(32).toString("hex");
}

export function loadConfig(configPath?: string): Config {
  const filePath = configPath || "config.yaml";
  let raw: RawConfig;

  if (!fs.existsSync(filePath)) {
    console.log(`Config file not found at ${filePath}, using defaults`);
    raw = { ...DEFAULT_RAW };
  } else {
    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = yaml.load(content) as Partial<RawConfig>;
    raw = {
      ...DEFAULT_RAW,
      ...parsed,
      cloaking: { ...DEFAULT_RAW.cloaking, ...(parsed.cloaking || {}) },
      timeouts: { ...DEFAULT_RAW.timeouts, ...(parsed.timeouts || {}) },
    };
  }

  raw.debug = normalizeDebugMode(raw.debug);

  // Auto-generate API key if none configured
  if (!raw["api-keys"] || raw["api-keys"].length === 0) {
    const key = generateApiKey();
    raw["api-keys"] = [key];
    fs.writeFileSync(filePath, yaml.dump(raw, { lineWidth: -1 }), {
      mode: 0o600,
    });
    console.log(`\nGenerated API key (saved to ${filePath}):\n\n  ${key}\n`);
  }

  return { ...raw, "api-keys": new Set(raw["api-keys"]) };
}
