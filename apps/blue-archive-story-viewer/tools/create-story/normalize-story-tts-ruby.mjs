import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import {
  assertNoAmbiguousUnannotatedRuby,
  replaceRubySurfaceTextWithReadings,
  scanRubyMappings,
} from "./tts-text-normalization.mjs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..", "..");
const defaultStoryRoot = path.join(appRoot, "public", "story");
const collectiveConfigRoot = path.join(
  __dirname,
  "config",
  "collective-voices",
);

function printUsage() {
  console.log(`Usage:
  node ./tools/create-story/normalize-story-tts-ruby.mjs [options]

Options:
  --write          update changed story JSON files; default is dry-run
  --root <path>    story directory to scan, default: public/story
  --help, -h       show this help
`);
}

function parseArgs(argv) {
  const args = { write: false, root: defaultStoryRoot, help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--write") {
      args.write = true;
    } else if (arg === "--root") {
      const value = argv[++index];
      if (!value) throw new Error("Missing value for --root");
      args.root = path.resolve(process.cwd(), value);
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function collectJsonFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectJsonFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(entryPath);
    }
  }
  return files;
}

function isPathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function normalizeStory(story, rubyMappings) {
  if (!story || !Array.isArray(story.content)) return [];
  const changes = [];
  for (let index = 0; index < story.content.length; index++) {
    const unit = story.content[index];
    if (typeof unit.TextJpVoice !== "string" || !unit.TextJpVoice) continue;
    const normalized = replaceRubySurfaceTextWithReadings(
      unit.TextJpVoice,
      rubyMappings,
    );
    if (normalized === unit.TextJpVoice) continue;
    changes.push({ index, before: unit.TextJpVoice, after: normalized });
    unit.TextJpVoice = normalized;
  }
  return changes;
}

function effectiveTtsText(unit) {
  return unit.TextJpVoice !== undefined && unit.TextJpVoice !== null
    ? String(unit.TextJpVoice).trim()
    : String(unit.TextJp ?? "").trim();
}

function collectiveScanDigest(story) {
  const rows = story.content.map(unit => [
    String(unit.ScriptKr ?? ""),
    effectiveTtsText(unit),
  ]);
  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify(rows))
    .digest("hex");
  return `sha256:${digest}`;
}

function prepareCollectiveConfigUpdate(plan) {
  if (!plan.syncCollectiveConfig) return null;
  const configPath = path.join(collectiveConfigRoot, plan.relativePath);
  if (!fs.existsSync(configPath)) return null;

  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const expectedStoryPath = `public/story/${plan.relativePath}`;
  if (config.source?.storyPath !== expectedStoryPath) {
    throw new Error(`Collective config storyPath mismatch: ${configPath}`);
  }
  if (config.source?.contentLength !== plan.story.content.length) {
    throw new Error(`Collective config contentLength mismatch: ${configPath}`);
  }
  if (config.source?.scanDigest !== plan.beforeDigest) {
    throw new Error(`Collective config scanDigest was already stale: ${configPath}`);
  }

  const changesByIndex = new Map(
    plan.changes.map(change => [change.index, change]),
  );
  let updatedExpectedLineCount = 0;
  for (const line of config.lines ?? []) {
    const unit = plan.story.content[line.storyIndex];
    if (!unit || line.expected?.scriptKr !== String(unit.ScriptKr ?? "")) {
      throw new Error(`Collective config ScriptKr mismatch: ${configPath}`);
    }
    const change = changesByIndex.get(line.storyIndex);
    const beforeTtsText = change
      ? String(change.before).trim()
      : effectiveTtsText(unit);
    if (line.expected?.ttsText !== beforeTtsText) {
      throw new Error(`Collective config ttsText mismatch: ${configPath}`);
    }
    if (change) {
      line.expected.ttsText = String(change.after).trim();
      updatedExpectedLineCount++;
    }
  }

  config.source.scanDigest = collectiveScanDigest(plan.story);
  return { config, configPath, updatedExpectedLineCount };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  if (!fs.existsSync(args.root)) {
    throw new Error(`Story root not found: ${args.root}`);
  }

  const files = collectJsonFiles(args.root).sort();
  const plans = [];
  let changedLines = 0;
  for (const file of files) {
    const story = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!story || !Array.isArray(story.content)) continue;
    const beforeDigest = collectiveScanDigest(story);
    const rubyScan = scanRubyMappings(
      story.content.map(unit => unit.TextJp),
    );
    assertNoAmbiguousUnannotatedRuby(
      rubyScan,
      path.relative(appRoot, file).split(path.sep).join("/"),
    );
    const changes = normalizeStory(story, rubyScan.mappings);
    if (changes.length === 0) continue;
    changedLines += changes.length;
    const syncCollectiveConfig = isPathInside(defaultStoryRoot, file);
    const relativePath = path
      .relative(syncCollectiveConfig ? defaultStoryRoot : args.root, file)
      .split(path.sep)
      .join("/");
    plans.push({
      file,
      story,
      beforeDigest,
      relativePath,
      syncCollectiveConfig,
      rubyScan,
      changes,
    });
  }

  const configUpdates = plans
    .map(prepareCollectiveConfigUpdate)
    .filter(Boolean);

  if (args.write) {
    for (const plan of plans) {
      fs.writeFileSync(plan.file, `${JSON.stringify(plan.story, null, 2)}\n`);
    }
    for (const update of configUpdates) {
      fs.writeFileSync(
        update.configPath,
        `${JSON.stringify(update.config, null, 2)}\n`,
      );
    }
  }

  const changedFiles = plans.map(plan => ({
    path: path.relative(appRoot, plan.file).split(path.sep).join("/"),
    rubyScan: plan.rubyScan,
    changes: plan.changes,
  }));

  console.log(JSON.stringify({
    mode: args.write ? "write" : "dry-run",
    scannedFiles: files.length,
    changedFileCount: changedFiles.length,
    changedLineCount: changedLines,
    updatedCollectiveConfigCount: configUpdates.length,
    updatedCollectiveExpectedLineCount: configUpdates.reduce(
      (total, update) => total + update.updatedExpectedLineCount,
      0,
    ),
    changedFiles,
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
