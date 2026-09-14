import fs from "node:fs";
import path from "node:path";
import url from "node:url";

import {
  loadMainStoryEpisodes,
  mainStorySeriesKey,
} from "./main-story-modes.mjs";

const currentDirectory = path.dirname(url.fileURLToPath(import.meta.url));
const appRoot = path.resolve(currentDirectory, "..", "..");
const defaultScenarioScriptPath = process.env.BA_SCENARIO_SCHEMA_PATH ||
  "/Volumes/storage/ba-asset-data-global/extracted/Table/ExcelDB/ScenarioScriptDBSchema.json";
const defaultOutputPath = path.join(appRoot, "src", "index", "mainStoryIndex.generated.json");
const languageFields = ["TextJp", "TextCn", "TextTw", "TextKr", "TextEn", "TextTh"];

function clean(value) {
  return String(value ?? "").trim();
}

function chapterPart(value) {
  const parts = clean(value).split(";").map(clean).filter(Boolean);
  return parts.at(-1) ?? "";
}

export function extractGeneratedMainStoryTitle(story, episode) {
  const titleRow = story?.content?.find(unit =>
    /(?:^|\n)#title(?:;|$)/u.test(String(unit?.ScriptKr ?? "")));
  const scriptTitle = String(titleRow?.ScriptKr ?? "").split("\n")
    .find(line => line.startsWith("#title"));
  const title = Object.fromEntries(languageFields.map(field => [
    field,
    field === "TextKr"
      ? chapterPart(String(scriptTitle ?? "").replace(/^#title;?/u, ""))
      : chapterPart(titleRow?.[field]),
  ]).filter(([, value]) => value));
  if (!title.TextJp) {
    title.TextJp = episode.modeType === "Prologue"
      ? `プロローグ ${episode.episodeId}`
      : `第${episode.episodeId}話`;
  }
  if (!title.TextCn) {
    title.TextCn = episode.modeType === "Prologue"
      ? `序章 ${episode.episodeId}`
      : `第 ${episode.episodeId} 话`;
  }
  return title;
}

function seriesTitle(episode) {
  if (episode.modeType === "Prologue") {
    return { TextJp: "プロローグ", TextCn: "序章", TextEn: "Prologue" };
  }
  return {
    TextJp: `Vol.${episode.volumeId} 第${episode.chapterId}章`,
    TextCn: `Vol.${episode.volumeId} 第${episode.chapterId}章`,
    TextEn: `Vol.${episode.volumeId} Chapter ${episode.chapterId}`,
  };
}

export function buildGeneratedMainStoryIndex({ episodes, storyRoot }) {
  const groups = new Map();
  for (const episode of episodes) {
    const storyPath = path.join(storyRoot, `${episode.storyId}.json`);
    if (!fs.existsSync(storyPath)) continue;
    const story = JSON.parse(fs.readFileSync(storyPath, "utf8"));
    const key = mainStorySeriesKey(episode);
    if (!groups.has(key)) {
      groups.set(key, {
        _seriesKey: key,
        released: true,
        title: seriesTitle(episode),
        sections: [],
      });
    }
    groups.get(key).sections.push({
      title: extractGeneratedMainStoryTitle(story, episode),
      story_id: Number(episode.storyId),
      abstract: { TextJp: "" },
    });
  }
  for (const group of groups.values()) {
    group.sections.forEach((section, index, sections) => {
      if (index > 0) section.previous = sections[index - 1].story_id;
      if (index < sections.length - 1) section.next = sections[index + 1].story_id;
    });
  }
  return [...groups.values()];
}

export function updateGeneratedMainStoryIndex({
  scenarioScriptPath = defaultScenarioScriptPath,
  scenarioModePath = process.env.BA_SCENARIO_MODE_SCHEMA_PATH || "",
  storyRoot = path.join(appRoot, "public", "story", "main"),
  outputPath = defaultOutputPath,
} = {}) {
  const catalog = loadMainStoryEpisodes(scenarioScriptPath, scenarioModePath);
  if (!catalog.episodes.length) {
    throw new Error(`No main-story modes found in ${catalog.path}`);
  }
  const generated = buildGeneratedMainStoryIndex({ episodes: catalog.episodes, storyRoot });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(generated, null, 2)}\n`);
  fs.renameSync(temporaryPath, outputPath);
  return { outputPath, scenarioModePath: catalog.path, groups: generated.length,
    sections: generated.reduce((sum, group) => sum + group.sections.length, 0) };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--schema") args.scenarioScriptPath = path.resolve(argv[++index]);
    else if (arg === "--scenario-mode-schema") args.scenarioModePath = path.resolve(argv[++index]);
    else if (arg === "--output") args.outputPath = path.resolve(argv[++index]);
    else if (arg === "--story-root") args.storyRoot = path.resolve(argv[++index]);
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return args;
}

const directRun = process.argv[1] && path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url);
if (directRun) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(
        "Usage: node generate-main-story-index.mjs [--schema file] " +
        "[--scenario-mode-schema file] [--story-root dir] [--output file]",
      );
    } else {
      const result = updateGeneratedMainStoryIndex(args);
      console.log(`Wrote ${result.sections} main-story sections in ${result.groups} groups to ${result.outputPath}`);
    }
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}
