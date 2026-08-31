import assert from "node:assert/strict";
import test from "node:test";

import { findForbiddenVoiceTags } from "./voice-emotion-tags.mjs";

test("rejects Fish Audio tone, audio-effect, and special-effect tags", () => {
  assert.deepEqual(
    findForbiddenVoiceTags("[happy][laughing]はい。[break][whispering]内緒です。"),
    ["laughing", "break", "whispering"],
  );
});

test("rejects natural-language aliases that still request extra sounds", () => {
  assert.deepEqual(
    findForbiddenVoiceTags("[soft sigh][awkward laugh][short pause][pitch up]はい。"),
    ["soft sigh", "awkward laugh", "short pause", "pitch up"],
  );
});

test("allows official and free-form emotion descriptions", () => {
  assert.deepEqual(findForbiddenVoiceTags(
    "[delighted]やった！\n[overwhelmed but hopeful]きっと大丈夫です。",
  ), []);
});
