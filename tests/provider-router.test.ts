import test from "node:test";
import assert from "node:assert/strict";

import { resolveProviderFromModel } from "../src/providers/router";

test("claude-sonnet-4-6 routes to claude", () => {
  assert.equal(resolveProviderFromModel("claude-sonnet-4-6"), "claude");
});

test("gpt-5.4 routes to codex", () => {
  assert.equal(resolveProviderFromModel("gpt-5.4"), "codex");
});

test("codex-mini-latest routes to codex", () => {
  assert.equal(resolveProviderFromModel("codex-mini-latest"), "codex");
});

test("unknown model returns null", () => {
  assert.equal(resolveProviderFromModel("not-a-real-model"), null);
});
