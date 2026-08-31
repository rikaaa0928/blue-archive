import assert from "node:assert/strict";
import test from "node:test";

import { prerequisiteStageForJob } from "./job-policy.mjs";

test("routes reference resource TTS actions through the resources stage", () => {
  assert.equal(prerequisiteStageForJob("download-missing-characters"), "resources");
  assert.equal(prerequisiteStageForJob("tts", { ttsStage: "prepare" }), "resources");
  assert.equal(prerequisiteStageForJob("tts", { ttsStage: "upload" }), "resources");
});

test("keeps synthesis TTS actions behind tool 2 approval", () => {
  assert.equal(prerequisiteStageForJob("tts", { ttsStage: "tasks" }), "tts");
  assert.equal(prerequisiteStageForJob("tts", { ttsStage: "poll" }), "tts");
  assert.equal(prerequisiteStageForJob("tts", { ttsStage: "all" }), "tts");
  assert.equal(prerequisiteStageForJob("r2"), "r2");
});

test("keeps selective voice regeneration inside the active tool 2 gate", () => {
  assert.equal(prerequisiteStageForJob("voice-regenerate"), "review-2");
});

test("routes localized post-generation revision through the completed TTS gate", () => {
  assert.equal(prerequisiteStageForJob("tts-line-revise"), "tts");
  assert.equal(prerequisiteStageForJob("tts-line-skip"), "tts");
});
