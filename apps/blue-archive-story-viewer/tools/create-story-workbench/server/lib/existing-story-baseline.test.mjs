import assert from "node:assert/strict";
import test from "node:test";

import {
  adoptExistingStoryBaseline,
  inspectExistingTrackCompletion,
} from "./existing-story-baseline.mjs";

function story() {
  return {
    GroupId: 31010,
    translator: "raw",
    content: [
      { GroupId: 31010, SelectionGroup: 0, ScriptKr: "1;아루;00;대사", TextJp: "台詞", TextCn: "", TextJpVoice: "", VoiceJp: "" },
      { GroupId: 31010, SelectionGroup: 0, ScriptKr: "#na;아루;既存", TextJp: "既存", TextCn: "", TextJpVoice: "", VoiceJp: "" },
    ],
  };
}

test("inherits completed viewer fields only from structurally matching rows", () => {
  const imported = story();
  const existing = story();
  existing.translator = "viewer";
  existing.content[0].TextCn = "台词";
  existing.content[0].TextJpVoice = "[calm]台詞";
  existing.content[1].TextCn = "既有";
  existing.content[1].VoiceJp = "Main_31010_001";
  existing.content[1].ScriptKr = "#na;不同;既存";

  const { story: adopted, summary } = adoptExistingStoryBaseline(imported, existing);
  assert.equal(summary.compatible, true);
  assert.equal(summary.matchedRows, 1);
  assert.deepEqual(summary.unmatchedIndices, [1]);
  assert.equal(adopted.content[0].TextCn, "台词");
  assert.equal(adopted.content[0].TextJpVoice, "[calm]台詞");
  assert.equal(adopted.content[1].TextCn, "");
  assert.equal(adopted.translator, "raw + viewer");
});

test("classifies complete CN and preserves existing voiced dialogue", () => {
  const value = story();
  value.content[0].TextCn = "台词";
  value.content[0].TextJpVoice = "[calm]台詞";
  value.content[1].TextCn = "既有";
  value.content[1].VoiceJp = "Main_31010_001";
  const completion = inspectExistingTrackCompletion(value);
  assert.equal(completion.cnComplete, true);
  assert.equal(completion.voiceScriptComplete, true);
  assert.deepEqual(completion.preservedVoiceIndices, [1]);
  assert.deepEqual(completion.missingVoiceScriptIndices, []);
});

test("does not adopt a baseline with a different row count", () => {
  const imported = story();
  const existing = story();
  existing.content.pop();
  existing.content[0].TextCn = "不应继承";
  const { story: adopted, summary } = adoptExistingStoryBaseline(imported, existing);
  assert.equal(summary.compatible, false);
  assert.equal(adopted.content[0].TextCn, "");
});
