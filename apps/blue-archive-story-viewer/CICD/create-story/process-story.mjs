import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import url from "url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..", "..");
const flatStoryTypes = new Set(["main", "other"]);
const nestedStoryTypes = new Set(["favor", "event", "group", "mini"]);

function printUsage() {
  console.log(`Usage:
  node ./CICD/create-story/process-story.mjs <story-id> [options]

Options:
  --type <type>          story type, default: group
  --schema <file>        raw ScenarioScriptDBSchema.json or group extraction
  --refresh-ba-l10n      refresh cached supplemental translations
  --no-ba-l10n           import without ba-l10n translation supplementation
  --require-ba-l10n      compatibility flag; ba-l10n is required by default
  --ba-l10n-input <file> use a local ba-l10n story JSON
  --ba-l10n-base-url <url>
                         override the ba-l10n service base URL
  --force, -f            overwrite and reprocess
  --changed-only         regenerate and publish only changed voice texts
  --limit <n>            limit LLM text units and TTS voice lines
  --help, -h             show this help

Examples:
  pnpm process-story 1102
  pnpm process-story 1102 --changed-only
  pnpm process-story 1102 --schema /tmp/scenario-1102-db.json --force

Prerequisite:
  ScenarioScriptDBSchema.json must already exist. This command starts at the
  importer and never downloads or updates the raw Table data.
`);
}

function resolveStoryPath(storyId, type) {
  if (flatStoryTypes.has(type)) {
    return path.join(appRoot, "public", "story", type, `${storyId}.json`);
  }

  if (nestedStoryTypes.has(type)) {
    const directoryId = String(storyId).slice(0, 5);
    return path.join(appRoot, "public", "story", type, directoryId, `${storyId}.json`);
  }

  throw new Error(`Unsupported story type: ${type}`);
}

function runStep(scriptName, args) {
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, scriptName), ...args],
    { stdio: "inherit" },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const reason = result.signal ? `signal ${result.signal}` : `exit code ${result.status}`;
    throw new Error(`${scriptName} failed with ${reason}`);
  }
}

function main() {
  const argv = process.argv.slice(2);
  let source = "";
  let type = "group";
  let force = false;
  let changedOnly = false;
  let limit = "";
  let schema = "";
  const importerArgs = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      printUsage();
      return;
    } else if (arg === "--type") {
      type = argv[++i];
    } else if (arg === "--schema") {
      schema = argv[++i];
    } else if (
      arg === "--refresh-ba-l10n" ||
      arg === "--no-ba-l10n" ||
      arg === "--require-ba-l10n"
    ) {
      importerArgs.push(arg);
    } else if (
      arg === "--ba-l10n-input" ||
      arg === "--ba-l10n-base-url" ||
      arg === "--ba-l10n-source-kind"
    ) {
      importerArgs.push(arg, argv[++i]);
    } else if (arg === "--force" || arg === "-f") {
      force = true;
    } else if (arg === "--changed-only") {
      changedOnly = true;
    } else if (arg === "--limit") {
      limit = argv[++i];
    } else if (!arg.startsWith("-")) {
      source = arg;
    }
  }

  if (!source) {
    printUsage();
    process.exit(1);
  }

  if (!/^\d+$/u.test(source)) {
    throw new Error("story-id must be a numeric GroupId");
  }
  const storyId = source;
  const storyPath = resolveStoryPath(storyId, type);

  console.log(`\n=== Step 1: Import raw story for ${storyId} ===`);
  if (!force && fs.existsSync(storyPath)) {
    console.log(`Story already exists; skipping import: ${storyPath}`);
  } else {
    const importArgs = [source, "--type", type, ...importerArgs];
    if (schema) importArgs.push("--schema", schema);
    if (force) importArgs.push("--force");
    runStep("import-ba-raw-story.mjs", importArgs);
  }

  console.log(`\n=== Step 2: Enrich story with LLM for ${storyId} ===`);
  const enrichArgs = [storyId, "--type", type];
  if (force) enrichArgs.push("--force");
  if (limit) {
    enrichArgs.push("--limit", limit);
  }
  runStep("enrich-story-with-llm.mjs", enrichArgs);

  console.log(`\n=== Step 3: Generate ZeroTTS voices for ${storyId} ===`);
  const voiceArgs = [
    storyId,
    "--type",
    type,
    "--stage",
    "all",
    "--download-missing",
  ];
  if (force) voiceArgs.push("--force");
  if (changedOnly) voiceArgs.push("--changed-only");
  if (limit) {
    voiceArgs.push("--limit", limit);
  }
  runStep("voice-zero-tts.mjs", voiceArgs);

  console.log(`\n=== Step 4: Publish voices to R2 for ${storyId} ===`);
  runStep("publish-voice-r2.mjs", [storyId, "--type", type]);

  console.log(`\n=== Finished processing story ${storyId} ===`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
