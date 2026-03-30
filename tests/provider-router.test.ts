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

test("o3 routes to codex", () => {
  assert.equal(resolveProviderFromModel("o3"), "codex");
});

test("o4-mini routes to codex", () => {
  assert.equal(resolveProviderFromModel("o4-mini"), "codex");
});

test("invalid model input returns null instead of throwing", () => {
  assert.equal(resolveProviderFromModel(undefined as unknown as string), null);
  assert.equal(resolveProviderFromModel(null as unknown as string), null);
  assert.equal(resolveProviderFromModel({ trim: "nope" } as unknown as string), null);
});

test("unknown model returns null", () => {
  assert.equal(resolveProviderFromModel("not-a-real-model"), null);
});
