import fs from "fs";
import path from "path";
import url from "url";

import { applyStoryTextJpVoiceOverrides } from "./shared-config.mjs";
import {
  loadBaL10nStory,
  supplementMissingTranslations,
} from "./ba-l10n-translations.mjs";
import {
  fillMissingTextCnFromTextTw,
  markOpenCcTranslationSource,
  normalizeExistingTextCnCharacterNames,
} from "./fill-text-cn-from-tw.mjs";
import { loadTraditionalToSimplifiedCharacterNameMap } from "./ba-character-catalog.mjs";
import { proofreadStoryTextCnWithLlm } from "./proofread-text-cn-with-llm.mjs";

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
const defaultBaL10nSourceKind =
  process.env.BA_L10N_SOURCE_KIND || "normal";
const defaultCnProofreadModel =
  process.env.CN_PROOFREAD_MODEL || "gemini-3.1-pro-preview";
const defaultCnProofreadThinkingLevel =
  process.env.CN_PROOFREAD_THINKING_LEVEL || "MEDIUM";
const defaultCnProofreadPasses = Number(
  process.env.CN_PROOFREAD_PASSES || "2",
);
const defaultBaL10nCacheRoot = path.join(
  appRoot,
  ".local-files",
  "ba-l10n",
  "story",
);
const supportedFlatStoryTypes = new Set(["main", "other"]);
const supportedNestedStoryTypes = new Set(["favor", "event", "group", "mini"]);
const standardRawFields = new Set([
  "GroupId",
  "SelectionGroup",
  "BGMId",
  "Sound",
  "Transition",
  "BGName",
  "BGEffect",
  "PopupFileName",
  "ScriptKr",
  "TextJp",
  "TextCn",
  "TextTh",
  "TextTw",
  "TextEn",
  "VoiceJp",
  "TextJpVoice",
]);
const extractionOnlyFields = new Set([
  "rowid",
  "payload_size",
  "payload_sha256",
]);
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
  node ./CICD/create-story/import-ba-raw-story.mjs <story-id> [options]

Options:
  --schema <file>        ScenarioScriptDBSchema.json or a group extraction
                         default: BA_SCENARIO_SCHEMA_PATH or ${defaultSchemaPath}
  --type <type>          output story type, default: main
  --out-id <id>          output story id, default: source story id
  --directory-id <id>    required for nested output types: favor/event/group/mini
  --output <file>        write to an explicit output json path
  --ba-l10n-input <file> use a local ba-l10n story JSON instead of fetching
  --ba-l10n-base-url <url>
                         default: BA_L10N_BASE_URL or ${defaultBaL10nBaseUrl}
  --ba-l10n-source-kind <kind>
                         default: BA_L10N_SOURCE_KIND or ${defaultBaL10nSourceKind}
  --refresh-ba-l10n      refresh the local ba-l10n translation cache
  --no-ba-l10n           do not supplement missing translation fields
  --require-ba-l10n      compatibility flag; ba-l10n is required by default
  --no-cn-llm-proofread  skip the final Simplified Chinese LLM review
  --cn-proofread-model <model>
                         default: CN_PROOFREAD_MODEL or ${defaultCnProofreadModel}
  --cn-proofread-thinking-level <level>
                         default: CN_PROOFREAD_THINKING_LEVEL or ${defaultCnProofreadThinkingLevel.toLowerCase()}
  --cn-proofread-passes <n>
                         independent review passes, default: ${defaultCnProofreadPasses}
  --cn-proofread-project <project>
                         Vertex project id, defaults to environment
  --cn-proofread-location <location>
                         Vertex location, defaults to environment or us-central1
  --refresh-cn-proofread ignore cached Simplified Chinese review responses
  --force, -f            overwrite an existing output
  --dry-run              validate and print summary without writing
  --help, -h             show this help

Examples:
  node ./CICD/create-story/import-ba-raw-story.mjs 1103 --type group --dry-run
  node ./CICD/create-story/import-ba-raw-story.mjs 1103 --type group --force
  node ./CICD/create-story/import-ba-raw-story.mjs 1103 \\
    --schema /tmp/scenario-1103-db.json --type group --dry-run

The raw database export is the sole source of story rows and stage directions.
Missing language fields are supplemented from ba-l10n without overwriting
official non-empty text. Existing viewer JSON is never read or merged.
`);
}

function readOptionValue(argv, index, optionName) {
  const value = argv[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

function positiveInteger(value, optionName) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${optionName} must be a positive integer`);
  }
  return parsed;
}

function parseArgs(argv) {
  const args = {
    storyId: "",
    schema: defaultSchemaPath,
    type: "main",
    outId: "",
    directoryId: "",
    output: "",
    baL10nInput: "",
    baL10nBaseUrl: defaultBaL10nBaseUrl,
    baL10nSourceKind: defaultBaL10nSourceKind,
    refreshBaL10n: false,
    useBaL10n: process.env.BA_L10N_DISABLE !== "1",
    requireBaL10n: true,
    useCnLlmProofread: process.env.CN_PROOFREAD_DISABLE !== "1",
    cnProofreadModel: defaultCnProofreadModel,
    cnProofreadThinkingLevel: defaultCnProofreadThinkingLevel,
    cnProofreadPasses: defaultCnProofreadPasses,
    cnProofreadProject: "",
    cnProofreadLocation: "",
    refreshCnProofread: false,
    force: false,
    dryRun: false,
    help: false,
  };
  const positional = [];

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    switch (arg) {
      case "--schema":
      case "--input":
        args.schema = readOptionValue(argv, ++index, arg);
        break;
      case "--type":
        args.type = readOptionValue(argv, ++index, arg);
        break;
      case "--out-id":
        args.outId = readOptionValue(argv, ++index, arg);
        break;
      case "--directory-id":
        args.directoryId = readOptionValue(argv, ++index, arg);
        break;
      case "--output":
        args.output = readOptionValue(argv, ++index, arg);
        break;
      case "--ba-l10n-input":
        args.baL10nInput = readOptionValue(argv, ++index, arg);
        break;
      case "--ba-l10n-base-url":
        args.baL10nBaseUrl = readOptionValue(argv, ++index, arg);
        break;
      case "--ba-l10n-source-kind":
        args.baL10nSourceKind = readOptionValue(argv, ++index, arg);
        break;
      case "--refresh-ba-l10n":
        args.refreshBaL10n = true;
        break;
      case "--no-ba-l10n":
        args.useBaL10n = false;
        break;
      case "--require-ba-l10n":
        args.requireBaL10n = true;
        break;
      case "--no-cn-llm-proofread":
        args.useCnLlmProofread = false;
        break;
      case "--cn-proofread-model":
        args.cnProofreadModel = readOptionValue(argv, ++index, arg);
        break;
      case "--cn-proofread-thinking-level":
        args.cnProofreadThinkingLevel = readOptionValue(argv, ++index, arg);
        break;
      case "--cn-proofread-passes":
        args.cnProofreadPasses = positiveInteger(
          readOptionValue(argv, ++index, arg),
          arg,
        );
        break;
      case "--cn-proofread-project":
        args.cnProofreadProject = readOptionValue(argv, ++index, arg);
        break;
      case "--cn-proofread-location":
        args.cnProofreadLocation = readOptionValue(argv, ++index, arg);
        break;
      case "--refresh-cn-proofread":
        args.refreshCnProofread = true;
        break;
      case "--force":
      case "-f":
        args.force = true;
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

  args.storyId = positional[0] ?? "";
  if (positional.length > 1) {
    throw new Error(
      `Unexpected positional arguments: ${positional.slice(1).join(" ")}`,
    );
  }
  return args;
}

function buildDefaultOutputPath(args, outId) {
  if (supportedFlatStoryTypes.has(args.type)) {
    return path.join(appRoot, "public", "story", args.type, `${outId}.json`);
  }

  if (supportedNestedStoryTypes.has(args.type)) {
    const directoryId = args.directoryId || String(outId).slice(0, 5);
    return path.join(
      appRoot,
      "public",
      "story",
      args.type,
      directoryId,
      `${outId}.json`,
    );
  }

  throw new Error(
    `Unsupported output type: ${args.type}. Expected one of: ${[
      ...supportedFlatStoryTypes,
      ...supportedNestedStoryTypes,
    ].join(", ")}`,
  );
}

function resolveInputPath(inputPath) {
  return path.resolve(process.cwd(), inputPath);
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${label} ${filePath}: ${error.message}`);
  }
}

function decodeRawRows(source, storyId) {
  const numericStoryId = Number(storyId);
  const matchesStoryId = value =>
    String(value) === storyId || Number(value) === numericStoryId;
  let candidates;

  if (Array.isArray(source)) {
    const wrapperRows = source.filter(
      row =>
        row &&
        typeof row === "object" &&
        Object.hasOwn(row, "Bytes") &&
        matchesStoryId(row.GroupId),
    );
    candidates =
      wrapperRows.length > 0
        ? wrapperRows.map(row => row.Bytes)
        : source.filter(
          row =>
            row &&
              typeof row === "object" &&
              matchesStoryId(row.GroupId),
        );
  } else if (source && Array.isArray(source.content)) {
    if (
      source.GroupId !== undefined &&
      !matchesStoryId(source.GroupId)
    ) {
      throw new Error(
        `Group extraction contains GroupId ${source.GroupId}, expected ${storyId}`,
      );
    }
    candidates = source.content.filter(
      row =>
        row &&
        typeof row === "object" &&
        (row.GroupId === undefined || matchesStoryId(row.GroupId)),
    );
  } else {
    throw new Error(
      "Raw source must be ScenarioScriptDBSchema.json or an object with content[]",
    );
  }

  if (candidates.length === 0) {
    throw new Error(`No raw rows found for GroupId ${storyId}`);
  }

  return candidates.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`Raw row ${index} is not an object`);
    }
    if (
      row.GroupId !== undefined &&
      !matchesStoryId(row.GroupId)
    ) {
      throw new Error(
        `Raw row ${index} contains GroupId ${row.GroupId}, expected ${storyId}`,
      );
    }
    return row;
  });
}

function asString(value) {
  return typeof value === "string" ? value : "";
}

function asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function convertDisplayText(value) {
  return asString(value).replace(/#n/gu, "\n");
}

function convertRawRow(rawRow, storyId) {
  const extras = {};
  for (const [key, value] of Object.entries(rawRow)) {
    if (!standardRawFields.has(key) && !extractionOnlyFields.has(key)) {
      extras[key] = value;
    }
  }

  const textJpVoice = asString(rawRow.TextJpVoice);
  return {
    GroupId: asNumber(rawRow.GroupId ?? storyId),
    SelectionGroup: asNumber(rawRow.SelectionGroup),
    BGMId: asNumber(rawRow.BGMId),
    Sound: asString(rawRow.Sound),
    Transition: asNumber(rawRow.Transition),
    BGName: asNumber(rawRow.BGName),
    BGEffect: asNumber(rawRow.BGEffect),
    PopupFileName: asString(rawRow.PopupFileName),
    ScriptKr: asString(rawRow.ScriptKr),
    TextJp: convertDisplayText(rawRow.TextJp),
    TextCn: convertDisplayText(rawRow.TextCn),
    TextTh: convertDisplayText(rawRow.TextTh),
    TextTw: convertDisplayText(rawRow.TextTw),
    TextEn: convertDisplayText(rawRow.TextEn),
    VoiceJp: "",
    ...(textJpVoice.trim() ? { TextJpVoice: textJpVoice } : {}),
    ...extras,
  };
}

function printSummary(summary) {
  console.log(`Raw source: ${summary.schemaPath}`);
  console.log(`GroupId: ${summary.storyId}`);
  console.log(`Raw rows: ${summary.rawRows}`);
  console.log(`Output: ${summary.outputPath}`);
  if (summary.baL10n) {
    console.log(`ba-l10n source: ${summary.baL10n.source}`);
    console.log(
      `ba-l10n matches: ${summary.baL10n.stats.matchedRows}/` +
      `${summary.baL10n.stats.textRows} text rows`,
    );
    console.log(
      `ba-l10n filled: ${Object.entries(summary.baL10n.stats.filled)
        .map(([field, count]) => `${field}=${count}`)
        .join(", ")}`,
    );
    if (summary.baL10n.stats.unmatchedRows.length > 0) {
      console.log(
        "ba-l10n unmatched viewer rows: " +
        summary.baL10n.stats.unmatchedRows
          .map(row => row.viewerIndex)
          .join(", "),
      );
    }
  } else {
    console.log("ba-l10n supplementation: disabled or unavailable");
  }
  console.log(
    `OpenCC tw2sp filled TextCn: ${summary.openCc.filled}; ` +
    `mapped character names: ${summary.openCc.mappedNameOccurrences} ` +
    `occurrences across ${summary.openCc.mappedNames} names; ` +
    "still missing on display-text rows without TextTw: " +
    `${summary.openCc.missingTextTwOnDisplayTextRows}`,
  );
  if (summary.cnProofread) {
    console.log(
      `Gemini TextCn review (${summary.cnProofread.model}, ` +
      `${summary.cnProofread.thinkingLevel.toLowerCase()} thinking): ` +
      `${summary.cnProofread.netChanges.length} net changes across ` +
      `${summary.cnProofread.textUnits} rows; ` +
      `${summary.cnProofread.passes} passes; ` +
      `${summary.cnProofread.cacheHits}/${summary.cnProofread.batches} cached batches`,
    );
  } else if (summary.cnProofreadSkipped) {
    console.log(`Gemini TextCn review: skipped (${summary.cnProofreadSkipped})`);
  }
}

async function supplementFromBaL10n(args, content) {
  if (!args.useBaL10n) {
    return undefined;
  }

  const cachePath = path.join(
    defaultBaL10nCacheRoot,
    args.baL10nSourceKind,
    `${args.storyId}.json`,
  );
  const inputPath = args.baL10nInput
    ? resolveInputPath(args.baL10nInput)
    : "";
  try {
    const source = await loadBaL10nStory({
      storyId: args.storyId,
      sourceKind: args.baL10nSourceKind,
      baseUrl: args.baL10nBaseUrl,
      cachePath,
      inputPath,
      refresh: args.refreshBaL10n,
    });
    return {
      ...source,
      stats: supplementMissingTranslations(content, source.rows),
    };
  } catch (error) {
    if (args.requireBaL10n) {
      throw error;
    }
    console.warn(`Warning: ba-l10n supplementation failed: ${error.message}`);
    return undefined;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  if (!/^\d+$/u.test(args.storyId)) {
    throw new Error("story-id must be a numeric GroupId");
  }

  const outId = args.outId || args.storyId;
  const defaultOutputPath = buildDefaultOutputPath(args, outId);
  const outputPath = args.output
    ? resolveInputPath(args.output)
    : defaultOutputPath;
  if (fs.existsSync(outputPath) && !args.force && !args.dryRun) {
    throw new Error(
      `Output already exists: ${outputPath}. Pass --force to overwrite.`,
    );
  }
  const schemaPath = resolveInputPath(args.schema);
  const source = readJson(schemaPath, "raw scenario schema");
  const rawSourceRows = decodeRawRows(source, args.storyId);
  const content = rawSourceRows.map(row =>
    convertRawRow(row, args.storyId),
  );
  const baL10n = await supplementFromBaL10n(args, content);
  const characterNameMappings =
    await loadTraditionalToSimplifiedCharacterNameMap();
  const openCc = fillMissingTextCnFromTextTw(
    content,
    characterNameMappings,
  );
  const normalizedCharacterNames = normalizeExistingTextCnCharacterNames(
    content,
    characterNameMappings,
  );

  applyStoryTextJpVoiceOverrides(args.storyId, content);
  const rawSourceName = content.some(
    row => row.TextTw || row.TextEn || row.TextTh,
  )
    ? "Blue Archive Global"
    : "Blue Archive JP";
  const supplementedFieldCount = baL10n
    ? Object.values(baL10n.stats.filled)
      .reduce((total, count) => total + count, 0)
    : 0;
  const sourceName = supplementedFieldCount > 0
    ? `${rawSourceName} + ba-l10n.cnfast.top`
    : rawSourceName;
  const story = {
    proofreader: "",
    GroupId: Number(args.storyId),
    translator: sourceName,
    content,
  };
  markOpenCcTranslationSource(story, openCc);
  let cnProofread;
  let cnProofreadSkipped = "";
  if (args.dryRun) {
    cnProofreadSkipped = "dry run";
  } else if (!args.useCnLlmProofread) {
    cnProofreadSkipped = "disabled by --no-cn-llm-proofread";
  } else {
    cnProofread = await proofreadStoryTextCnWithLlm(story, {
      model: args.cnProofreadModel,
      thinkingLevel: args.cnProofreadThinkingLevel,
      passes: args.cnProofreadPasses,
      project: args.cnProofreadProject,
      location: args.cnProofreadLocation,
      refreshCache: args.refreshCnProofread,
      characterNameMappings,
    });
  }
  const summary = {
    storyId: args.storyId,
    schemaPath,
    rawRows: content.length,
    outputPath,
    baL10n,
    openCc,
    normalizedCharacterNames,
    cnProofread,
    cnProofreadSkipped,
  };
  printSummary(summary);

  if (args.dryRun) {
    console.log("Dry run complete; no file written.");
    return;
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(story, null, 2)}\n`);
  console.log(`Wrote ${content.length} rows.`);
}

try {
  await main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
