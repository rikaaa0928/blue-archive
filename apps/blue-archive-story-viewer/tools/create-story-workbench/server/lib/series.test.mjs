import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveMainSeries } from "./series.mjs";

test("resolves main-story modes and existing JSON files by numeric prefix", () => {
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

test("discovers main-story chapters that have not been imported yet", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "main-series-"));
  try {
    const modePath = path.join(root, "ScenarioModeDBSchema.json");
    fs.writeFileSync(modePath, JSON.stringify([{ Bytes: {
      ModeId: 99020, ModeType: "Main", VolumeId: 9, ChapterId: 9, EpisodeId: 2,
      Open: true, Hide: false, FrontScenarioGroupId: [99020], BackScenarioGroupId: [99025],
    } }]));
    const series = resolveMainSeries("99", {
      scenarioScriptPath: path.join(root, "ScenarioScriptDBSchema.json"),
      scenarioModePath: modePath,
    });
    const chapter = series.chapters.find(item => item.storyId === "99020");
    assert.ok(chapter);
    assert.deepEqual(chapter.sourceGroupIds, ["99020", "99025"]);
    assert.equal(chapter.imported, false);
    assert.equal(chapter.progress.code, "not-imported");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects ambiguous free-text main-story filters", () => {
  assert.throws(() => resolveMainSeries("Eden"), /数字前缀/u);
});
