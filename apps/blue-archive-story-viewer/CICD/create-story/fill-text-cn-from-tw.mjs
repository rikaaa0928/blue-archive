import fs from "fs";
import path from "path";
import url from "url";

import OpenCC from "opencc-js";
import { loadTraditionalToSimplifiedCharacterNameMap } from "./ba-character-catalog.mjs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..", "..");
const supportedFlatStoryTypes = new Set(["main", "other"]);
const supportedNestedStoryTypes = new Set(["favor", "event", "group", "mini"]);
const convertTaiwanTraditionalToSimplified = OpenCC.Converter({
  from: "twp",
  to: "cn",
});

function printUsage() {
  console.log(`Usage:
  node ./CICD/create-story/fill-text-cn-from-tw.mjs <story-id> [options]
  node ./CICD/create-story/fill-text-cn-from-tw.mjs --input <story-json> [options]

Options:
  --type <type>          story type, default: main
  --directory-id <id>    nested directory; defaults to first 5 story-id digits
  --input <file>         process an explicit story JSON
  --output <file>        write to another file; defaults to the input file
  --refresh-existing     rebuild existing TextCn from TextTw using player names
  --dry-run              print the result without writing
  --help, -h             show this help

By default only empty TextCn fields with a non-empty TextTw source are filled.
--refresh-existing is an explicit migration mode for OpenCC-generated stories;
it rewrites TextCn from TextTw. Voice fields and other story data are unchanged.
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
    storyId: "",
    type: "main",
    directoryId: "",
    input: "",
    output: "",
    refreshExisting: false,
    dryRun: false,
    help: false,
  };
  const positional = [];

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    switch (arg) {
      case "--type":
        args.type = readOptionValue(argv, ++index, arg);
        break;
      case "--directory-id":
        args.directoryId = readOptionValue(argv, ++index, arg);
        break;
      case "--input":
        args.input = readOptionValue(argv, ++index, arg);
        break;
      case "--output":
        args.output = readOptionValue(argv, ++index, arg);
        break;
      case "--refresh-existing":
        args.refreshExisting = true;
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

function buildStoryPath(args) {
  if (args.input) {
    return path.resolve(process.cwd(), args.input);
  }
  if (!/^\d+$/u.test(args.storyId)) {
    throw new Error("story-id must be numeric when --input is not provided");
  }
  if (supportedFlatStoryTypes.has(args.type)) {
    return path.join(
      appRoot,
      "public",
      "story",
      args.type,
      `${args.storyId}.json`,
    );
  }
  if (supportedNestedStoryTypes.has(args.type)) {
    const directoryId = args.directoryId || args.storyId.slice(0, 5);
    return path.join(
      appRoot,
      "public",
      "story",
      args.type,
      directoryId,
      `${args.storyId}.json`,
    );
  }
  throw new Error(`Unsupported story type: ${args.type}`);
}

function readStory(storyPath) {
  let story;
  try {
    story = JSON.parse(fs.readFileSync(storyPath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read story JSON ${storyPath}: ${error.message}`);
  }
  if (!story || !Array.isArray(story.content)) {
    throw new Error(`Story JSON must contain content[]: ${storyPath}`);
  }
  return story;
}

function addTranslatorSource(story, sourceName) {
  const sources = String(story.translator ?? "")
    .split(/\s+\+\s+/u)
    .map(value => value.trim())
    .filter(Boolean);
  if (!sources.includes(sourceName)) {
    sources.push(sourceName);
  }
  story.translator = sources.join(" + ");
}

function replaceAllAndCount(value, search, replacement) {
  const parts = value.split(search);
  return {
    value: parts.join(replacement),
    count: parts.length - 1,
  };
}

function convertTextTwToTextCn(textTw, characterNameMappings) {
  const mappings = [...(characterNameMappings ?? new Map()).entries()]
    .filter(([traditional, simplified]) => traditional && simplified)
    .sort(([left], [right]) =>
      [...right].length - [...left].length || left.localeCompare(right),
    );
  let protectedText = textTw;
  let tokenPrefix = "\uE000BA_NAME_";
  while (protectedText.includes(tokenPrefix)) {
    tokenPrefix += "_";
  }
  const protectedNames = [];
  for (const [traditional, simplified] of mappings) {
    const token = `${tokenPrefix}${protectedNames.length}\uE001`;
    const replacement = replaceAllAndCount(
      protectedText,
      traditional,
      token,
    );
    if (replacement.count === 0) {
      continue;
    }
    protectedText = replacement.value;
    protectedNames.push({
      token,
      traditional,
      simplified,
      count: replacement.count,
    });
  }

  let converted = convertTaiwanTraditionalToSimplified(protectedText);
  for (const protectedName of protectedNames) {
    converted = converted
      .split(protectedName.token)
      .join(protectedName.simplified);
  }
  return {
    text: converted,
    mappedNameOccurrences: protectedNames.reduce(
      (total, item) => total + item.count,
      0,
    ),
    mappedNames: protectedNames.map(item => item.traditional),
  };
}

export function convertTextTwToTextCnWithMappedNames(
  textTw,
  characterNameMappings,
) {
  return convertTextTwToTextCn(textTw, characterNameMappings).text;
}

export function normalizeTextCnCharacterNames(
  textCn,
  textTw,
  characterNameMappings,
) {
  const mappings = [...(characterNameMappings ?? new Map()).entries()]
    .filter(([traditional, simplified]) =>
      traditional && simplified && String(textTw).includes(traditional),
    )
    .sort(([left], [right]) =>
      [...right].length - [...left].length || left.localeCompare(right),
    );
  let normalized = String(textCn ?? "");
  let tokenPrefix = "\uE000BA_CN_NAME_";
  while (normalized.includes(tokenPrefix)) tokenPrefix += "_";
  const protectedNames = [];
  for (const [traditional, simplified] of mappings) {
    const convertedTraditional = convertTaiwanTraditionalToSimplified(
      traditional,
    );
    const token = `${tokenPrefix}${protectedNames.length}\uE001`;
    let replaced = false;
    for (const source of new Set([traditional, convertedTraditional])) {
      if (!source || !normalized.includes(source)) continue;
      normalized = normalized.split(source).join(token);
      replaced = true;
    }
    if (replaced) protectedNames.push({ token, simplified });
  }
  for (const { token, simplified } of protectedNames) {
    normalized = normalized.split(token).join(simplified);
  }
  return normalized;
}

export function fillMissingTextCnFromTextTw(
  content,
  characterNameMappings = new Map(),
  options = {},
) {
  if (!Array.isArray(content)) {
    throw new Error("Story content must be an array");
  }

  const stats = {
    rows: content.length,
    emptyTextCn: 0,
    filled: 0,
    refreshedExisting: 0,
    missingTextTw: 0,
    missingTextTwOnDisplayTextRows: 0,
    mappedNameOccurrences: 0,
    mappedNames: 0,
  };
  const matchedNames = new Set();
  content.forEach(row => {
    if (!row || typeof row !== "object") {
      return;
    }
    const existingTextCn = String(row.TextCn ?? "");
    if (existingTextCn.trim() && !options.refreshExisting) return;
    if (!existingTextCn.trim()) stats.emptyTextCn++;
    const textTw = typeof row.TextTw === "string" ? row.TextTw : "";
    if (!textTw.trim()) {
      stats.missingTextTw++;
      const textJp = String(row.TextJp ?? "").trim();
      if (textJp && !textJp.startsWith("#")) {
        stats.missingTextTwOnDisplayTextRows++;
      }
      return;
    }
    const converted = convertTextTwToTextCn(
      textTw,
      characterNameMappings,
    );
    row.TextCn = converted.text;
    stats.mappedNameOccurrences += converted.mappedNameOccurrences;
    converted.mappedNames.forEach(name => matchedNames.add(name));
    if (existingTextCn.trim()) {
      if (existingTextCn !== converted.text) stats.refreshedExisting++;
    } else {
      stats.filled++;
    }
  });
  stats.mappedNames = matchedNames.size;
  return stats;
}

export function markOpenCcTranslationSource(story, stats) {
  if (stats.filled > 0) {
    addTranslatorSource(story, "OpenCC tw2sp");
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const inputPath = buildStoryPath(args);
  const outputPath = args.output
    ? path.resolve(process.cwd(), args.output)
    : inputPath;
  const story = readStory(inputPath);
  const characterNameMappings =
    await loadTraditionalToSimplifiedCharacterNameMap();
  const stats = fillMissingTextCnFromTextTw(
    story.content,
    characterNameMappings,
    { refreshExisting: args.refreshExisting },
  );
  markOpenCcTranslationSource(story, stats);

  console.log(`Input: ${inputPath}`);
  console.log(`Rows: ${stats.rows}`);
  console.log(`Empty TextCn before conversion: ${stats.emptyTextCn}`);
  console.log(`Filled from TextTw: ${stats.filled}`);
  console.log(`Refreshed existing TextCn: ${stats.refreshedExisting}`);
  console.log(
    `Mapped character names: ${stats.mappedNameOccurrences} occurrences ` +
    `across ${stats.mappedNames} names`,
  );
  console.log(
    "Still missing on display-text rows: " +
    `${stats.missingTextTwOnDisplayTextRows}`,
  );
  console.log(
    `Still missing including non-text stage rows: ${stats.missingTextTw}`,
  );

  if (args.dryRun) {
    console.log("Dry run complete; no file written.");
    return;
  }
  if (
    stats.filled === 0 &&
    stats.refreshedExisting === 0 &&
    outputPath === inputPath
  ) {
    console.log("No changes written.");
    return;
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(story, null, 2)}\n`);
    fs.renameSync(temporaryPath, outputPath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
  console.log(`Wrote: ${outputPath}`);
}

const invokedPath = process.argv[1]
  ? url.pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  try {
    await main();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}
