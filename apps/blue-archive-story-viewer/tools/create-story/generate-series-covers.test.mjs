import assert from "node:assert/strict";
import test from "node:test";

import { parseSeriesCoverArguments, validateSeriesCoverPlan } from "./generate-series-covers.mjs";

const chapters = ["10002005", "10002010", "10002015", "10002020"]
  .map(storyId => ({ storyId }));

test("uses the stable Gemini image model by default", () => {
  const options = parseSeriesCoverArguments(["series.json"]);
  assert.equal(options.imageModel, "gemini-3.1-flash-image");
  assert.equal(options.resolution, "2K");
});

test("normalizes a varied series plan into chapter order", () => {
  const plan = validateSeriesCoverPlan({
    seriesArc: "summer arc",
    rotationStrategy: "alternate intensity",
    items: [
      { storyId: "10002015", coverDirection: "easter-egg" },
      { storyId: "10002005", coverDirection: "dramatic" },
      { storyId: "10002020", coverDirection: "symbolic" },
      { storyId: "10002010", coverDirection: "lyrical" },
    ],
  }, chapters);
  assert.deepEqual(plan.items.map(item => item.storyId), chapters.map(item => item.storyId));
});

test("rejects repetitive or incomplete series plans", () => {
  assert.throws(() => validateSeriesCoverPlan({ items: chapters.map((chapter, index) => ({
    storyId: chapter.storyId,
    coverDirection: index % 2 ? "lyrical" : "dramatic",
  })) }, chapters), /at least|uses only|Adjacent/u);
  assert.throws(() => validateSeriesCoverPlan({ items: [] }, chapters), /Expected 4/u);
});
