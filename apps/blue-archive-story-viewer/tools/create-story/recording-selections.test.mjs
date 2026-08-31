import assert from "node:assert/strict";
import test from "node:test";

import {
  findRecordingOptionPages,
  resolveRecordingSelections,
  validateRecordingSelections,
} from "./recording-selections.mjs";

const content = [
  { ScriptKr: "[s1] first\n[s2] second", TextCn: "[s1] 一\n[s2] 二" },
  { ScriptKr: "1;test;00;response", SelectionGroup: 1 },
  { ScriptKr: "1;test;00;response", SelectionGroup: 2 },
  { ScriptKr: "[s] continue", TextCn: "[s] 继续" },
];

test("requires an explicit default for every multi-choice page", () => {
  assert.throws(
    () => resolveRecordingSelections(content, []),
    /Missing recording default at story index 0/u,
  );
});

test("adds deterministic single-option pages and validates the normalized result", () => {
  const selections = resolveRecordingSelections(content, [
    { storyIndex: 0, selectionGroup: 2 },
  ]);
  assert.deepEqual(selections, [
    { storyIndex: 0, selectionGroup: 2 },
    { storyIndex: 3, selectionGroup: 0 },
  ]);
  assert.deepEqual(validateRecordingSelections(content, selections), selections);
});

test("rejects invalid and unrelated defaults", () => {
  assert.throws(
    () => resolveRecordingSelections(content, [{ storyIndex: 0, selectionGroup: 9 }]),
    /Invalid recording default 9/u,
  );
  assert.throws(
    () => resolveRecordingSelections(content, [{ storyIndex: 9, selectionGroup: 1 }]),
    /non-choice rows: 9/u,
  );
  assert.equal(findRecordingOptionPages(content).length, 2);
});
