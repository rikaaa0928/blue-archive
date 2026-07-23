import fs from "fs";
import http from "http";
import https from "https";
import path from "path";
import url from "url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..", "..");
const defaultBaseUrl = "https://ba-l10n.cnfast.top";
const defaultSourceKind = "normal";
const supportedFlatStoryTypes = new Set(["main", "other"]);
const supportedNestedStoryTypes = new Set(["favor", "event", "group", "mini"]);

function printUsage() {
  console.log(`Usage:
  node ./CICD/create-story/import-ba-l10n-story.mjs <story-id-or-url> [options]

Options:
  --source-kind <kind>   ba-l10n data kind, default: normal
  --base-url <url>       ba-l10n base url, default: ${defaultBaseUrl}
  --type <type>          output story type, default: main
  --out-id <id>          output story id, default: source story id
  --directory-id <id>    required for nested output types: favor/event/group/mini
  --input <file>         read ba-l10n json from local file instead of fetching
  --output <file>        write to an explicit output json path
  --force, -f            overwrite existing output
  --dry-run              convert and print summary without writing
  --help, -h             show this help

Examples:
  node ./CICD/create-story/import-ba-l10n-story.mjs 1101 --force
  node ./CICD/create-story/import-ba-l10n-story.mjs https://ba-l10n-aws.cnfast.top/scenario/1101
  node ./CICD/create-story/import-ba-l10n-story.mjs 1101 --input /tmp/1101.json --dry-run
`);
}

function parseArgs(argv) {
  const args = {
    source: "",
    sourceKind: defaultSourceKind,
    baseUrl: defaultBaseUrl,
    type: "main",
    outId: "",
    directoryId: "",
    input: "",
    output: "",
    force: false,
    dryRun: false,
    help: false,
  };

  const positional = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    switch (arg) {
      case "--source-kind":
      case "--source-type":
        args.sourceKind = readOptionValue(argv, ++index, arg);
        break;
      case "--base-url":
        args.baseUrl = readOptionValue(argv, ++index, arg);
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
      case "--input":
        args.input = readOptionValue(argv, ++index, arg);
        break;
      case "--output":
        args.output = readOptionValue(argv, ++index, arg);
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

  args.source = positional[0] ?? "";
  if (positional.length > 1) {
    throw new Error(`Unexpected positional arguments: ${positional.slice(1).join(" ")}`);
  }
  return args;
}

function readOptionValue(argv, index, optionName) {
  const value = argv[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

function parseSource(source, fallbackKind) {
  if (!source) {
    return { storyId: "", sourceKind: fallbackKind, sourceUrl: "" };
  }

  if (/^https?:\/\//i.test(source)) {
    const parsed = new URL(source);
    const dataMatch = parsed.pathname.match(/\/data\/story\/([^/]+)\/([^/.]+)\.json$/i);
    if (dataMatch) {
      return {
        storyId: dataMatch[2],
        sourceKind: dataMatch[1],
        sourceUrl: parsed.toString(),
      };
    }

    const scenarioMatch = parsed.pathname.match(/\/scenario\/([^/]+)/i);
    if (scenarioMatch) {
      return {
        storyId: scenarioMatch[1],
        sourceKind: fallbackKind,
        sourceUrl: "",
      };
    }

    throw new Error(`Cannot infer story id from url: ${source}`);
  }

  return { storyId: source, sourceKind: fallbackKind, sourceUrl: "" };
}

function buildSourceUrl(baseUrl, sourceKind, storyId, explicitUrl) {
  if (explicitUrl) {
    return explicitUrl;
  }
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  return `${normalizedBase}/data/story/${sourceKind}/${storyId}.json`;
}

function buildOutputPath(args, outId) {
  if (args.output) {
    return path.resolve(process.cwd(), args.output);
  }

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
      `${outId}.json`
    );
  }

  throw new Error(
    `Unsupported output type: ${args.type}. Expected one of: ${[
      ...supportedFlatStoryTypes,
      ...supportedNestedStoryTypes,
    ].join(", ")}`
  );
}

async function loadSourceJson(args, sourceUrl) {
  if (args.input) {
    const inputPath = path.resolve(process.cwd(), args.input);
    return JSON.parse(fs.readFileSync(inputPath, "utf8"));
  }

  return JSON.parse(await requestText(sourceUrl));
}

async function requestText(requestUrl) {
  if (typeof fetch === "function") {
    const response = await fetch(requestUrl);
    if (!response.ok) {
      throw new Error(`GET ${requestUrl} failed: ${response.status} ${response.statusText}`);
    }
    return response.text();
  }

  return new Promise((resolve, reject) => {
    const client = requestUrl.startsWith("https:") ? https : http;
    const req = client.get(requestUrl, response => {
      const statusCode = response.statusCode ?? 0;
      if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
        const redirectUrl = new URL(response.headers.location, requestUrl).toString();
        response.resume();
        requestText(redirectUrl).then(resolve, reject);
        return;
      }

      if (statusCode < 200 || statusCode >= 300) {
        response.resume();
        reject(new Error(`GET ${requestUrl} failed: ${statusCode}`));
        return;
      }

      response.setEncoding("utf8");
      let raw = "";
      response.on("data", chunk => {
        raw += chunk;
      });
      response.on("end", () => resolve(raw));
    });
    req.on("error", reject);
  });
}

function convertBaL10nStory(sourceRows, { groupId }) {
  if (!Array.isArray(sourceRows)) {
    throw new Error("ba-l10n source json must be an array");
  }

  const state = {
    bgName: 0,
    bgmId: 0,
  };
  const stats = {
    sourceRows: sourceRows.length,
    commandRows: 0,
    textRows: 0,
    skippedRows: 0,
    unknownCommands: new Map(),
  };
  const content = [];

  for (const row of sourceRows) {
    if (!row || typeof row !== "object") {
      stats.skippedRows++;
      continue;
    }

    if (row.DataType === "cmd") {
      stats.commandRows++;
      const units = convertCommandRow(row, groupId, state, stats);
      content.push(...units);
      continue;
    }

    const unit = convertStoryRow(row, groupId, state);
    if (!unit.ScriptKr && !unit.TextJp && !unit.PopupFileName) {
      stats.skippedRows++;
      continue;
    }
    stats.textRows++;
    content.push(unit);
  }

  return {
    story: {
      proofreader: "",
      GroupId: groupId,
      translator: "ba-l10n.cnfast.top",
      content,
    },
    stats,
  };
}

function convertCommandRow(row, groupId, state, stats) {
  const payload = row.Payload ?? {};
  const commandType = String(payload.Type ?? "").toLowerCase();
  const selectionGroup = numberOrZero(row.SelectionGroup);

  switch (commandType) {
    case "bg": {
      const bgName = numberOrZero(payload.Id);
      state.bgName = bgName;
      return [
        createRawUnit(groupId, {
          SelectionGroup: selectionGroup,
          BGName: bgName,
        }),
      ];
    }
    case "bgm": {
      const bgmId = numberOrZero(payload.Id);
      state.bgmId = bgmId;
      return [
        createRawUnit(groupId, {
          SelectionGroup: selectionGroup,
          BGMId: bgmId,
        }),
      ];
    }
    case "sound": {
      const sound = stringOrEmpty(payload.Id ?? payload.Sound ?? payload.SoundId);
      return [
        createRawUnit(groupId, {
          SelectionGroup: selectionGroup,
          Sound: sound,
        }),
      ];
    }
    case "sound_popup": {
      const sound = stringOrEmpty(payload.Id ?? payload.Sound ?? payload.SoundId);
      const popup = stringOrEmpty(
        payload.PopupFileName ?? payload.Popup ?? payload.FileName
      );
      return [
        createRawUnit(groupId, {
          SelectionGroup: selectionGroup,
          Sound: sound,
          PopupFileName: popup,
        }),
      ];
    }
    case "video": {
      const videoPath = stringOrEmpty(payload.Video ?? payload.VideoPath ?? payload.Id);
      const soundPath = stringOrEmpty(payload.Sound ?? payload.SoundPath ?? "");
      const script = videoPath ? `#video;${videoPath};${soundPath}` : "";
      return [
        createRawUnit(groupId, {
          SelectionGroup: selectionGroup,
          ScriptKr: script,
        }),
      ];
    }
    case "wait": {
      const waitMs = numberOrZero(payload.Id ?? payload.Duration ?? payload.Time);
      return [
        createRawUnit(groupId, {
          SelectionGroup: selectionGroup,
          ScriptKr: waitMs ? `#wait;${waitMs}` : "",
        }),
      ];
    }
    default:
      stats.unknownCommands.set(
        commandType || "(empty)",
        (stats.unknownCommands.get(commandType || "(empty)") ?? 0) + 1
      );
      return [];
  }
}

function convertStoryRow(row, groupId, state) {
  const bgName = numberOrZero(row.BGName);
  const bgmId = numberOrZero(row.BGMId);

  const unit = createRawUnit(groupId, {
    SelectionGroup: numberOrZero(row.SelectionGroup),
    BGMId: bgmId && bgmId !== state.bgmId ? bgmId : 0,
    Sound: stringOrEmpty(row.Sound),
    Transition: numberOrZero(row.Transition),
    BGName: bgName && bgName !== state.bgName ? bgName : 0,
    BGEffect: numberOrZero(row.BGEffect),
    PopupFileName: stringOrEmpty(row.PopupFileName),
    ScriptKr: normalizeScript(row.Script),
    TextJp: sanitizeMessage(row.Message?.j_ja),
  });

  if (bgName) {
    state.bgName = bgName;
  }
  if (bgmId) {
    state.bgmId = bgmId;
  }

  return unit;
}

function createRawUnit(groupId, overrides = {}) {
  return {
    GroupId: groupId,
    SelectionGroup: 0,
    BGMId: 0,
    Sound: "",
    Transition: 0,
    BGName: 0,
    BGEffect: 0,
    PopupFileName: "",
    ScriptKr: "",
    TextJp: "",
    TextCn: "",
    TextTh: "",
    TextTw: "",
    TextEn: "",
    VoiceJp: "",
    ...overrides,
  };
}

function sanitizeMessage(value) {
  return decodeHtmlEntities(stringOrEmpty(value))
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?span\b[^>]*>/gi, "")
    .replace(/<\/?p\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeScript(value) {
  return stringOrEmpty(value)
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\r\n?/g, "\n");
}

function decodeHtmlEntities(value) {
  const named = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };

  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) {
      return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    }
    if (lower.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
    }
    return named[lower] ?? match;
  });
}

function numberOrZero(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function stringOrEmpty(value) {
  return value === undefined || value === null ? "" : String(value);
}

function mapToObject(map) {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const parsedSource = parseSource(args.source, args.sourceKind);
  const storyId = parsedSource.storyId;
  if (!storyId) {
    throw new Error("Missing story id");
  }

  const outId = args.outId || storyId;
  const groupId = Number(outId);
  if (!Number.isSafeInteger(groupId)) {
    throw new Error(`Output story id must be a safe integer: ${outId}`);
  }

  const sourceUrl = buildSourceUrl(
    args.baseUrl,
    parsedSource.sourceKind,
    storyId,
    parsedSource.sourceUrl
  );
  const outputPath = buildOutputPath(args, outId);
  const sourceRows = await loadSourceJson(args, sourceUrl);
  const { story, stats } = convertBaL10nStory(sourceRows, { groupId });

  const summary = {
    source: args.input ? path.resolve(process.cwd(), args.input) : sourceUrl,
    output: outputPath,
    storyId,
    outId,
    sourceRows: stats.sourceRows,
    commandRows: stats.commandRows,
    textRows: stats.textRows,
    outputUnits: story.content.length,
    skippedRows: stats.skippedRows,
    unknownCommands: mapToObject(stats.unknownCommands),
  };

  if (args.dryRun) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (fs.existsSync(outputPath) && !args.force) {
    throw new Error(`Output already exists: ${outputPath}. Use --force to overwrite.`);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(story, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
