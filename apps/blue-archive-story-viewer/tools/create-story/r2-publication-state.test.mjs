import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { manifestProvesCurrentAudioPublished } from "./r2-publication-state.mjs";

function hash(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

test("recognizes an unchanged published TTS task without consulting Story VoiceJp", () => {
  assert.equal(manifestProvesCurrentAudioPublished({
    taskId: "task-1",
    publishedTaskId: "task-1",
    generatedText: "台詞。",
    generatedTextHash: hash("台詞。"),
    publishedTextHash: hash("台詞。"),
    needsPublish: false,
  }), true);
});

test("requires upload when task identity or generated text changed", () => {
  const base = {
    taskId: "task-2",
    publishedTaskId: "task-1",
    generatedText: "新しい台詞。",
    generatedTextHash: hash("新しい台詞。"),
    publishedTextHash: hash("以前の台詞。"),
    needsPublish: false,
  };
  assert.equal(manifestProvesCurrentAudioPublished(base), false);
  assert.equal(manifestProvesCurrentAudioPublished({
    ...base,
    publishedTaskId: "task-2",
  }), false);
});

test("needsPublish always forces an upload", () => {
  assert.equal(manifestProvesCurrentAudioPublished({
    taskId: "task-1",
    publishedTaskId: "task-1",
    generatedTextHash: hash("台詞。"),
    publishedTextHash: hash("台詞。"),
    needsPublish: true,
  }), false);
});

test("supports collective audio publication identity", () => {
  assert.equal(manifestProvesCurrentAudioPublished({
    mix: { inputsHash: "mix-1" },
    publishedTaskId: "mix-1",
    generatedText: "みんな！",
    publishedText: "みんな！",
    needsPublish: false,
  }), true);
});
