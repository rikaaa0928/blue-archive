import fs from "fs";
import path from "path";
import url from "url";

import { findEventStories } from "./find-event-story.mjs";
import { loadTraditionalToSimplifiedCharacterNameMap } from "./ba-character-catalog.mjs";
import { normalizeTextCnCharacterNames } from "./fill-text-cn-from-tw.mjs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..", "..");
const repoRoot = path.resolve(appRoot, "..", "..");

loadEnvFile(path.join(appRoot, ".env"));
loadEnvFile(path.join(repoRoot, ".env"));

const defaultSchemaPath =
  process.env.BA_SCENARIO_SCHEMA_PATH ||
  "/Volumes/storage/ba-asset-data-global/extracted/Table/ExcelDB/ScenarioScriptDBSchema.json";
const defaultBaL10nBaseUrl =
  process.env.BA_L10N_BASE_URL || "https://ba-l10n.cnfast.top";
const defaultOutputPath = path.join(
  appRoot,
  "src",
  "index",
  "eventStoryIndex.generated.json",
);
const defaultCacheRoot = path.join(
  appRoot,
  ".local-files",
  "ba-l10n",
  "index",
  "event",
);
const supportedPlaces = new Set(["shanhaijing", "millennium", "trinity"]);

const baL10nFiles = {
  manifest: "/data/common/index_scenario_manifest_event.json",
  groupKeys: "/data/common/index_scenario_i18n_event.json",
  keyHashes: "/data/story/i18n/i18n_event_index.json",
  strings: "/data/story/i18n/i18n_story.json",
};

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) {
    return;
  }

  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(trimmed);
    if (!match) {
      continue;
    }
    const key = match[1];
    let value = match[2].trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function printUsage() {
  console.log(`Usage:
  pnpm generate-event-story-index <event-id|group-id> --place <place> [options]

Options:
  --place <place>        frontend group: shanhaijing, millennium, or trinity
  --schema <file>        ScenarioScriptDBSchema.json; related tables are read
                         from the same directory
  --table-dir <dir>      extracted ExcelDB table directory
  --output <file>        generated index JSON
  --ba-l10n-base-url <url>
                         default: BA_L10N_BASE_URL or ${defaultBaL10nBaseUrl}
  --refresh-ba-l10n      refresh all cached event index localization files
  --include-missing      include sections whose story JSON is not imported yet
  --dry-run              print the generated entry without writing
  --help, -h             show this help

By default only locally imported event story JSON files are included, so every
generated frontend link is playable. Re-run this command after importing more
chapters to update the event entry.

Examples:
  pnpm generate-event-story-index 10014005 --place trinity
  pnpm generate-event-story-index 816 --place trinity --refresh-ba-l10n
`);
}

function readOptionValue(argv, index, optionName) {
  const value = argv[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

function parseArgs(argv) {
  const args = {
    query: "",
    place: "",
    schema: defaultSchemaPath,
    tableDir: "",
    output: defaultOutputPath,
    baL10nBaseUrl: defaultBaL10nBaseUrl,
    refreshBaL10n: false,
    includeMissing: false,
    dryRun: false,
    help: false,
  };
  const positional = [];

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    switch (arg) {
      case "--place":
        args.place = readOptionValue(argv, ++index, arg).toLowerCase();
        break;
      case "--schema":
        args.schema = readOptionValue(argv, ++index, arg);
        break;
      case "--table-dir":
        args.tableDir = readOptionValue(argv, ++index, arg);
        break;
      case "--output":
        args.output = readOptionValue(argv, ++index, arg);
        break;
      case "--ba-l10n-base-url":
        args.baL10nBaseUrl = readOptionValue(argv, ++index, arg);
        break;
      case "--refresh-ba-l10n":
        args.refreshBaL10n = true;
        break;
      case "--include-missing":
        args.includeMissing = true;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        if (arg.startsWith("-")) {
          throw new Error(`Unknown option: ${arg}`);
        }
        positional.push(arg);
    }
  }

  if (positional.length > 1) {
    throw new Error("Only one event-id or group-id may be provided");
  }
  args.query = positional[0] ?? "";
  return args;
}

function resolvePath(inputPath) {
  return path.isAbsolute(inputPath)
    ? inputPath
    : path.resolve(process.cwd(), inputPath);
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

async function loadCachedJson({
  label,
  relativeUrl,
  baseUrl,
  cachePath,
  refresh,
}) {
  if (!refresh && fs.existsSync(cachePath)) {
    return JSON.parse(fs.readFileSync(cachePath, "utf8"));
  }

  const sourceUrl = `${baseUrl.replace(/\/+$/u, "")}${relativeUrl}`;
  const response = await fetch(sourceUrl, {
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(
      `GET ${sourceUrl} failed: ${response.status} ${response.statusText}`,
    );
  }
  const data = JSON.parse(await response.text());
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const temporaryPath = `${cachePath}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(data, null, 2)}\n`);
    fs.renameSync(temporaryPath, cachePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
  console.log(`Refreshed ${label}: ${sourceUrl}`);
  return data;
}

function chooseEvent(results, query) {
  const numericQuery = /^\d+$/u.test(query) ? Number(query) : null;
  return (
    results.find(event => event.eventId === numericQuery) ||
    results.find(
      event =>
        !event.isReturn && event.eventId === event.originalEventId,
    ) ||
    results[0]
  );
}

function cleanText(value) {
  const text = String(value ?? "").replace(/\r\n?/gu, "\n").trim();
  return /^\[[^\]]+not found\]$/iu.test(text) ? "" : text;
}

function makeTextObject(messages, fallbackJp = "", characterNameMappings) {
  const text = {
    TextJp: cleanText(messages?.j_ja || messages?.g_ja || fallbackJp),
    TextCn: cleanText(messages?.g_tw_cn || messages?.c_cn),
    TextKr: cleanText(messages?.j_ko || messages?.g_ko),
    TextTh: cleanText(messages?.g_th),
    TextEn: cleanText(messages?.g_en),
    TextTw: cleanText(messages?.g_tw),
  };
  if (!text.TextJp) {
    text.TextJp = fallbackJp;
  }
  text.TextCn = normalizeTextCnCharacterNames(
    text.TextCn,
    text.TextTw,
    characterNameMappings,
  );
  return text;
}

function localizeKey(key, keyHashes, strings) {
  const hash = keyHashes[key];
  return hash === undefined ? undefined : strings[String(hash)];
}

function eventStoryPath(groupId) {
  const id = String(groupId);
  return path.join(
    appRoot,
    "public",
    "story",
    "event",
    id.slice(0, 5),
    `${id}.json`,
  );
}

function createEventEntry({
  event,
  manifestEntry,
  groupKeys,
  keyHashes,
  strings,
  place,
  includeMissing,
  characterNameMappings,
}) {
  const allGroupIds = event.scenarioGroupIds;
  const manifestGroupIds = (manifestEntry?.data ?? []).map(Number);
  const orderedGroupIds = manifestGroupIds.length
    ? manifestGroupIds.filter(groupId => allGroupIds.includes(groupId))
    : allGroupIds;
  const missingGroupIds = orderedGroupIds.filter(
    groupId => !fs.existsSync(eventStoryPath(groupId)),
  );
  const includedGroupIds = includeMissing
    ? orderedGroupIds
    : orderedGroupIds.filter(groupId =>
      fs.existsSync(eventStoryPath(groupId)),
    );
  if (includedGroupIds.length === 0) {
    throw new Error(
      "No imported event story JSON was found. Import at least one chapter " +
      "or pass --include-missing.",
    );
  }

  const eventNameKey =
    manifestEntry?.name || `[STORY_EVENT_${event.originalEventId}_NAME]`;
  const eventDescriptionKey =
    manifestEntry?.desc || `[STORY_EVENT_${event.originalEventId}_DESC]`;
  const sections = includedGroupIds.map((groupId, index) => {
    const [titleKey, descriptionKey] = groupKeys[String(groupId)] ?? [];
    const section = {
      title: makeTextObject(
        localizeKey(titleKey, keyHashes, strings),
        `第${index + 1}話`,
        characterNameMappings,
      ),
      story_id: groupId,
      abstract: makeTextObject(
        localizeKey(descriptionKey, keyHashes, strings),
        "",
        characterNameMappings,
      ),
    };
    if (index > 0) {
      section.previous = includedGroupIds[index - 1];
    }
    if (index < includedGroupIds.length - 1) {
      section.next = includedGroupIds[index + 1];
    }
    return section;
  });

  return {
    entry: {
      event_id: event.originalEventId,
      place,
      title: makeTextObject(
        localizeKey(eventNameKey, keyHashes, strings),
        event.nameJp || event.nameKey,
        characterNameMappings,
      ),
      abstract: makeTextObject(
        localizeKey(eventDescriptionKey, keyHashes, strings),
        "",
        characterNameMappings,
      ),
      sections,
    },
    allGroupIds: orderedGroupIds,
    missingGroupIds,
  };
}

function writeGeneratedIndex(outputPath, entry) {
  const current = readJson(outputPath, []);
  if (!Array.isArray(current)) {
    throw new Error(`Generated index must be an array: ${outputPath}`);
  }
  const next = current.filter(item => item.event_id !== entry.event_id);
  next.push(entry);
  next.sort((left, right) => left.event_id - right.event_id);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`);
    fs.renameSync(temporaryPath, outputPath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  if (!args.query) {
    printUsage();
    process.exitCode = 1;
    return;
  }
  if (!supportedPlaces.has(args.place)) {
    throw new Error(
      `--place must be one of: ${[...supportedPlaces].join(", ")}`,
    );
  }

  const results = findEventStories({
    query: args.query,
    schema: args.schema,
    tableDir: args.tableDir,
  });
  const event = chooseEvent(results, args.query);
  const cacheFiles = {
    manifest: path.join(defaultCacheRoot, "manifest.json"),
    groupKeys: path.join(defaultCacheRoot, "group-keys.json"),
    keyHashes: path.join(defaultCacheRoot, "key-hashes.json"),
    strings: path.join(defaultCacheRoot, "strings.json"),
  };
  const loadedEntries = await Promise.all(
    Object.entries(baL10nFiles).map(async ([label, relativeUrl]) => [
      label,
      await loadCachedJson({
        label,
        relativeUrl,
        baseUrl: args.baL10nBaseUrl,
        cachePath: cacheFiles[label],
        refresh: args.refreshBaL10n,
      }),
    ]),
  );
  const { manifest, groupKeys, keyHashes, strings } =
    Object.fromEntries(loadedEntries);
  const manifestEntry = manifest.find(
    item => Number(item.id) === event.originalEventId,
  );
  if (!manifestEntry) {
    throw new Error(
      `Event ${event.originalEventId} is missing from ba-l10n manifest`,
    );
  }
  const characterNameMappings =
    await loadTraditionalToSimplifiedCharacterNameMap();

  const finalized = createEventEntry({
    event,
    manifestEntry,
    groupKeys,
    keyHashes,
    strings,
    place: args.place,
    includeMissing: args.includeMissing,
    characterNameMappings,
  });
  const outputPath = resolvePath(args.output);

  console.log(`Event: ${event.nameJp} [${event.originalEventId}]`);
  console.log(`Place: ${args.place}`);
  console.log(
    `Sections: ${finalized.entry.sections.length}/` +
    `${finalized.allGroupIds.length} imported`,
  );
  if (finalized.missingGroupIds.length) {
    console.log(
      `Missing story JSON: ${finalized.missingGroupIds.join(" ")}`,
    );
  }
  console.log(`Output: ${outputPath}`);

  if (args.dryRun) {
    console.log(JSON.stringify(finalized.entry, null, 2));
    console.log("Dry run complete; no index written.");
    return;
  }
  writeGeneratedIndex(outputPath, finalized.entry);
  console.log("Event story index updated.");
}

try {
  await main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
