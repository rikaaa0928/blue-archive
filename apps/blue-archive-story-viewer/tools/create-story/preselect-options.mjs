import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveRecordingSelections } from "./recording-selections.mjs";
import { normalizeStoryPath } from "./story-path.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(__dirname, "../..");
const selectionsPath = path.join(__dirname, "recording-preselections.json");

function usage() {
  console.log(
    "Usage: node preselect-options.mjs <story> --selection=INDEX:GROUP [...]\n" +
      "       [--story-file=/path/to/assembled-story.json]\n" +
      "Examples:\n" +
      "  node preselect-options.mjs eventStory/10002005 " +
      "--selection=12:1 --selection=228:3 --selection=266:5",
  );
}

function parseArguments(arguments_) {
  let rawStoryPath;
  let showHelp = false;
  let storyFile = "";
  const explicitSelections = new Map();

  for (const argument of arguments_) {
    if (argument.startsWith("--selection=")) {
      const match = /^(\d+):(\d+)$/u.exec(argument.slice("--selection=".length));
      if (!match) throw new Error(`Invalid recording selection: ${argument}`);
      const storyIndex = Number(match[1]);
      if (explicitSelections.has(storyIndex)) {
        throw new Error(`Duplicate recording selection for story index ${storyIndex}`);
      }
      explicitSelections.set(storyIndex, Number(match[2]));
    } else if (argument.startsWith("--story-file=")) {
      storyFile = argument.slice("--story-file=".length);
      if (!storyFile) throw new Error("--story-file requires a JSON path");
    } else if (argument === "-h" || argument === "--help") {
      showHelp = true;
    } else if (argument.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}`);
    } else if (rawStoryPath) {
      throw new Error("Only one story path can be specified");
    } else {
      rawStoryPath = argument;
    }
  }

  return { rawStoryPath, explicitSelections, storyFile, showHelp };
}

async function readAllPreSelections() {
  const payload = fs.existsSync(selectionsPath)
    ? JSON.parse(fs.readFileSync(selectionsPath, "utf8"))
    : {};
  return new Map(Object.entries(payload));
}

function writeAllPreSelections(allSelections) {
  const payload = Object.fromEntries(
    [...allSelections].sort(([left], [right]) => left.localeCompare(right)),
  );
  const temporaryPath = `${selectionsPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, selectionsPath);
}

async function main() {
  const { rawStoryPath, explicitSelections, storyFile, showHelp } = parseArguments(
    process.argv.slice(2),
  );
  if (showHelp) {
    usage();
    return;
  }
  if (!rawStoryPath) {
    usage();
    process.exitCode = 1;
    return;
  }

  const { storyPath, type, directoryId, id } =
    normalizeStoryPath(rawStoryPath);
  const storyJsonPath = storyFile
    ? path.resolve(process.cwd(), storyFile)
    : directoryId
    ? path.join(
      projectDir,
      "public/story",
      type,
      directoryId,
      `${id}.json`,
    )
    : path.join(projectDir, "public/story", type, `${id}.json`);
  if (!fs.existsSync(storyJsonPath)) {
    throw new Error(`Story file not found: ${storyJsonPath}`);
  }

  const storyJson = JSON.parse(fs.readFileSync(storyJsonPath, "utf8"));
  const requestedSelections = [...explicitSelections].map(([storyIndex, selectionGroup]) => ({
    storyIndex,
    selectionGroup,
  }));
  const selected = resolveRecordingSelections(storyJson.content || [], requestedSelections);
  const allSelections = await readAllPreSelections();
  const previous = allSelections.get(storyPath);
  if (JSON.stringify(previous) === JSON.stringify(selected)) {
    console.log(`\nPre-selections for ${storyPath} are already up to date.`);
    return;
  }

  allSelections.set(storyPath, selected);
  writeAllPreSelections(allSelections);
  console.log(
    `\nSaved ${selected.length} pre-selection(s) for ${storyPath} to ` +
      "recording-preselections.json. Single-option pages were filled deterministically.",
  );
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
