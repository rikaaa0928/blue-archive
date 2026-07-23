import childProcess from "child_process";
import fs from "fs";
import path from "path";
import url from "url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..", "..");
const repoRoot = path.resolve(appRoot, "..", "..");
loadEnvFile(path.join(appRoot, ".env"));
loadEnvFile(path.join(repoRoot, ".env"));

const defaultDownloaderOutput =
  "/Users/rikaaa0928/src/yling/ai/skill/ba-video-generator-v3/ba-downloader/output";
const defaultDownloaderScript =
  "/Users/rikaaa0928/src/yling/ai/skill/ba-video-generator-v3/ba-downloader/download.py";
const defaultTtsBaseUrl = "https://yiling.top/api/tts";
const defaultModel = "zerotts-v1";
const localUrlPrefix = "/api/local-files";

const flatStoryTypes = new Set(["main", "other"]);
const nestedStoryTypes = new Set(["favor", "event", "group", "mini"]);
const audioExtensions = new Set([".flac", ".m4a", ".mp3", ".ogg", ".opus", ".wav"]);
const terminalTaskStatuses = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
const defaultSpeakerMap = {
  "준코": "淳子",
  "아카리": "明里",
  "하루나": "晴奈",
  "이즈미": "泉",
  "히나": "日奈",
  "치나츠": "千夏",
  "이오리": "伊织",
};

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
  --stage poll              poll existing tasks, download mp3, update VoiceJp
  --stage all               prepare, upload, create tasks, poll until done

Options:
  --type <type>             story type when source is an id, default: group
  --directory-id <id>       directory id for favor/event/group/mini
  --output <file>           story JSON to write, default: overwrite source
  --manifest <file>         workflow manifest path, default under .local-files
  --downloader-output <dir> ba-downloader output dir
  --downloader-script <file> existing Python downloader script
  --local-file-root <dir>   local file service root, default: .local-files
  --speaker-map <file>      JSON object mapping script speaker to character dir
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
  --download-missing        call existing Python downloader when a character is missing
  --dry-run                 print plan without network calls or writing story JSON
  --help, -h                show this help

Environment:
  ZERO_TTS_API_KEY / OZX_TTS_API_KEY / YILING_TTS_API_TOKEN
  ZERO_TTS_BASE_URL
  BA_DOWNLOADER_OUTPUT
  BA_LOCAL_FILE_ROOT

Examples:
  pnpm voice-zero-tts 1101 --type group --stage prepare
  pnpm voice-zero-tts 1101 --type group --stage all --limit 3
`);
}

function parseArgs(argv) {
  const args = {
    source: "",
    type: "group",
    directoryId: "",
    output: "",
    manifest: "",
    downloaderOutput: process.env.BA_DOWNLOADER_OUTPUT || defaultDownloaderOutput,
    downloaderScript: process.env.BA_DOWNLOADER_SCRIPT || defaultDownloaderScript,
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
    downloadMissing: false,
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
      case "--output":
        args.output = readOptionValue(argv, ++index, arg);
        break;
      case "--manifest":
        args.manifest = readOptionValue(argv, ++index, arg);
        break;
      case "--downloader-output":
        args.downloaderOutput = readOptionValue(argv, ++index, arg);
        break;
      case "--downloader-script":
        args.downloaderScript = readOptionValue(argv, ++index, arg);
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
      case "--download-missing":
        args.downloadMissing = true;
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

function loadSpeakerMap(args) {
  if (!args.speakerMap) {
    return defaultSpeakerMap;
  }
  const parsed = JSON.parse(fs.readFileSync(path.resolve(args.speakerMap), "utf8"));
  return { ...defaultSpeakerMap, ...parsed };
}

function extractVoiceLines(story, speakerMap, limit) {
  const lines = [];
  for (let index = 0; index < story.content.length; index++) {
    const unit = story.content[index];
    const text = String(unit.TextJpVoice || unit.TextJp || "").trim();
    if (!text) continue;

    const speakers = inferSpeakers(unit);
    if (speakers.length === 0) continue;

    const speaker = speakers[0];
    lines.push({
      index,
      speaker,
      characterName: speakerMap[speaker] || speaker,
      text,
      textCn: String(unit.TextCn || ""),
      scriptKr: String(unit.ScriptKr || ""),
      existingVoiceJp: String(unit.VoiceJp || ""),
      extraSpeakers: speakers.slice(1),
    });
  }

  return limit > 0 ? lines.slice(0, limit) : lines;
}

function inferSpeakers(unit) {
  const script = String(unit.ScriptKr || "");
  const speakers = [];
  for (const line of script.split("\n")) {
    const match = /^(?!#)([1-5]);([^;\n]+);/.exec(line.trim());
    if (match && !speakers.includes(match[2])) {
      speakers.push(match[2]);
    }
  }
  return speakers;
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

function buildManifestBase(args, storyPath, outputPath, storyId, voiceLines) {
  return {
    storyId,
    storyType: args.type,
    storyPath,
    outputPath,
    localFileRoot: path.resolve(args.localFileRoot),
    localUrlPrefix,
    ttsBaseUrl: args.ttsBaseUrl.replace(/\/+$/, ""),
    model: args.model,
    createdAt: new Date().toISOString(),
    voiceLineCount: voiceLines.length,
  };
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

function prepareReferenceAudio({ args, storyId, speaker, characterName, manifest }) {
  const referenceKey = speaker;
  const existing = manifest.references[referenceKey];
  if (existing?.audioPath && fs.existsSync(existing.audioPath) && !args.force) {
    return existing;
  }

  const characterDir = path.join(args.downloaderOutput, characterName);
  if (!fs.existsSync(characterDir)) {
    if (!args.downloadMissing || args.dryRun) {
      throw new Error(
        `Missing downloader output for ${speaker} -> ${characterName}: ${characterDir}`
      );
    }
    downloadMissingCharacter(args, characterName);
    if (!fs.existsSync(characterDir)) {
      throw new Error(
        `Downloader finished but output is still missing: ${characterDir}`
      );
    }
  }

  const candidates = scanVoiceCandidates(characterDir, args);
  const clips = selectReferenceClips(candidates, args);
  const speakerSlug = slugify(`${speaker}_${characterName}`);
  const outputDir = path.join(
    args.localFileRoot,
    "tts",
    args.type,
    storyId,
    "references",
    speakerSlug
  );
  const audioPath = path.join(outputDir, "reference.mp3");
  const textPath = path.join(outputDir, "reference.txt");
  const manifestPath = path.join(outputDir, "reference-manifest.json");
  const referenceText = clips.map(clip => clip.text).join("\n\n");
  const audioUrl = toLocalUrl(args.localFileRoot, audioPath);

  if (!args.dryRun) {
    fs.mkdirSync(outputDir, { recursive: true });
    concatenateAudio(clips, audioPath, args.referenceGap);
    fs.writeFileSync(textPath, `${referenceText}\n`);
    fs.writeFileSync(
      manifestPath,
      `${JSON.stringify({ speaker, characterName, clips }, null, 2)}\n`
    );
  }

  const totalDuration = clips.reduce((sum, clip) => sum + clip.duration, 0);
  const gapDuration = Math.max(0, clips.length - 1) * args.referenceGap;
  const prepared = {
    speaker,
    characterName,
    audioPath,
    audioUrl,
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
  manifest.references[referenceKey] = {
    ...existing,
    ...prepared,
  };
  return manifest.references[referenceKey];
}

function downloadMissingCharacter(args, characterName) {
  if (!fs.existsSync(args.downloaderScript)) {
    throw new Error(`Downloader script not found: ${args.downloaderScript}`);
  }

  console.log(`Downloading missing character resources: ${characterName}`);
  childProcess.execFileSync(
    "uv",
    [
      "run",
      args.downloaderScript,
      characterName,
      "--output",
      path.resolve(args.downloaderOutput),
    ],
    {
      cwd: path.dirname(args.downloaderScript),
      stdio: "inherit",
    }
  );
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

function toLocalUrl(localFileRoot, filePath) {
  const relativePath = path.relative(path.resolve(localFileRoot), path.resolve(filePath));
  return `${localUrlPrefix}/${relativePath.split(path.sep).map(encodeURIComponent).join("/")}`;
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
  if (reference.referenceId && !args.force) {
    return reference;
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

async function createTask(args, line, reference, task) {
  if (task?.taskId && !args.force) {
    return task;
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
    index: line.index,
    speaker: line.speaker,
    characterName: line.characterName,
    text: line.text,
    referenceId: reference.referenceId,
    taskId: data.taskId,
    status: data.status,
    textLength: data.textLength,
    estimatedQuota: data.estimatedQuota,
    createdAt: new Date().toISOString(),
  };
}

async function pollTasks({ args, manifest, story, outputPath }) {
  const started = Date.now();
  while (true) {
    let active = 0;
    let changed = false;

    for (const task of Object.values(manifest.tasks)) {
      if (!task.taskId) continue;
      const completedAudioExists = task.audioPath && fs.existsSync(task.audioPath);
      if (task.status === "COMPLETED" && completedAudioExists && !args.force) {
        continue;
      }
      if (["FAILED", "CANCELLED"].includes(task.status)) {
        continue;
      }

      const data = await apiRequest(args, `/tasks/${task.taskId}`);
      task.status = data.status;
      task.resultUrl = data.resultUrl;
      task.audioDuration = data.audioDuration;
      task.fileSize = data.fileSize;
      task.errorMessage = data.errorMessage;
      task.updatedAt = new Date().toISOString();
      changed = true;

      if (task.status === "COMPLETED") {
        await downloadTaskAudio({ args, task, story, outputPath });
      } else if (!terminalTaskStatuses.has(task.status)) {
        active++;
      }
    }

    if (changed) {
      return { active };
    }

    if (active === 0) {
      return { active };
    }

    if ((Date.now() - started) / 1000 > args.pollTimeout) {
      throw new Error(`Polling timed out after ${args.pollTimeout}s`);
    }

    await sleep(args.pollInterval * 1000);
  }
}

async function downloadTaskAudio({ args, task, story, outputPath }) {
  const audioPath = path.join(
    args.localFileRoot,
    "tts",
    args.type,
    String(story.GroupId || "story"),
    "lines",
    `${String(task.index).padStart(4, "0")}.mp3`
  );
  if (!fs.existsSync(audioPath) || args.force) {
    fs.mkdirSync(path.dirname(audioPath), { recursive: true });
    const response = await apiRequest(args, `/tasks/${task.taskId}/download`);
    const bytes = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(audioPath, bytes);
  }

  task.audioPath = audioPath;
  task.voiceUrl = toLocalUrl(args.localFileRoot, audioPath);
  story.content[task.index].VoiceJp = task.voiceUrl;
  fs.writeFileSync(outputPath, `${JSON.stringify(story, null, 2)}\n`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

  const outputPath = args.output ? path.resolve(process.cwd(), args.output) : storyPath;
  const storyId = storyIdFromPath(storyPath);
  const story = JSON.parse(fs.readFileSync(storyPath, "utf8"));
  const speakerMap = loadSpeakerMap(args);
  const voiceLines = extractVoiceLines(story, speakerMap, args.limit);
  const speakers = new Map();
  for (const line of voiceLines) {
    speakers.set(line.speaker, line.characterName);
  }

  const manifestPath = resolveManifestPath(args, storyId);
  const manifest = {
    ...buildManifestBase(args, storyPath, outputPath, storyId, voiceLines),
    ...loadManifest(manifestPath),
  };
  manifest.references ||= {};
  manifest.tasks ||= {};

  const plan = {
    stage: args.stage,
    storyPath,
    outputPath,
    manifestPath,
    localFileRoot: path.resolve(args.localFileRoot),
    downloaderOutput: args.downloaderOutput,
    downloaderScript: args.downloaderScript,
    downloadMissing: args.downloadMissing,
    speakers: [...speakers.entries()].map(([speaker, characterName]) => ({
      speaker,
      characterName,
    })),
    voiceLines: voiceLines.length,
    dryRun: args.dryRun,
  };
  console.log(JSON.stringify(plan, null, 2));

  if (["prepare", "upload", "tasks", "all"].includes(args.stage)) {
    for (const [speaker, characterName] of speakers) {
      const reference = prepareReferenceAudio({
        args,
        storyId,
        speaker,
        characterName,
        manifest,
      });
      console.log(
        `Reference ${speaker} -> ${characterName}: ` +
          `${reference.totalDuration}s, ${reference.clips.length} clips`
      );
    }
    if (!args.dryRun) {
      saveManifest(manifestPath, manifest);
    }
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
      const reference = manifest.references[line.speaker];
      const taskKey = String(line.index);
      manifest.tasks[taskKey] = await createTask(
        args,
        line,
        reference,
        manifest.tasks[taskKey]
      );
      console.log(`Task ${line.index}: ${manifest.tasks[taskKey].taskId}`);
      saveManifest(manifestPath, manifest);
    }
  }

  if (["poll", "all"].includes(args.stage)) {
    while (true) {
      const { active } = await pollTasks({ args, manifest, story, outputPath });
      saveManifest(manifestPath, manifest);
      console.log(`Polling round done, active tasks: ${active}`);
      if (active === 0) {
        break;
      }
      await sleep(args.pollInterval * 1000);
    }
  }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
