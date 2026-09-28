import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createTask, effectiveTtsText, selectReferenceClips, uploadReference } from "./voice-zero-tts.mjs";
import { normalizeTextJpVoice } from "./shared-config.mjs";
import {
  effectiveTtsText as workbenchEffectiveTtsText,
} from "../create-story-workbench/server/lib/utils.mjs";

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

test("replaces [USERNAME] placeholder with default username in TTS text and voice script normalization", () => {
  assert.equal(
    effectiveTtsText({ TextJpVoice: "こんにちは、[USERNAME]先生。" }),
    "こんにちは、エロマンガ先生。",
  );
  assert.equal(
    effectiveTtsText({ TextJp: "ようこそ、[USERNAME]先生。" }),
    "ようこそ、エロマンガ先生。",
  );
  assert.equal(
    normalizeTextJpVoice("[calm]こんにちは、[USERNAME]先生。"),
    "[calm]こんにちは、エロマンガ先生。",
  );
  assert.equal(
    workbenchEffectiveTtsText({ TextJpVoice: "[calm]こんにちは、[USERNAME]先生。" }),
    "[calm]こんにちは、エロマンガ先生。",
  );
});

test("replaces a changed character reference before creating new TTS tasks", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ba-reference-test-"));
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.ZERO_TTS_API_KEY;
  const calls = [];
  try {
    const audioPath = path.join(directory, "reference.mp3");
    fs.writeFileSync(audioPath, "new reference audio");
    process.env.ZERO_TTS_API_KEY = "test-token";
    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), method: options.method || "GET", body: options.body });
      const result = calls.length === 1
        ? [{ name: "BA 阿罗娜", referenceId: "old-reference", voiceId: 1 }]
        : calls.length === 3
          ? { referenceId: "new-reference", voiceId: 2, status: "READY" }
          : null;
      return Response.json({ code: 200, data: result });
    };
    const reference = {
      speaker: "아로나", characterName: "阿罗娜", audioPath,
      referenceText: "こんにちは", audioFingerprint: "a".repeat(64),
      uploadedFingerprint: "b".repeat(64), referenceId: "old-reference",
    };
    const updated = await uploadReference({ ttsBaseUrl: "https://example.test/api/tts" }, reference);
    assert.deepEqual(calls.map(call => call.method), ["GET", "DELETE", "POST"]);
    assert.match(calls[1].url, /\/voices\/ref\/old-reference$/u);
    assert.equal(calls[2].body.get("name"), "BA 阿罗娜");
    assert.equal(updated.referenceId, "new-reference");
    assert.equal(updated.uploadedFingerprint, reference.audioFingerprint);
    const line = { index: 7, speaker: "아로나", characterName: "阿罗娜", text: "こんにちは" };
    globalThis.fetch = async (_url, options) => {
      calls.push({ method: options.method || "GET", body: options.body });
      return Response.json({ code: 200, data: { taskId: "new-task", status: "PENDING" } });
    };
    const task = await createTask(
      { ttsBaseUrl: "https://example.test/api/tts", model: "zerotts-v3" },
      line, updated,
      { taskId: "old-task", referenceId: "old-reference", generatedText: line.text, speaker: line.speaker },
    );
    assert.equal(task.taskId, "new-task");
    assert.equal(task.referenceId, "new-reference");
    assert.equal(task.needsPublish, true);
    assert.equal(calls.at(-1).method, "POST");
    assert.equal(JSON.parse(calls.at(-1).body).referenceId, "new-reference");
    calls.length = 0;
    globalThis.fetch = async (_url, options) => {
      calls.push(options.method || "GET");
      return Response.json({ code: 200, data: [{ name: "BA 阿罗娜", referenceId: "new-reference", voiceId: 2 }] });
    };
    assert.equal((await uploadReference({ ttsBaseUrl: "https://example.test/api/tts" }, updated)).referenceId, "new-reference");
    assert.deepEqual(calls, ["GET"]);
    calls.length = 0;
    globalThis.fetch = async (_url, options) => {
      calls.push(options.method || "GET");
      return Response.json({ code: 503, message: "voice list unavailable" });
    };
    await assert.rejects(
      uploadReference({ ttsBaseUrl: "https://example.test/api/tts" }, reference),
      /voice list unavailable/u,
    );
    assert.deepEqual(calls, ["GET"]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.ZERO_TTS_API_KEY;
    else process.env.ZERO_TTS_API_KEY = originalToken;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
