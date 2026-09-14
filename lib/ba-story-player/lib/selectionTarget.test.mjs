import assert from "node:assert/strict";
import test from "node:test";

import { findSelectionTargetIndex } from "./selectionTarget.ts";

test("selection lookup stays after the current page and inside its story group", () => {
  const storyUnits = [
    { GroupId: 11005, SelectionGroup: 0 },
    { GroupId: 11005, SelectionGroup: 1 },
    { GroupId: 11008, SelectionGroup: 0 },
    { GroupId: 11008, SelectionGroup: 1 },
  ];

  assert.equal(findSelectionTargetIndex(storyUnits, 2, 1), 3);
});

test("selection lookup rejects a matching group from a later merged story", () => {
  const storyUnits = [
    { GroupId: 11008, SelectionGroup: 0 },
    { GroupId: 11009, SelectionGroup: 1 },
  ];

  assert.equal(findSelectionTargetIndex(storyUnits, 0, 1), -1);
});
