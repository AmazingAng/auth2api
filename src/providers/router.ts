import { ProviderName } from "./types";

const CLAUDE_PREFIXES = ["claude-"];
const CODEX_PREFIXES = ["gpt-", "codex-"];

export function resolveProviderFromModel(model: string): ProviderName | null {
  const normalized = model.trim().toLowerCase();

  if (CLAUDE_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return "claude";
  }

  if (CODEX_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return "codex";
  }

  if (/^o\d/.test(normalized)) {
    return "codex";
  }

  return null;
}
