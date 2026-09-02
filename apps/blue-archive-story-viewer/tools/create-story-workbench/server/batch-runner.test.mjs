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
      references: { ready: false },
      script: { generationCount: 0, ready: false },
      tts: { voiceStoryReady: false },
    },
    assembly: { current: false, inspection: { errors: [], choices: [] } },
    preview: { branches: { checkedSelectionKeys: [], defaultSelectionGroups: {} } },
    recording: { current: false },
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

test("skips generation for tracks adopted from an existing viewer baseline", () => {
  assert.deepEqual(nextBatchStep(state(), production({
    cn: { generationCount: 0, ready: true },
    voice: {
      speakers: { scannedAt: "2026-09-01T00:00:00Z", ready: true, unresolvedCount: 0 },
      script: { generationCount: 0, ready: true },
    },
  })), {
    gate: "production-prerequisites-complete",
    label: "两条线路前置任务已完成",
  });
});

test("one-click completion accepts candidates and advances through recording", () => {
  assert.deepEqual(nextBatchStep(state(), production({
    cn: { generationCount: 1, ready: false },
  }), "complete"), { action: "production-cn-approve" });

  const readyVoice = {
    speakers: { scannedAt: "2026-09-01T00:00:00Z", ready: true, unresolvedCount: 0 },
    references: { ready: true },
    script: { generationCount: 1, ready: true },
    tts: { voiceStoryReady: true },
  };
  assert.deepEqual(nextBatchStep(state(), production({
    cn: { generationCount: 1, ready: true },
    voice: { ...readyVoice, speakers: { ...readyVoice.speakers, ready: false, unresolvedCount: 2 } },
  }), "complete"), { action: "production-speakers-default-npc" });
  assert.deepEqual(nextBatchStep(state(), production({
    cn: { generationCount: 1, ready: true }, voice: readyVoice,
  }), "complete"), { action: "production-assemble" });

  const choice = {
    index: 12,
    options: [
      { key: "12:1", selectionGroup: 1 },
      { key: "12:2", selectionGroup: 2 },
    ],
  };
  const assembled = production({
    cn: { generationCount: 1, ready: true },
    voice: readyVoice,
    assembly: { current: true, inspection: { errors: [], choices: [choice] } },
  });
  assert.deepEqual(nextBatchStep(state(), assembled, "complete"), {
    action: "production-branches-default",
  });
  const previouslySelected = {
    ...assembled,
    preview: {
      branches: {
        checkedSelectionKeys: ["12:1", "12:2"],
        defaultSelectionGroups: { 12: 2 },
      },
    },
  };
  assert.deepEqual(nextBatchStep(state(), previouslySelected, "complete"), {
    action: "production-record",
  });
  const branchesReady = {
    ...assembled,
    preview: {
      branches: {
        checkedSelectionKeys: ["12:1", "12:2"],
        defaultSelectionGroups: { 12: 1 },
      },
    },
  };
  assert.deepEqual(nextBatchStep(state(), branchesReady, "complete"), {
    action: "production-record",
  });
  assert.deepEqual(nextBatchStep(state(), {
    ...branchesReady, recording: { current: true },
  }, "complete"), {
    gate: "production-recording-complete",
    label: "录制与完整性验收已完成",
  });
});

test("does not start a batch when shared source tables are unavailable", () => {
  assert.equal(nextBatchStep(state(false), null).gate, "tables");
});
