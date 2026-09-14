import assert from "node:assert/strict";
import test from "node:test";

import { selectReferenceClips } from "./voice-zero-tts.mjs";

function args(overrides = {}) {
  return {
    referenceSelection: "",
    referenceMinClip: 5,
    referenceMin: 20,
    referenceMax: 60,
    ...overrides,
  };
}

function candidate(baseName, duration, category = "通常") {
  return { baseName, duration, category };
}

test("warns and keeps the best available clips when total duration is below the recommendation", () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = message => warnings.push(String(message));
  try {
    const selected = selectReferenceClips([
      candidate("clip-1", 6.16),
      candidate("clip-2", 5.898),
    ], args(), "아로나");

    assert.deepEqual(selected.map(item => item.baseName), ["clip-1", "clip-2"]);
    assert.match(warnings[0], /아로나.*12\.058s.*未达到建议的 20s/u);
  } finally {
    console.warn = originalWarn;
  }
});

test("still rejects a character with no usable reference clips", () => {
  assert.throws(
    () => selectReferenceClips([], args(), "missing"),
    /No usable reference clips found/u,
  );
});

test("warns and honors explicitly selected short clips", () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = message => warnings.push(String(message));
  try {
    const selected = selectReferenceClips([
      candidate("short", 2.4),
      candidate("long", 6.2),
    ], args({
      referenceSelection: "fixture.json",
      referenceSelections: { "아로나": ["short", "long"] },
    }), "아로나");

    assert.deepEqual(selected.map(item => item.baseName), ["short", "long"]);
    assert.match(warnings[0], /아로나.*2 个参考片段.*1 个短于建议的 5s.*继续/u);
  } finally {
    console.warn = originalWarn;
  }
});
