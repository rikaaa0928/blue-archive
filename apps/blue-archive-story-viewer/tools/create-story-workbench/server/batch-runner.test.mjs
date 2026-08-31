import assert from "node:assert/strict";
import test from "node:test";

import { nextBatchStep } from "./batch-runner.mjs";

function state(tablesReady = true) {
  return { tables: { ready: tablesReady }, stages: [] };
}

function production(overrides = {}) {
  return {
    cn: { generationCount: 0, ready: false },
    voice: {
      speakers: { scannedAt: null, ready: false, unresolvedCount: 0 },
      script: { generationCount: 0, ready: false },
    },
    ...overrides,
  };
}

test("prepares a clean production and advances independent automatic prerequisites", () => {
  assert.deepEqual(nextBatchStep(state(), null), { action: "production-prepare" });
  assert.deepEqual(nextBatchStep(state(), production()), { action: "production-cn-generate" });
  assert.deepEqual(nextBatchStep(state(), production({
    cn: { generationCount: 1, ready: false },
  })), { action: "production-speaker-scan" });
  assert.deepEqual(nextBatchStep(state(), production({
    cn: { generationCount: 1, ready: false },
    voice: {
      speakers: { scannedAt: "2026-08-20T00:00:00Z", ready: false, unresolvedCount: 2 },
      script: { generationCount: 0, ready: false },
    },
  })), { action: "production-voice-script-generate" });
});

test("reports every independent human gate after automatic preparation", () => {
  const step = nextBatchStep(state(), production({
    cn: { generationCount: 1, ready: false },
    voice: {
      speakers: { scannedAt: "2026-08-20T00:00:00Z", ready: false, unresolvedCount: 2 },
      script: { generationCount: 1, ready: false },
    },
  }));
  assert.equal(step.gate, "production-human");
  assert.match(step.label, /简中整体审查/u);
  assert.match(step.label, /2 个说话人例外/u);
  assert.match(step.label, /配音稿整体审查/u);
});

test("does not start a batch when shared source tables are unavailable", () => {
  assert.equal(nextBatchStep(state(false), null).gate, "tables");
});
