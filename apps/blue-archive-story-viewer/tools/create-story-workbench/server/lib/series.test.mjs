import assert from "node:assert/strict";
import test from "node:test";

import { resolveMainSeries } from "./series.mjs";

test("resolves existing main-story JSON files by numeric prefix", () => {
  const series = resolveMainSeries("31");
  assert.equal(series.type, "main");
  assert.ok(series.chapters.length > 0);
  assert.ok(series.chapters.every(chapter => chapter.storyId.startsWith("31")));
  assert.ok(series.chapters.every(chapter => chapter.directoryId === ""));
  assert.deepEqual(
    series.chapters.map(chapter => Number(chapter.storyId)),
    [...series.chapters].map(chapter => Number(chapter.storyId)).sort((left, right) => left - right),
  );
});

test("rejects ambiguous free-text main-story filters", () => {
  assert.throws(() => resolveMainSeries("Eden"), /数字前缀/u);
});
