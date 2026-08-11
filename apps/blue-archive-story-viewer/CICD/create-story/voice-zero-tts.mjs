import childProcess from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import url from "url";
import {
  attachLocalCharacterResources,
  resolveStoryCharacterRoster,
} from "./ba-character-catalog.mjs";
import {
  isAnonymousScenarioSpeaker,
  isUnknownScenarioSpeaker,
  parseScenarioScriptSpeakers,
} from "./scenario-script-speakers.mjs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..", "..");
const repoRoot = path.resolve(appRoot, "..", "..");
loadEnvFile(path.join(appRoot, ".env"));
loadEnvFile(path.join(repoRoot, ".env"));

const defaultCharacterRoot = path.resolve(appRoot, ".local-files", "ba-characters");
const defaultTtsBaseUrl = "https://yiling.top/api/tts";
const defaultModel = "zerotts-v3";
const npcSpeakerKey = "__anonymous_npc__";
const npcReferenceCharacterName = "NPC Neutral Raw Experiment v4";
const npcReferenceDirectoryName = "npc-neutral-v4";
const npcAudioEffectVersion = "v4-heavy-jitter-1";
const collectiveConfigRoot = path.join(
  __dirname,
  "config",
  "collective-voices",
);
const collectiveMixVersion = "collective-v1";

const flatStoryTypes = new Set(["main", "other"]);
const nestedStoryTypes = new Set(["favor", "event", "group", "mini"]);
const audioExtensions = new Set([".flac", ".m4a", ".mp3", ".ogg", ".opus", ".wav"]);
const terminalTaskStatuses = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) {
    return;
  }

  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) {
      continue;
    }

    const key = match[1];
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
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
  node ./CICD/create-story/voice-zero-tts.mjs <story-id-or-json-path> [options]

Stages:
  --stage prepare           prepare local reference audio only, default
  --stage upload            prepare and upload reference voices
  --stage tasks             upload references and create TTS tasks
  --stage poll              poll existing tasks and download mp3
  --stage all               prepare, upload, create tasks, poll until done

Options:
  --type <type>             story type when source is an id, default: group
  --directory-id <id>       directory id for favor/event/group/mini
  --manifest <file>         workflow manifest path, default under .local-files
  --character-root <dir>    local character reference resource root
  --local-file-root <dir>   local audio and manifest root, default: .local-files
  --speaker-map <file>      exceptional CharacterName-to-local-directory override
  --model <model>           ZeroTTS model, default: ${defaultModel}
  --tts-base-url <url>      ZeroTTS base url, default: ${defaultTtsBaseUrl}
  --chunk-length <n>        ZeroTTS chunkLength, default: 300
  --temperature <n>         ZeroTTS temperature, default: 0.8
  --poll-interval <n>       seconds between task polls, default: 8
  --poll-timeout <n>        max seconds for --stage all/--stage poll, default: 1800
  --limit <n>               process at most n story voice lines
  --reference-min <n>       min total reference seconds, default: 20
  --reference-max <n>       max total reference seconds, default: 60
  --reference-min-clip <n>  min seconds for each selected reference clip, default: 5
  --reference-gap <n>       silence seconds inserted between reference clips, default: 0.8
  --force                   recreate references/tasks and overwrite downloaded audio
  --changed-only            process only lines changed since their last R2 publish
  --missing-only            process only voice lines whose VoiceJp is empty
  --regenerate-collective-member <speaker>
                            recreate only this member in matching collective lines
  --dry-run                 print plan without network calls or local writes
  --help, -h                show this help

Environment:
  ZERO_TTS_API_KEY / OZX_TTS_API_KEY / YILING_TTS_API_TOKEN
  ZERO_TTS_BASE_URL
  BA_CHARACTER_RESOURCE_ROOT
  BA_LOCAL_FILE_ROOT

Examples:
  pnpm voice-zero-tts 1101 --type group --stage prepare
  pnpm voice-zero-tts 1101 --type group --stage all --limit 3
  pnpm voice-zero-tts 1101 --type group --stage all --changed-only
`);
}

function parseArgs(argv) {
  const args = {
    source: "",
    type: "group",
    directoryId: "",
    manifest: "",
    characterRoot:
      process.env.BA_CHARACTER_RESOURCE_ROOT || defaultCharacterRoot,
    localFileRoot:
      process.env.BA_LOCAL_FILE_ROOT || path.resolve(appRoot, ".local-files"),
    speakerMap: "",
    stage: "prepare",
    model: process.env.ZERO_TTS_MODEL || defaultModel,
    ttsBaseUrl: process.env.ZERO_TTS_BASE_URL || defaultTtsBaseUrl,
    chunkLength: 300,
    temperature: 0.8,
    pollInterval: 8,
    pollTimeout: 1800,
    limit: 0,
    referenceMin: 20,
    referenceMax: 60,
    referenceMinClip: 5,
    referenceGap: 0.8,
    force: false,
    changedOnly: false,
    missingOnly: false,
    regenerateCollectiveMember: "",
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
      case "--manifest":
        args.manifest = readOptionValue(argv, ++index, arg);
        break;
      case "--character-root":
        args.characterRoot = readOptionValue(argv, ++index, arg);
        break;
      case "--local-file-root":
        args.localFileRoot = readOptionValue(argv, ++index, arg);
        break;
      case "--speaker-map":
        args.speakerMap = readOptionValue(argv, ++index, arg);
        break;
      case "--stage":
        args.stage = readOptionValue(argv, ++index, arg);
        break;
      case "--model":
        args.model = readOptionValue(argv, ++index, arg);
        break;
      case "--tts-base-url":
        args.ttsBaseUrl = readOptionValue(argv, ++index, arg);
        break;
      case "--chunk-length":
        args.chunkLength = positiveInteger(readOptionValue(argv, ++index, arg), arg);
        break;
      case "--temperature":
        args.temperature = numberValue(readOptionValue(argv, ++index, arg), arg);
        break;
      case "--poll-interval":
        args.pollInterval = positiveInteger(readOptionValue(argv, ++index, arg), arg);
        break;
      case "--poll-timeout":
        args.pollTimeout = positiveInteger(readOptionValue(argv, ++index, arg), arg);
        break;
      case "--limit":
        args.limit = positiveInteger(readOptionValue(argv, ++index, arg), arg);
        break;
      case "--reference-min":
        args.referenceMin = positiveInteger(readOptionValue(argv, ++index, arg), arg);
        break;
      case "--reference-max":
        args.referenceMax = positiveInteger(readOptionValue(argv, ++index, arg), arg);
        break;
      case "--reference-min-clip":
        args.referenceMinClip = positiveInteger(readOptionValue(argv, ++index, arg), arg);
        break;
      case "--reference-gap":
        args.referenceGap = numberValue(readOptionValue(argv, ++index, arg), arg);
        break;
      case "--force":
        args.force = true;
        break;
      case "--changed-only":
        args.changedOnly = true;
        break;
      case "--missing-only":
        args.missingOnly = true;
        break;
      case "--regenerate-collective-member":
        args.regenerateCollectiveMember = readOptionValue(argv, ++index, arg);
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

function positiveInteger(value, optionName) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${optionName} must be a positive integer`);
  }
  return parsed;
}

function numberValue(value, optionName) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${optionName} must be a non-negative number`);
  }
  return parsed;
}

function resolveStoryPath(args) {
  if (!args.source) {
    throw new Error("Missing story id or json path");
  }

  const sourcePath = path.resolve(process.cwd(), args.source);
  if (fs.existsSync(sourcePath)) {
    return sourcePath;
  }

  if (flatStoryTypes.has(args.type)) {
    return path.join(appRoot, "public", "story", args.type, `${args.source}.json`);
  }

  if (nestedStoryTypes.has(args.type)) {
    const directoryId = args.directoryId || String(args.source).slice(0, 5);
    return path.join(
      appRoot,
      "public",
      "story",
      args.type,
      directoryId,
      `${args.source}.json`
    );
  }

  throw new Error(
    `Unsupported story type: ${args.type}. Expected one of ${[
      ...flatStoryTypes,
      ...nestedStoryTypes,
    ].join(", ")}`
  );
}

function storyIdFromPath(storyPath) {
  return path.basename(storyPath, ".json");
}

function effectiveTtsText(unit) {
  return unit.TextJpVoice !== undefined && unit.TextJpVoice !== null
    ? String(unit.TextJpVoice).trim()
    : String(unit.TextJp || "").trim();
}

function collectiveScanDigest(story) {
  const rows = story.content.map(unit => [
    String(unit.ScriptKr ?? ""),
    effectiveTtsText(unit),
  ]);
  return `sha256:${textHash(JSON.stringify(rows))}`;
}

function resolveCollectiveConfigPath(storyPath) {
  const publicStoryRoot = path.join(appRoot, "public", "story");
  const relativePath = path.relative(publicStoryRoot, storyPath);
  if (
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error(
      "Collective voice config requires a story under public/story: " +
        storyPath,
    );
  }
  return {
    configPath: path.join(collectiveConfigRoot, relativePath),
    relativeStoryPath: path.join("public", "story", relativePath)
      .split(path.sep)
      .join("/"),
  };
}

function loadCollectiveVoiceConfig(storyPath, story) {
  const { configPath, relativeStoryPath } =
    resolveCollectiveConfigPath(storyPath);
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Missing voice review config: ${configPath}. ` +
        "Read COLLECTIVE_VOICE_CONFIG.md before running TTS.",
    );
  }

  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (config.schemaVersion !== 2) {
    throw new Error(
      `Unsupported voice review schemaVersion in ${configPath}: ` +
        `${config.schemaVersion}`,
    );
  }
  if (config.source?.storyPath !== relativeStoryPath) {
    throw new Error(
      `Voice review storyPath mismatch in ${configPath}: expected ` +
        `${relativeStoryPath}`,
    );
  }
  if (config.source?.contentLength !== story.content.length) {
    throw new Error(
      `Voice review contentLength mismatch in ${configPath}; ` +
        "review the complete story again",
    );
  }
  const currentDigest = collectiveScanDigest(story);
  if (config.source?.scanDigest !== currentDigest) {
    throw new Error(
      `Voice review scanDigest mismatch in ${configPath}; ` +
        "review the complete story again",
    );
  }
  if (!Array.isArray(config.lines)) {
    throw new Error(`Voice review lines must be an array: ${configPath}`);
  }

  const linesByIndex = new Map();
  let previousIndex = -1;
  for (const entry of config.lines) {
    const index = entry?.storyIndex;
    if (!Number.isSafeInteger(index) || index < 0 || index >= story.content.length) {
      throw new Error(
        `Invalid reviewed storyIndex ${index} in ${configPath}`,
      );
    }
    if (index <= previousIndex) {
      throw new Error(
        `Reviewed lines must have unique ascending storyIndex values: ${configPath}`,
      );
    }
    previousIndex = index;
    if (!["collective", "unknown-speaker"].includes(entry.kind)) {
      throw new Error(
        `Reviewed line ${index} must use kind=collective or ` +
          "kind=unknown-speaker",
      );
    }
    if (entry.status !== "ready") {
      throw new Error(
        `Reviewed line ${index} is ${entry.status || "unreviewed"}; ` +
          "finish the LLM review before TTS",
      );
    }

    const unit = story.content[index];
    const speaker = parseScenarioScriptSpeakers(unit).dialogueSpeaker;
    const expected = entry.expected || {};
    if (
      expected.speaker !== speaker ||
      expected.scriptKr !== String(unit.ScriptKr ?? "") ||
      expected.ttsText !== effectiveTtsText(unit)
    ) {
      throw new Error(
        `Reviewed line ${index} no longer matches its expected fields in ` +
          configPath,
      );
    }
    if (!expected.ttsText) {
      throw new Error(`Reviewed line ${index} has empty TTS text`);
    }

    if (entry.kind === "collective") {
      if (!Array.isArray(entry.members) || entry.members.length < 2) {
        throw new Error(`Collective line ${index} requires at least two members`);
      }
      const members = entry.members.map(member => String(member).trim());
      if (
        members.some(member => !member) ||
        new Set(members).size !== members.length
      ) {
        throw new Error(
          `Collective line ${index} has empty or duplicate members`,
        );
      }
      const memberOverrides = entry.mix?.memberOverrides || {};
      for (const [member, override] of Object.entries(memberOverrides)) {
        if (!members.includes(member)) {
          throw new Error(
            `Collective line ${index} has a mix override for non-member ${member}`,
          );
        }
        for (const field of ["delayMs", "gainDb"]) {
          if (
            override?.[field] !== undefined &&
            !Number.isFinite(Number(override[field]))
          ) {
            throw new Error(
              `Collective line ${index} ${member}.${field} must be numeric`,
            );
          }
        }
      }
      linesByIndex.set(index, {
        ...entry,
        members,
        expected: { ...expected },
      });
      continue;
    }

    if (!isUnknownScenarioSpeaker(speaker)) {
      throw new Error(
        `Unknown-speaker line ${index} must point to a ??? dialogue`,
      );
    }
    if (!["character", "anonymous"].includes(entry.resolution)) {
      throw new Error(
        `Unknown-speaker line ${index} requires resolution=character or ` +
          "resolution=anonymous",
      );
    }
    const resolvedSpeaker = String(entry.resolvedSpeaker || "").trim();
    if (!resolvedSpeaker || isUnknownScenarioSpeaker(resolvedSpeaker)) {
      throw new Error(
        `Unknown-speaker line ${index} requires a concrete resolvedSpeaker`,
      );
    }
    if (
      entry.resolution === "character" &&
      isAnonymousScenarioSpeaker(resolvedSpeaker)
    ) {
      throw new Error(
        `Unknown-speaker line ${index} resolves to anonymous speaker ` +
          `${resolvedSpeaker}; use resolution=anonymous`,
      );
    }
    if (
      entry.resolution === "anonymous" &&
      !isAnonymousScenarioSpeaker(resolvedSpeaker)
    ) {
      throw new Error(
        `Unknown-speaker line ${index} resolves to named character ` +
          `${resolvedSpeaker}; use resolution=character`,
      );
    }
    const evidence = String(entry.evidence || "").trim();
    if (!evidence) {
      throw new Error(
        `Unknown-speaker line ${index} requires non-empty evidence`,
      );
    }
    linesByIndex.set(index, {
      ...entry,
      resolvedSpeaker,
      evidence,
      expected: { ...expected },
    });
  }

  for (let index = 0; index < story.content.length; index++) {
    const unit = story.content[index];
    if (!effectiveTtsText(unit)) continue;
    if (!isUnknownScenarioSpeaker(
      parseScenarioScriptSpeakers(unit).dialogueSpeaker,
    )) continue;
    if (linesByIndex.get(index)?.kind === "unknown-speaker") continue;
    throw new Error(
      `Missing unknown-speaker review for ??? dialogue at storyIndex ` +
        `${index} in ${configPath}; finish the LLM review before TTS`,
    );
  }

  return { configPath, config, linesByIndex };
}

function resolveManifestPath(args, storyId) {
  if (args.manifest) {
    return path.resolve(process.cwd(), args.manifest);
  }
  return path.join(
    path.resolve(args.localFileRoot),
    "tts",
    args.type,
    storyId,
    "voice-zero-tts-manifest.json"
  );
}

async function loadSpeakerMap(args, story, collectiveConfig) {
  const configured = args.speakerMap
    ? JSON.parse(fs.readFileSync(path.resolve(args.speakerMap), "utf8"))
    : {};
  const overrides = configured;
  const references = [];
  for (let index = 0; index < story.content.length; index++) {
    const unit = story.content[index];
    const text = effectiveTtsText(unit);
    if (!text) continue;
    if (args.missingOnly && String(unit.VoiceJp || "").trim()) continue;
    if (collectiveConfig.linesByIndex.has(index)) continue;
    const parsedSpeakers = parseScenarioScriptSpeakers(unit);
    const speakerCandidates = parsedSpeakers.speakers;
    const speaker = parsedSpeakers.dialogueSpeaker;
    if (!speaker || isAnonymousScenarioSpeaker(speaker)) continue;
    references.push({
      speaker,
      speakerCandidates,
    });
  }
  for (const entry of collectiveConfig.linesByIndex.values()) {
    if (
      args.missingOnly &&
      String(story.content[entry.storyIndex]?.VoiceJp || "").trim()
    ) {
      continue;
    }
    if (entry.kind === "collective") {
      for (const member of entry.members) {
        references.push({ speaker: member, speakerCandidates: [member] });
      }
    } else if (entry.resolution === "character") {
      references.push({
        speaker: entry.resolvedSpeaker,
        speakerCandidates: [entry.resolvedSpeaker],
      });
    }
  }

  const playerRoster = await resolveStoryCharacterRoster(references);
  const roster = attachLocalCharacterResources(
    playerRoster,
    path.resolve(args.characterRoot),
    overrides,
  );
  const speakerMap = {};
  for (const [speaker, character] of roster) {
    speakerMap[speaker] = character.characterName;
    console.log(
      `Resolved player speaker ${speaker} -> ${character.translationName} ` +
        `(xxhash=${character.characterId}); ` +
        `local resource=${character.characterDirectory}`,
    );
  }
  return speakerMap;
}

function extractVoiceLines(story, speakerMap, collectiveConfig, limit) {
  const lines = [];
  for (let index = 0; index < story.content.length; index++) {
    const unit = story.content[index];

    // 如果 LLM 判定这句没有台词并将 TextJpVoice 明确设为 ""，就不再回退到包含拟声词的 TextJp
    const text = effectiveTtsText(unit);

    if (!text) continue;

    const parsedSpeakers = parseScenarioScriptSpeakers(unit);
    const speakers = parsedSpeakers.speakers;
    const dialogueSpeaker = parsedSpeakers.dialogueSpeaker;
    if (!dialogueSpeaker) continue;

    const reviewed = collectiveConfig.linesByIndex.get(index);
    if (reviewed?.kind === "collective") {
      lines.push({
        kind: "collective",
        index,
        speaker: dialogueSpeaker,
        sourceSpeaker: dialogueSpeaker,
        characterName: dialogueSpeaker,
        text,
        textCn: String(unit.TextCn || ""),
        scriptKr: String(unit.ScriptKr || ""),
        members: reviewed.members.map(member => ({
          speaker: member,
          characterName: speakerMap[member] || member,
        })),
        mix: reviewed.mix || {},
      });
      continue;
    }

    if (reviewed?.kind === "unknown-speaker") {
      const anonymous = reviewed.resolution === "anonymous";
      const speaker = anonymous ? npcSpeakerKey : reviewed.resolvedSpeaker;
      lines.push({
        kind: anonymous ? "anonymous" : "resolved-speaker",
        index,
        speaker,
        sourceSpeaker: dialogueSpeaker,
        resolvedSpeaker: reviewed.resolvedSpeaker,
        characterName: anonymous
          ? npcReferenceCharacterName
          : speakerMap[speaker] || speaker,
        text,
        textCn: String(unit.TextCn || ""),
        scriptKr: String(unit.ScriptKr || ""),
        extraSpeakers: speakers.filter(candidate => candidate !== speaker),
      });
      continue;
    }

    const anonymous = isAnonymousScenarioSpeaker(dialogueSpeaker);
    const speaker = anonymous ? npcSpeakerKey : dialogueSpeaker;
    lines.push({
      index,
      speaker,
      sourceSpeaker: dialogueSpeaker,
      characterName: anonymous
        ? npcReferenceCharacterName
        : speakerMap[speaker] || speaker,
      text,
      textCn: String(unit.TextCn || ""),
      scriptKr: String(unit.ScriptKr || ""),
      extraSpeakers: speakers.filter(candidate => candidate !== speaker),
    });
  }

  return limit > 0 ? lines.slice(0, limit) : lines;
}


function loadManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) {
    return {
      references: {},
      tasks: {},
    };
  }
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

function saveManifest(manifestPath, manifest) {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function buildManifestBase(args, storyPath, storyId, voiceLines) {
  return {
    storyId,
    storyType: args.type,
    storyPath,
    localFileRoot: path.resolve(args.localFileRoot),
    ttsBaseUrl: args.ttsBaseUrl.replace(/\/+$/, ""),
    model: args.model,
    createdAt: new Date().toISOString(),
    voiceLineCount: voiceLines.length,
  };
}

function textHash(text) {
  return crypto.createHash("sha256").update(String(text)).digest("hex");
}

function taskGeneratedText(task) {
  return String(task?.generatedText ?? task?.text ?? "");
}

function taskPublishedText(task, storyUnit) {
  if (typeof task?.publishedText === "string") {
    return task.publishedText;
  }
  if (task?.publishedTaskId && task.needsPublish !== true) {
    return String(task.text ?? "");
  }
  if (
    task?.status === "COMPLETED" &&
    task.needsPublish !== true &&
    String(storyUnit?.VoiceJp ?? "").trim()
  ) {
    return taskGeneratedText(task);
  }
  return null;
}

function isChangedSincePublish(line, task, storyUnit) {
  const publishedText = taskPublishedText(task, storyUnit);
  return publishedText === null ||
    publishedText !== line.text ||
    String(task?.speaker || "") !== line.speaker ||
    String(task?.kind || "") !== String(line.kind || "");
}

function slugify(value) {
  return String(value)
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 80);
}

function scanVoiceCandidates(characterDir, args) {
  const voiceDir = path.join(characterDir, "语音");
  if (!fs.existsSync(voiceDir)) {
    return [];
  }

  const candidates = [];
  for (const entry of fs.readdirSync(voiceDir)) {
    const ext = path.extname(entry).toLowerCase();
    if (!audioExtensions.has(ext)) continue;

    const audioPath = path.join(voiceDir, entry);
    const baseName = path.basename(entry, ext);
    const textPath = path.join(voiceDir, `${baseName}.txt`);
    if (!fs.existsSync(textPath)) continue;

    const text = fs.readFileSync(textPath, "utf8").trim();
    if (!text) continue;

    const duration = getAudioDuration(audioPath);
    if (duration < args.referenceMinClip) continue;

    candidates.push({
      baseName,
      category: baseName.split("_")[0] || "未分类",
      audioPath,
      textPath,
      text,
      duration,
      score: scoreReferenceCandidate(baseName, duration, text),
    });
  }

  return candidates.sort((a, b) => b.score - a.score);
}

function scoreReferenceCandidate(baseName, duration, text) {
  const categoryBonus = [
    ["回忆大厅", 30],
    ["大厅", 25],
    ["好感度", 22],
    ["事件", 20],
    ["战斗", 18],
    ["成长", 12],
    ["通常", 10],
  ].find(([keyword]) => baseName.includes(keyword))?.[1] || 0;
  const durationScore = duration >= 7 && duration <= 18 ? 20 : 8;
  const textScore = Math.min(text.length / 2, 30);
  return categoryBonus + durationScore + textScore;
}

function selectReferenceClips(candidates, args) {
  if (candidates.length === 0) {
    throw new Error("No usable reference clips found");
  }

  const selected = [];
  const usedCategories = new Set();
  let totalDuration = 0;

  for (const candidate of candidates) {
    if (totalDuration >= args.referenceMin) break;
    if (usedCategories.has(candidate.category)) continue;
    if (totalDuration + candidate.duration > args.referenceMax) continue;
    selected.push(candidate);
    usedCategories.add(candidate.category);
    totalDuration += candidate.duration;
  }

  for (const candidate of candidates) {
    if (totalDuration >= args.referenceMin) break;
    if (selected.includes(candidate)) continue;
    if (totalDuration + candidate.duration > args.referenceMax) continue;
    selected.push(candidate);
    totalDuration += candidate.duration;
  }

  if (totalDuration < args.referenceMin && candidates.length > 0) {
    throw new Error(
      `Unable to select reference clips >= ${args.referenceMin}s without ` +
        `exceeding ${args.referenceMax}s`
    );
  }

  return selected;
}

function getAudioDuration(audioPath) {
  const output = childProcess.execFileSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      audioPath,
    ],
    { encoding: "utf8" }
  );
  const duration = Number(output.trim());
  return Number.isFinite(duration) ? duration : 0;
}

function prepareReferenceAudio({ args, speaker, characterName, manifest }) {
  if (speaker === npcSpeakerKey) {
    return prepareNpcReferenceAudio({ args, speaker, characterName, manifest });
  }

  const referenceKey = speaker;
  const existing = manifest.references[referenceKey];
  const speakerSlug = slugify(`${speaker}_${characterName}`);
  const outputDir = path.join(
    args.localFileRoot,
    "tts",
    "references",
    speakerSlug,
  );
  const audioPath = path.join(outputDir, "reference.mp3");
  const textPath = path.join(outputDir, "reference.txt");
  const referenceManifestPath = path.join(outputDir, "reference-manifest.json");

  if (
    !args.force &&
    fs.existsSync(audioPath) &&
    fs.existsSync(textPath) &&
    fs.existsSync(referenceManifestPath)
  ) {
    const cached = JSON.parse(fs.readFileSync(referenceManifestPath, "utf8"));
    manifest.references[referenceKey] = {
      ...existing,
      ...cached,
      speaker,
      characterName,
      audioPath,
      textPath,
      referenceText: fs.readFileSync(textPath, "utf8").trim(),
    };
    return manifest.references[referenceKey];
  }

  const characterDir = path.join(args.characterRoot, characterName);
  if (!fs.existsSync(characterDir)) {
    throw new Error(
      `Missing local character resources for ${speaker} -> ` +
        `${characterName}: ${characterDir}`,
    );
  }

  const candidates = scanVoiceCandidates(characterDir, args);
  const clips = selectReferenceClips(candidates, args);
  const referenceText = clips.map(clip => clip.text).join("\n\n");

  if (!args.dryRun) {
    fs.mkdirSync(outputDir, { recursive: true });
    concatenateAudio(clips, audioPath, args.referenceGap);
    fs.writeFileSync(textPath, `${referenceText}\n`);
  }

  const totalDuration = clips.reduce((sum, clip) => sum + clip.duration, 0);
  const gapDuration = Math.max(0, clips.length - 1) * args.referenceGap;
  const prepared = {
    speaker,
    characterName,
    audioPath,
    textPath,
    referenceText,
    totalDuration: Number((totalDuration + gapDuration).toFixed(3)),
    clips: clips.map(clip => ({
      name: clip.baseName,
      category: clip.category,
      duration: Number(clip.duration.toFixed(3)),
      audioPath: clip.audioPath,
      text: clip.text,
    })),
  };
  if (!args.dryRun) {
    fs.writeFileSync(
      referenceManifestPath,
      `${JSON.stringify(prepared, null, 2)}\n`,
    );
  }
  manifest.references[referenceKey] = {
    ...existing,
    ...prepared,
  };
  return manifest.references[referenceKey];
}

function prepareNpcReferenceAudio({ args, speaker, characterName, manifest }) {
  const referenceDir = path.join(
    path.resolve(args.localFileRoot),
    "tts",
    "references",
    npcReferenceDirectoryName,
  );
  const audioPath = path.join(referenceDir, "reference.mp3");
  const textPath = path.join(referenceDir, "reference.txt");
  if (!fs.existsSync(audioPath) || !fs.existsSync(textPath)) {
    throw new Error(
      `Missing NPC reference files: ${audioPath} and ${textPath}`,
    );
  }

  const existing = manifest.references[speaker];
  const referenceText = fs.readFileSync(textPath, "utf8").trim();
  const totalDuration = Number(getAudioDuration(audioPath).toFixed(3));
  const prepared = {
    ...existing,
    speaker,
    characterName,
    audioPath,
    textPath,
    referenceText,
    totalDuration,
    clips: [
      {
        name: npcReferenceDirectoryName,
        category: "NPC",
        duration: totalDuration,
        audioPath,
        text: referenceText,
      },
    ],
    audioEffectVersion: npcAudioEffectVersion,
  };
  manifest.references[speaker] = prepared;
  return prepared;
}

function concatenateAudio(clips, outputPath, gapSeconds) {
  const args = ["-y"];
  const labels = [];
  clips.forEach((clip, index) => {
    args.push("-i", clip.audioPath);
    labels.push(`[${index}:a]`);
  });
  const silenceInputIndex = clips.length;
  if (clips.length > 1 && gapSeconds > 0) {
    args.push("-f", "lavfi", "-t", String(gapSeconds), "-i", "anullsrc=r=44100:cl=mono");
  }

  const parts = [];
  clips.forEach((_, index) => {
    parts.push(
      `[${index}:a]aresample=44100,aformat=sample_fmts=s16:channel_layouts=mono[a${index}]`
    );
  });

  if (clips.length > 1 && gapSeconds > 0) {
    parts.push(
      `[${silenceInputIndex}:a]aresample=44100,` +
        "aformat=sample_fmts=s16:channel_layouts=mono[silence]"
    );
  }

  const concatLabels = [];
  clips.forEach((_, index) => {
    concatLabels.push(`[a${index}]`);
    if (index < clips.length - 1 && gapSeconds > 0) {
      concatLabels.push("[silence]");
    }
  });
  parts.push(`${concatLabels.join("")}concat=n=${concatLabels.length}:v=0:a=1[out]`);

  args.push(
    "-filter_complex",
    parts.join(";"),
    "-map",
    "[out]",
    "-ar",
    "44100",
    "-ac",
    "1",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "128k",
    outputPath
  );
  childProcess.execFileSync("ffmpeg", args, { stdio: "ignore" });
}

function resolveToken() {
  return (
    process.env.ZERO_TTS_API_KEY ||
    process.env.OZX_TTS_API_KEY ||
    process.env.YILING_TTS_API_TOKEN ||
    ""
  );
}

async function apiRequest(args, endpoint, options = {}) {
  const token = resolveToken();
  if (!token) {
    throw new Error(
      "Missing ZeroTTS API token. Set ZERO_TTS_API_KEY or OZX_TTS_API_KEY."
    );
  }

  const response = await fetch(`${args.ttsBaseUrl.replace(/\/+$/, "")}${endpoint}`, {
    ...options,
    headers: {
      "X-API-Key": token,
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    throw new Error(`ZeroTTS HTTP ${response.status}: ${await response.text()}`);
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    return response;
  }

  const payload = await response.json();
  if (payload?.code && payload.code !== 200) {
    throw new Error(payload.message || `ZeroTTS API error code ${payload.code}`);
  }
  return payload.data ?? payload;
}

async function uploadReference(args, reference) {
  // 先检查服务器上是否已经有同样名字的语音，避免重复上传
  try {
    const listData = await apiRequest(args, "/voices");
    const voices = Array.isArray(listData) ? listData : listData?.items || [];
    const existingVoice = voices.find(
      voice => voice.name === `BA ${reference.characterName}`,
    );
    if (existingVoice) {
      console.log(
        `Found existing voice on server: ${existingVoice.name} ` +
          `(referenceId=${existingVoice.referenceId})`,
      );
      return {
        ...reference,
        voiceId: existingVoice.voiceId || existingVoice.id,
        referenceId: existingVoice.referenceId || existingVoice.id,
        voiceStatus: existingVoice.status || "READY",
        providerSyncStatus: existingVoice.providerSyncStatus,
      };
    }
  } catch (error) {
    console.warn(
      `Failed to check existing voices on server: ${error.message}`,
    );
    const cachedReference =
      reference.referenceId
        ? reference
        : findCachedReference(args.localFileRoot, reference);
    if (cachedReference?.referenceId) {
      console.warn(
        `Reusing cached voice for ${reference.characterName}: ` +
          `${cachedReference.referenceId}`,
      );
      return {
        ...reference,
        voiceId: cachedReference.voiceId,
        referenceId: cachedReference.referenceId,
        voiceStatus: cachedReference.voiceStatus || "READY",
        providerSyncStatus: cachedReference.providerSyncStatus,
      };
    }
  }

  const form = new FormData();
  const audioBytes = fs.readFileSync(reference.audioPath);
  const audioBlob = new Blob([audioBytes], { type: "audio/mpeg" });
  form.append("name", `BA ${reference.characterName}`);
  form.append("description", `Blue Archive reference voice for ${reference.speaker}`);
  form.append("reference_text", reference.referenceText);
  form.append("audio", audioBlob, path.basename(reference.audioPath));

  const data = await apiRequest(args, "/voices", {
    method: "POST",
    body: form,
  });

  return {
    ...reference,
    voiceId: data.voiceId,
    referenceId: data.referenceId,
    voiceStatus: data.status,
    providerSyncStatus: data.providerSyncStatus,
  };
}

function findCachedReference(localFileRoot, reference) {
  const ttsRoot = path.join(path.resolve(localFileRoot), "tts");
  if (!fs.existsSync(ttsRoot)) {
    return null;
  }

  const pendingDirectories = [ttsRoot];
  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pendingDirectories.push(entryPath);
        continue;
      }
      if (entry.name !== "voice-zero-tts-manifest.json") {
        continue;
      }

      try {
        const manifest = JSON.parse(fs.readFileSync(entryPath, "utf8"));
        const match = Object.values(manifest.references || {}).find(
          candidate =>
            candidate.characterName === reference.characterName &&
            candidate.referenceId,
        );
        if (match) {
          return match;
        }
      } catch (error) {
        console.warn(`Skipping invalid TTS manifest ${entryPath}: ${error.message}`);
      }
    }
  }
  return null;
}

async function createTask(args, line, reference, task) {
  const generatedTextHash = textHash(line.text);
  if (
    task?.taskId &&
    !args.force &&
    taskGeneratedText(task) === line.text &&
    task.speaker === line.speaker &&
    task.referenceId === reference.referenceId
  ) {
    return {
      ...task,
      kind: line.kind,
      resolvedSpeaker: line.resolvedSpeaker,
      text: line.text,
      generatedText: line.text,
      generatedTextHash,
    };
  }
  if (!reference.referenceId) {
    throw new Error(`Missing referenceId for speaker ${line.speaker}`);
  }

  const data = await apiRequest(args, "/tasks", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: line.text,
      referenceId: reference.referenceId,
      model: args.model,
      format: "mp3",
      chunkLength: args.chunkLength,
      temperature: args.temperature,
      deliveryMode: "DOWNLOAD",
    }),
  });

  return {
    ...task,
    kind: line.kind,
    index: line.index,
    speaker: line.speaker,
    sourceSpeaker: line.sourceSpeaker,
    resolvedSpeaker: line.resolvedSpeaker,
    characterName: line.characterName,
    text: line.text,
    generatedText: line.text,
    generatedTextHash,
    referenceId: reference.referenceId,
    taskId: data.taskId,
    status: data.status,
    audioPath: "",
    downloadedTaskId: "",
    textLength: data.textLength,
    estimatedQuota: data.estimatedQuota,
    needsPublish: true,
    generatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
}

async function createCollectiveTask(args, line, references, task) {
  if (
    args.regenerateCollectiveMember &&
    !line.members.some(
      member => member.speaker === args.regenerateCollectiveMember,
    )
  ) {
    throw new Error(
      `Collective line ${line.index} does not contain member ` +
        args.regenerateCollectiveMember,
    );
  }
  const members = {};
  const generationKey = textHash(JSON.stringify({
    text: line.text,
    members: line.members.map(member => ({
      speaker: member.speaker,
      referenceId: references[member.speaker]?.referenceId || "",
    })),
  }));

  for (const member of line.members) {
    const reference = references[member.speaker];
    if (!reference) {
      throw new Error(
        `Missing collective reference for ${member.speaker} at index ${line.index}`,
      );
    }
    const memberLine = {
      ...line,
      kind: "collective-member",
      speaker: member.speaker,
      sourceSpeaker: line.speaker,
      characterName: member.characterName,
    };
    members[member.speaker] = {
      ...await createTask(
        {
          ...args,
          force:
            args.force ||
            member.speaker === args.regenerateCollectiveMember,
        },
        memberLine,
        reference,
        task?.members?.[member.speaker],
      ),
      kind: "collective-member",
      collectiveSpeaker: line.speaker,
    };
  }

  const unchanged = task?.generationKey === generationKey;
  return {
    ...(unchanged ? task : {}),
    kind: "collective",
    index: line.index,
    speaker: line.speaker,
    sourceSpeaker: line.sourceSpeaker,
    characterName: line.characterName,
    text: line.text,
    generatedText: line.text,
    generatedTextHash: textHash(line.text),
    generationKey,
    memberOrder: line.members.map(member => member.speaker),
    members,
    mixConfig: line.mix || {},
    status: unchanged ? task.status : "PENDING",
    audioPath: unchanged ? task.audioPath : "",
    needsPublish: unchanged ? task.needsPublish : true,
    generatedAt: new Date().toISOString(),
    createdAt: unchanged ? task.createdAt : new Date().toISOString(),
  };
}

async function pollTasks({ args, manifest, storyId, taskKeys }) {
  let active = 0;
  for (const taskKey of taskKeys) {
    const task = manifest.tasks[taskKey];
    if (!task) continue;
    if (task.kind === "collective") {
      let memberActive = 0;
      let memberFailed = false;
      for (const member of Object.values(task.members || {})) {
        const result = await pollSingleTask({ args, task: member, storyId });
        memberActive += result.active;
        memberFailed ||= result.failed;
      }
      if (memberFailed) {
        task.status = "FAILED";
        task.retryCount = 2;
      } else if (memberActive > 0) {
        task.status = "PROCESSING";
        active += memberActive;
      } else {
        mixCollectiveTask({ args, task, storyId });
      }
      continue;
    }

    const result = await pollSingleTask({ args, task, storyId });
    active += result.active;
  }
  return { active };
}

async function pollSingleTask({ args, task, storyId }) {
  if (!task.taskId) {
    return { active: 0, failed: true };
  }
  const completedAudioExists = task.audioPath && fs.existsSync(task.audioPath);
  const npcEffectCurrent =
    task.speaker !== npcSpeakerKey ||
    task.audioEffectVersion === npcAudioEffectVersion;
  if (
    task.status === "COMPLETED" &&
    completedAudioExists &&
    npcEffectCurrent &&
    !args.force
  ) {
    return { active: 0, failed: false };
  }
  if (["FAILED", "CANCELLED"].includes(task.status)) {
    if (!task.retryCount || task.retryCount < 2) {
      console.log(
        `Task ${task.taskId} failed/cancelled. Retrying... ` +
          `(${task.retryCount || 0}/2)`,
      );
      const retryData = await apiRequest(args, "/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: task.text,
          referenceId: task.referenceId,
          model: args.model,
          format: "mp3",
          chunkLength: args.chunkLength,
          temperature: args.temperature,
          deliveryMode: "DOWNLOAD",
        }),
      });
      task.taskId = retryData.taskId;
      task.status = retryData.status;
      task.retryCount = (task.retryCount || 0) + 1;
      return { active: 1, failed: false };
    }
    console.error(
      `[ERROR] Task for index ${task.index} failed permanently: ` +
        `${task.errorMessage || task.status}`,
    );
    return { active: 0, failed: true };
  }

  const data = await apiRequest(args, `/tasks/${task.taskId}`);
  task.status = data.status;
  task.resultUrl = data.resultUrl;
  task.audioDuration = data.audioDuration;
  task.fileSize = data.fileSize;
  task.errorMessage = data.errorMessage;
  task.updatedAt = new Date().toISOString();

  if (task.status === "COMPLETED") {
    await downloadTaskAudio({ args, task, storyId });
    return { active: 0, failed: false };
  }
  if (!terminalTaskStatuses.has(task.status)) {
    return { active: 1, failed: false };
  }
  return { active: 0, failed: true };
}

async function downloadTaskAudio({ args, task, storyId }) {
  const audioPath = task.kind === "collective-member"
    ? path.join(
      args.localFileRoot,
      "tts",
      args.type,
      storyId,
      "collective",
      String(task.index).padStart(4, "0"),
      `${slugify(task.speaker)}.mp3`,
    )
    : path.join(
      args.localFileRoot,
      "tts",
      args.type,
      storyId,
      "lines",
      `${String(task.index).padStart(4, "0")}.mp3`,
    );
  if (
    !task.audioPath ||
    !fs.existsSync(audioPath) ||
    (task.downloadedTaskId && task.downloadedTaskId !== task.taskId) ||
    (task.speaker === npcSpeakerKey &&
      task.audioEffectVersion !== npcAudioEffectVersion) ||
    args.force
  ) {
    fs.mkdirSync(path.dirname(audioPath), { recursive: true });
    const response = await apiRequest(args, `/tasks/${task.taskId}/download`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const rawAudioPath = `${audioPath}.${task.taskId}.raw.mp3`;
    const temporaryAudioPath = `${audioPath}.${task.taskId}.part.mp3`;
    try {
      fs.writeFileSync(rawAudioPath, bytes);
      if (task.speaker === npcSpeakerKey) {
        const effect = buildNpcAudioEffect({ args, storyId, task });
        applyNpcAudioEffect(rawAudioPath, temporaryAudioPath, effect.filter);
        task.audioEffectVersion = npcAudioEffectVersion;
        task.audioEffectSeed = effect.seed;
        task.audioEffectParameters = effect.parameters;
      } else {
        fs.renameSync(rawAudioPath, temporaryAudioPath);
        delete task.audioEffectVersion;
        delete task.audioEffectSeed;
        delete task.audioEffectParameters;
      }
      fs.renameSync(temporaryAudioPath, audioPath);
    } finally {
      fs.rmSync(rawAudioPath, { force: true });
      fs.rmSync(temporaryAudioPath, { force: true });
    }
  }

  task.audioPath = audioPath;
  task.downloadedTaskId = task.taskId;
  task.downloadedText = taskGeneratedText(task);
  task.downloadedTextHash =
    task.generatedTextHash || textHash(task.downloadedText);
  task.downloadedAt = new Date().toISOString();
}

function mixCollectiveTask({ args, task, storyId }) {
  const memberOrder = Array.isArray(task.memberOrder)
    ? task.memberOrder
    : Object.keys(task.members || {});
  const members = memberOrder.map(speaker => task.members?.[speaker]);
  if (
    members.length < 2 ||
    members.some(member =>
      !member ||
      member.status !== "COMPLETED" ||
      !member.audioPath ||
      !fs.existsSync(member.audioPath)
    )
  ) {
    throw new Error(
      `Collective line ${task.index} cannot be mixed until every member completes`,
    );
  }

  const memberOverrides = task.mixConfig?.memberOverrides || {};
  const mixInputs = members.map(member => ({
    speaker: member.speaker,
    referenceId: member.referenceId,
    downloadedTaskId: member.downloadedTaskId,
    downloadedTextHash: member.downloadedTextHash,
    delayMs: Math.max(
      0,
      Math.round(Number(memberOverrides[member.speaker]?.delayMs || 0)),
    ),
    gainDb: Number(memberOverrides[member.speaker]?.gainDb || 0),
  }));
  const inputsHash = textHash(JSON.stringify({
    version: collectiveMixVersion,
    text: taskGeneratedText(task),
    inputs: mixInputs,
  }));
  const audioPath = path.join(
    args.localFileRoot,
    "tts",
    args.type,
    storyId,
    "lines",
    `${String(task.index).padStart(4, "0")}.mp3`,
  );
  if (
    !args.force &&
    task.mix?.version === collectiveMixVersion &&
    task.mix?.inputsHash === inputsHash &&
    fs.existsSync(audioPath)
  ) {
    task.status = "COMPLETED";
    task.audioPath = audioPath;
    return;
  }

  fs.mkdirSync(path.dirname(audioPath), { recursive: true });
  const temporaryAudioPath = `${audioPath}.${inputsHash}.part.mp3`;
  const ffmpegArgs = ["-y", "-hide_banner", "-loglevel", "warning"];
  for (const member of members) {
    ffmpegArgs.push("-i", member.audioPath);
  }
  const filters = mixInputs.map((input, index) =>
    `[${index}:a]aresample=44100,` +
      "aformat=sample_fmts=fltp:channel_layouts=mono," +
      `volume=${input.gainDb}dB,adelay=${input.delayMs}:all=1[a${index}]`,
  );
  filters.push(
    `${mixInputs.map((_, index) => `[a${index}]`).join("")}` +
      `amix=inputs=${mixInputs.length}:duration=longest:` +
      "dropout_transition=0:normalize=1," +
      "loudnorm=I=-16:TP=-1.5:LRA=8[out]",
  );
  ffmpegArgs.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[out]",
    "-ar",
    "44100",
    "-ac",
    "1",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "192k",
    temporaryAudioPath,
  );
  try {
    childProcess.execFileSync("ffmpeg", ffmpegArgs, { stdio: "ignore" });
    fs.renameSync(temporaryAudioPath, audioPath);
  } finally {
    fs.rmSync(temporaryAudioPath, { force: true });
  }

  task.status = "COMPLETED";
  task.audioPath = audioPath;
  task.audioDuration = Number(getAudioDuration(audioPath).toFixed(3));
  task.mix = {
    version: collectiveMixVersion,
    inputsHash,
    inputs: mixInputs,
    audioPath,
    mixedAt: new Date().toISOString(),
  };
  task.downloadedText = taskGeneratedText(task);
  task.downloadedTextHash = task.generatedTextHash;
  task.downloadedAt = new Date().toISOString();
  task.needsPublish = true;
}

function buildNpcAudioEffect({ args, storyId, task }) {
  const seed = `${args.type}:${storyId}:${task.index}:${textHash(taskGeneratedText(task))}`;
  const value = (name, min, max) => {
    const digest = crypto.createHash("sha256").update(`${seed}:${name}`).digest();
    const fraction = digest.readUInt32BE(0) / 0xffffffff;
    return min + (max - min) * fraction;
  };
  const parameters = {
    phaserDecay: Number(value("phaser-decay", 0.4, 0.52).toFixed(3)),
    phaserSpeed: Number(value("phaser-speed", 0.65, 1).toFixed(3)),
    flangerDepth: Number(value("flanger-depth", 2.7, 3.5).toFixed(3)),
    flangerRegen: Number(value("flanger-regen", 15, 22).toFixed(3)),
    flangerWidth: Number(value("flanger-width", 68, 82).toFixed(3)),
    flangerSpeed: Number(value("flanger-speed", 0.58, 0.85).toFixed(3)),
    tremoloFrequency: Number(value("tremolo-frequency", 19, 25).toFixed(3)),
    tremoloDepth: Number(value("tremolo-depth", 0.18, 0.27).toFixed(3)),
    crusherBits: Math.round(value("crusher-bits", 7, 9)),
    crusherMix: Number(value("crusher-mix", 0.24, 0.34).toFixed(3)),
    echoDelay: Number(value("echo-delay", 12, 18).toFixed(3)),
    echoDecay: Number(value("echo-decay", 0.13, 0.19).toFixed(3)),
  };
  const filter =
    "highpass=f=100,lowpass=f=9500," +
    "chorus=0.55:0.90:6|12|18:0.42|0.34|0.26:0.55|0.85|1.10:1.4|1.0|0.8," +
    "aphaser=in_gain=0.55:out_gain=0.80:delay=2:" +
      `decay=${parameters.phaserDecay}:speed=${parameters.phaserSpeed}:type=t,` +
    `flanger=delay=2:depth=${parameters.flangerDepth}:` +
      `regen=${parameters.flangerRegen}:width=${parameters.flangerWidth}:` +
      `speed=${parameters.flangerSpeed},` +
    `tremolo=f=${parameters.tremoloFrequency}:d=${parameters.tremoloDepth},` +
    `acrusher=bits=${parameters.crusherBits}:mix=${parameters.crusherMix},` +
    `aecho=0.6:0.35:${parameters.echoDelay}:${parameters.echoDecay},` +
    "acompressor=threshold=0.12:ratio=2:attack=15:release=180:makeup=1.4," +
    "loudnorm=I=-16:TP=-1.5:LRA=8";
  return { seed, parameters, filter };
}

function applyNpcAudioEffect(inputPath, outputPath, filter) {
  childProcess.execFileSync(
    "ffmpeg",
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "warning",
      "-i",
      inputPath,
      "-af",
      filter,
      "-ar",
      "44100",
      "-ac",
      "1",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "192k",
      outputPath,
    ],
    { stdio: "ignore" },
  );
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function removeLegacyLocalUrlFields(manifest) {
  delete manifest.localUrlPrefix;
  delete manifest.outputPath;

  for (const reference of Object.values(manifest.references || {})) {
    delete reference.audioUrl;
  }
  for (const task of Object.values(manifest.tasks || {})) {
    delete task.voiceUrl;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  if (!["prepare", "upload", "tasks", "poll", "all"].includes(args.stage)) {
    throw new Error("--stage must be one of prepare, upload, tasks, poll, all");
  }

  const storyPath = resolveStoryPath(args);
  if (!fs.existsSync(storyPath)) {
    throw new Error(`Story file not found: ${storyPath}`);
  }

  const storyId = storyIdFromPath(storyPath);
  const story = JSON.parse(fs.readFileSync(storyPath, "utf8"));
  if (!story || !Array.isArray(story.content)) {
    throw new Error("Story JSON must have a content array");
  }
  const collectiveConfig = loadCollectiveVoiceConfig(storyPath, story);
  const speakerMap = await loadSpeakerMap(args, story, collectiveConfig);
  const allVoiceLines = extractVoiceLines(
    story,
    speakerMap,
    collectiveConfig,
    0,
  );
  const manifestPath = resolveManifestPath(args, storyId);
  const loadedManifest = loadManifest(manifestPath);
  let voiceLines;
  if (args.regenerateCollectiveMember) {
    voiceLines = allVoiceLines.filter(line =>
      line.kind === "collective" &&
      line.members.some(
        member => member.speaker === args.regenerateCollectiveMember,
      ),
    );
    if (voiceLines.length === 0) {
      throw new Error(
        `No collective lines contain ${args.regenerateCollectiveMember}`,
      );
    }
  } else if (args.missingOnly) {
    voiceLines = allVoiceLines.filter(line =>
      !String(story.content[line.index].VoiceJp || "").trim(),
    );
  } else {
    voiceLines = args.changedOnly
      ? allVoiceLines.filter(line =>
        isChangedSincePublish(
          line,
          loadedManifest.tasks?.[String(line.index)],
          story.content[line.index],
        ),
      )
      : allVoiceLines;
  }
  if (args.limit > 0) {
    voiceLines = voiceLines.slice(0, args.limit);
  }
  const speakers = new Map();
  for (const line of voiceLines) {
    if (line.kind === "collective") {
      for (const member of line.members) {
        speakers.set(member.speaker, member.characterName);
      }
    } else {
      speakers.set(line.speaker, line.characterName);
    }
  }

  const manifest = {
    ...loadedManifest,
    ...buildManifestBase(args, storyPath, storyId, allVoiceLines),
  };
  manifest.references ||= {};
  manifest.tasks ||= {};
  manifest.collectiveVoiceConfig = {
    path: collectiveConfig.configPath,
    scanDigest: collectiveConfig.config.source.scanDigest,
    lineCount: collectiveConfig.linesByIndex.size,
    collectiveLineCount: [...collectiveConfig.linesByIndex.values()].filter(
      entry => entry.kind === "collective",
    ).length,
    unknownSpeakerLineCount: [
      ...collectiveConfig.linesByIndex.values(),
    ].filter(entry => entry.kind === "unknown-speaker").length,
  };
  removeLegacyLocalUrlFields(manifest);

  const plan = {
    stage: args.stage,
    model: args.model,
    storyPath,
    manifestPath,
    localFileRoot: path.resolve(args.localFileRoot),
    characterRoot: path.resolve(args.characterRoot),
    changedOnly: args.changedOnly,
    missingOnly: args.missingOnly,
    regenerateCollectiveMember: args.regenerateCollectiveMember || null,
    totalVoiceLines: allVoiceLines.length,
    selectedVoiceLines: voiceLines.length,
    selectedIndices: voiceLines.map(line => line.index),
    selectedCollectiveLines: voiceLines
      .filter(line => line.kind === "collective")
      .map(line => ({
        index: line.index,
        speaker: line.speaker,
        members: line.members.map(member => member.speaker),
      })),
    selectedUnknownSpeakerLines: voiceLines
      .filter(line =>
        ["resolved-speaker", "anonymous"].includes(line.kind),
      )
      .map(line => ({
        index: line.index,
        resolution:
          line.kind === "resolved-speaker" ? "character" : "anonymous",
        resolvedSpeaker: line.resolvedSpeaker,
        referenceSpeaker: line.speaker,
      })),
    speakers: [...speakers.entries()].map(([speaker, characterName]) => ({
      speaker,
      characterName,
    })),
    dryRun: args.dryRun,
  };
  console.log(JSON.stringify(plan, null, 2));

  if (args.missingOnly && voiceLines.length === 0) {
    console.log("No missing voice lines.");
    return;
  }

  if (
    !args.dryRun &&
    ["prepare", "upload", "tasks", "all"].includes(args.stage)
  ) {
    for (const [speaker, characterName] of speakers) {
      const reference = prepareReferenceAudio({
        args,
        speaker,
        characterName,
        manifest,
      });
      console.log(
        `Reference ${speaker} -> ${characterName}: ` +
          `${reference.totalDuration}s, ${reference.clips.length} clips`
      );
    }
    saveManifest(manifestPath, manifest);
  }

  if (args.stage === "prepare" || args.dryRun) {
    return;
  }

  if (["upload", "tasks", "all"].includes(args.stage)) {
    for (const speaker of speakers.keys()) {
      manifest.references[speaker] = await uploadReference(
        args,
        manifest.references[speaker]
      );
      console.log(
        `Uploaded ${speaker}: referenceId=${manifest.references[speaker].referenceId}`
      );
      saveManifest(manifestPath, manifest);
    }
  }

  if (["tasks", "all"].includes(args.stage)) {
    for (const line of voiceLines) {
      const taskKey = String(line.index);
      if (line.kind === "collective") {
        manifest.tasks[taskKey] = await createCollectiveTask(
          args,
          line,
          manifest.references,
          manifest.tasks[taskKey],
        );
        console.log(
          `Collective task ${line.index}: ` +
            manifest.tasks[taskKey].memberOrder.join(", "),
        );
      } else {
        const reference = manifest.references[line.speaker];
        manifest.tasks[taskKey] = await createTask(
          args,
          line,
          reference,
          manifest.tasks[taskKey],
        );
        console.log(`Task ${line.index}: ${manifest.tasks[taskKey].taskId}`);
      }
      saveManifest(manifestPath, manifest);
    }
  }

  if (["poll", "all"].includes(args.stage)) {
    const pollStarted = Date.now();
    const taskKeys = voiceLines.map(line => String(line.index));
    let failedTasksCount = 0;
    while (true) {
      const { active } = await pollTasks({
        args,
        manifest,
        storyId,
        taskKeys,
      });
      saveManifest(manifestPath, manifest);
      console.log(`Polling round done, active tasks: ${active}`);

      failedTasksCount = taskKeys
        .map(taskKey => manifest.tasks[taskKey])
        .filter(
          task => task &&
          ["FAILED", "CANCELLED"].includes(task.status) && task.retryCount >= 2,
        ).length;

      if (active === 0) {
        break;
      }
      if ((Date.now() - pollStarted) / 1000 > args.pollTimeout) {
        throw new Error(`Polling timed out after ${args.pollTimeout}s`);
      }
      await sleep(args.pollInterval * 1000);
    }

    if (failedTasksCount > 0) {
      console.error(
        `\n[CRITICAL ERROR] Finished polling, but ${failedTasksCount} tasks ` +
          "permanently failed to generate voice! Please check the logs above.",
      );
      process.exit(1);
    }
  }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
