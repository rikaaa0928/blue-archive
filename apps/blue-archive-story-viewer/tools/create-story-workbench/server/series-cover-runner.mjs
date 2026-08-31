import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { generateSeriesCovers } from "../../create-story/generate-series-covers.mjs";
import { createStoryToolsRoot, localFilesRoot, readJson, writeJsonAtomic } from "./lib/utils.mjs";

function updateBatch(batchPath, progress, result) {
  const batch = readJson(batchPath);
  const assignmentById = new Map((result?.plan?.items ?? []).map(item => [String(item.storyId), item]));
  writeJsonAtomic(batchPath, {
    ...batch,
    plan: result?.plan ?? batch.plan ?? null,
    items: batch.items.map(item => String(item.storyId) === String(progress.storyId)
      ? { ...item, ...progress, assignment: progress.assignment ?? assignmentById.get(String(item.storyId)) ?? item.assignment }
      : { ...item, assignment: assignmentById.get(String(item.storyId)) ?? item.assignment }),
  });
}

function exportJapaneseStory(chapter, params, batchPath) {
  updateBatch(batchPath, { storyId: chapter.storyId, status: "preparing" });
  const args = [
    path.join(createStoryToolsRoot, "import-ba-raw-story.mjs"),
    String(chapter.storyId),
    "--type", "event",
    "--directory-id", String(chapter.directoryId),
    "--output", chapter.storyPath,
    "--workbench-raw-import",
    "--force",
  ];
  if (params.schema) args.push("--schema", String(params.schema));
  if (params.refreshBaL10n) args.push("--refresh-ba-l10n");
  console.log(`Exporting Japanese story source for ${chapter.storyId}...`);
  const result = spawnSync(process.execPath, args, { stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Japanese story export failed for ${chapter.storyId} with exit code ${result.status}`);
  const story = readJson(chapter.storyPath);
  const japaneseRows = story.content?.filter(unit => String(unit.TextJp ?? "").trim()).length ?? 0;
  if (!japaneseRows) throw new Error(`Exported story ${chapter.storyId} does not contain Japanese text`);
  updateBatch(batchPath, { storyId: chapter.storyId, status: "queued", japaneseRows });
}

async function main() {
  const batchId = process.argv[2];
  if (!batchId) throw new Error("Usage: series-cover-runner.mjs <batch-id>");
  const directory = path.join(localFilesRoot, "create-story", "_cover-batches", batchId);
  const batchPath = path.join(directory, "batch.json");
  const input = readJson(path.join(directory, "input.json"));
  const params = readJson(path.join(directory, "params.json"), {});
  for (const chapter of input.chapters) {
    try {
      exportJapaneseStory(chapter, params, batchPath);
    } catch (error) {
      updateBatch(batchPath, { storyId: chapter.storyId, status: "failed", error: error.message });
      throw error;
    }
  }
  const result = await generateSeriesCovers(input, {
    ...params,
    resultJson: path.join(directory, "result.json"),
  }, {
    onProgress(progress, currentResult) {
      updateBatch(batchPath, progress, currentResult);
    },
  });
  const batch = readJson(batchPath);
  writeJsonAtomic(batchPath, { ...batch, plan: result.plan, resultPath: path.join(directory, "result.json") });
  if (result.status === "failed") process.exitCode = 2;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
}
