import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateRecordingSelections } from "./recording-selections.mjs";
import { normalizeStoryPath } from "./story-path.mjs";

const toolsDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(toolsDirectory, "../..");

function usage() {
  console.log("Usage: node validate-recording-selections.mjs <story> [--story-file=<json>]");
}

async function main() {
  const arguments_ = process.argv.slice(2);
  if (arguments_.includes("-h") || arguments_.includes("--help")) {
    usage();
    return;
  }
  const storyFileArgument = arguments_.find(argument => argument.startsWith("--story-file="));
  const positional = arguments_.filter(argument => !argument.startsWith("--story-file="));
  if (positional.length !== 1 || arguments_.some(argument =>
    argument.startsWith("-") && !argument.startsWith("--story-file="))) {
    usage();
    process.exitCode = 1;
    return;
  }

  const { storyPath, type, directoryId, id } = normalizeStoryPath(positional[0]);
  const storyJsonPath = storyFileArgument
    ? path.resolve(process.cwd(), storyFileArgument.slice("--story-file=".length))
    : directoryId
    ? path.join(projectDirectory, "public/story", type, directoryId, `${id}.json`)
    : path.join(projectDirectory, "public/story", type, `${id}.json`);
  if (!fs.existsSync(storyJsonPath)) throw new Error(`Story file not found: ${storyJsonPath}`);

  const story = JSON.parse(fs.readFileSync(storyJsonPath, "utf8"));
  const selectionsPath = path.join(toolsDirectory, "recording-preselections.json");
  const selectionsByStory = fs.existsSync(selectionsPath)
    ? JSON.parse(fs.readFileSync(selectionsPath, "utf8"))
    : {};
  const selections = selectionsByStory[storyPath] ?? [];
  validateRecordingSelections(story.content ?? [], selections);
  console.log(`Recording defaults are complete for ${storyPath} (${selections.length} selection pages).`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
