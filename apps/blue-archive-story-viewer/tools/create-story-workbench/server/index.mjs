import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { build as buildFrontend } from "vite";

import { getJob, listJobs, listRunningJobs, startJob } from "./lib/jobs.mjs";
import { prerequisiteStageForJob } from "./lib/job-policy.mjs";
import { createBatch, getBatch, listBatches, listRunningBatches, resumeBatch } from "./lib/batches.mjs";
import {
  createCoverBatch,
  getCoverBatch,
  listCoverBatches,
  listRunningCoverBatches,
  resolveCoverSeries,
  selectCoverCandidate,
} from "./lib/cover-batches.mjs";
import { reconcileWorkspace } from "./lib/reconcile.mjs";
import {
  approveCn,
  approveVoiceScript,
  buildProductionStory,
  completeProductionPreview,
  editCn,
  editVoiceScript,
  getCnRun,
  getVoiceScriptRun,
  getProduction,
  hasProduction,
  productionInputStory,
  productionPaths,
  revokeCnApproval,
  revokeVoiceScriptApproval,
  materializeProductionStory,
  setVoiceScriptSkip,
  updateProductionBranches,
  updateSpeakerResolution,
  writeReferenceArtifact,
} from "./lib/production.mjs";
import { approveReview, openReview, reviewSummary, updateReview } from "./lib/reviews.mjs";
import { resolveEventSeries } from "./lib/series.mjs";
import { parseScenarioScriptSpeakers } from "../../create-story/scenario-script-speakers.mjs";
import {
  appRoot, assertInsideDirectory, effectiveTtsText,
  loadEnvFiles, localFilesRoot, readJson, resolveTtsSkippedIndices, workbenchRoot,
  writeJsonAtomic,
} from "./lib/utils.mjs";
import {
  createRevision,
  createProductionVersion,
  activateVersion,
  ensureWorkspace,
  getLatestRevisionForStage,
  getRevision,
  listRevisions,
  loadDraft,
  listWorkspaces,
  loadWorkspace,
  versionResourcePath,
  versionTtsManifestPath,
  workflowStageIds,
} from "./lib/workspaces.mjs";

loadEnvFiles();

const host = "127.0.0.1";
const port = Number(process.env.STORY_WORKBENCH_PORT || 4178);
const resourceAudioExtensions = new Set([".flac", ".m4a", ".mp3", ".ogg", ".opus", ".wav"]);
const automaticActions = new Set([
  "production-prepare", "production-cn-generate", "production-speaker-scan",
  "production-voice-script-generate", "production-reference-prepare", "production-tts",
  "production-record",
  "production-cover-generate",
  "production-event-index",
  "raw-import", "cn-normalize", "cn-llm-1", "cn-llm-2", "voice-catalog", "voice-draft",
  "tts", "tts-line-revise", "tts-line-skip", "r2", "release-validate", "publish",
  "download-character",
  "download-missing-characters",
  "voice-regenerate",
  "sync", "event-index", "record",
]);
const confirmationActions = new Set([
  "production-cn-generate", "production-voice-script-generate",
  "production-reference-prepare", "production-tts",
  "production-cover-generate",
  "raw-import", "cn-llm-1", "cn-llm-2", "voice-catalog", "voice-draft", "r2", "publish",
  "download-character",
  "download-missing-characters",
  "voice-regenerate",
  "tts-line-revise",
  "sync", "event-index",
]);

function sendJson(response, status, value) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(value)}\n`);
}

function withLogTail(item, limit = 12000) {
  const log = String(item.log ?? "");
  return { ...item, log: log.length > limit ? `…日志前部已省略…\n${log.slice(-limit)}` : log };
}

function runningTaskSnapshot() {
  const jobs = [];
  for (const workspace of listWorkspaces().filter(item => !item.corrupt)) {
    try {
      for (const job of listRunningJobs(workspace.id)) {
        jobs.push(withLogTail({
          ...job,
          workspaceIdentity: workspace.identity,
        }));
      }
    } catch {}
  }
  const batches = [...listRunningBatches(), ...listRunningCoverBatches()]
    .map(batch => withLogTail(batch));
  return { jobs, batches };
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error("Request body exceeds 2 MiB");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function readBuffer(request, limit = 25 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error(`Request body exceeds ${Math.round(limit / 1024 / 1024)} MiB`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function routeMatch(pathname, expression) {
  const match = expression.exec(pathname);
  return match
    ? match.slice(1).map(value => value === undefined ? undefined : decodeURIComponent(value))
    : null;
}

function serveMedia(request, response, mediaPath, contentType) {
  const stat = fs.statSync(mediaPath);
  const range = /^bytes=(\d*)-(\d*)$/u.exec(String(request.headers.range ?? ""));
  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("Content-Type", contentType);
  response.setHeader("Cache-Control", "private, no-store");
  if (!range) {
    response.statusCode = 200;
    response.setHeader("Content-Length", stat.size);
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    fs.createReadStream(mediaPath).pipe(response);
    return;
  }
  const suffixLength = !range[1] && range[2] ? Number(range[2]) : null;
  const start = suffixLength === null
    ? Number(range[1])
    : Math.max(0, stat.size - suffixLength);
  const end = suffixLength === null && range[2]
    ? Math.min(Number(range[2]), stat.size - 1)
    : stat.size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= stat.size) {
    response.statusCode = 416;
    response.setHeader("Content-Range", `bytes */${stat.size}`);
    response.end();
    return;
  }
  response.statusCode = 206;
  response.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
  response.setHeader("Content-Length", end - start + 1);
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  fs.createReadStream(mediaPath, { start, end }).pipe(response);
}

function serveAudio(request, response, audioPath) {
  serveMedia(request, response, audioPath, "audio/mpeg");
}

async function handleApi(request, response, parsedUrl) {
  const { pathname } = parsedUrl;
  if (request.method === "GET" && pathname === "/api/series/event") {
    const query = parsedUrl.searchParams.get("query");
    if (!query) throw new Error("An event id, GroupId, or event name is required");
    sendJson(response, 200, { series: resolveEventSeries(query) });
    return true;
  }
  if (request.method === "GET" && pathname === "/api/cover-series/event") {
    const query = parsedUrl.searchParams.get("query");
    if (!query) throw new Error("An event id, GroupId, or event name is required");
    sendJson(response, 200, { series: resolveCoverSeries(query) });
    return true;
  }
  if (request.method === "GET" && pathname === "/api/cover-batches") {
    sendJson(response, 200, { batches: listCoverBatches().map(batch => withLogTail(batch)) });
    return true;
  }
  if (request.method === "POST" && pathname === "/api/cover-batches") {
    const body = await readBody(request);
    if (body.confirmed !== true) {
      sendJson(response, 409, {
        error: "confirmation-required",
        message: "系列封面会连续调用 Gemini 分析、图片生成和视觉复检，请先确认章节与费用范围。",
      });
      return true;
    }
    sendJson(response, 202, { batch: createCoverBatch(body) });
    return true;
  }
  let coverBatchMatch = routeMatch(pathname, /^\/api\/cover-batches\/([^/]+)$/u);
  if (request.method === "GET" && coverBatchMatch) {
    sendJson(response, 200, { batch: withLogTail(getCoverBatch(coverBatchMatch[0])) });
    return true;
  }
  if (request.method === "POST" && pathname === "/api/covers/reveal") {
    const body = await readBody(request);
    const name = path.basename(String(body.name ?? ""));
    if (!/^\d+.*\.(?:jpe?g|png|webp)$/iu.test(name)) throw new Error("Invalid cover candidate name");
    const coverRoot = path.join(localFilesRoot, "covers");
    const coverPath = assertInsideDirectory(coverRoot, path.join(coverRoot, name), "cover candidate");
    if (!fs.existsSync(coverPath) || !fs.statSync(coverPath).isFile()) throw new Error("Cover candidate does not exist");
    if (process.platform !== "darwin") throw new Error("Reveal in Finder is only available on macOS");
    const revealed = spawnSync("open", ["-R", coverPath], { stdio: "ignore" });
    if (revealed.error) throw revealed.error;
    if (revealed.status !== 0) throw new Error(`Finder failed with exit code ${revealed.status}`);
    sendJson(response, 200, { path: coverPath, directory: coverRoot });
    return true;
  }
  let coverMediaMatch = routeMatch(pathname, /^\/api\/covers\/(\d+)\/([^/]+)$/u);
  if (request.method === "GET" && coverMediaMatch) {
    const [storyId, rawName] = coverMediaMatch;
    const name = path.basename(rawName);
    if (!name.startsWith(storyId) || !/\.(?:jpe?g|png|webp)$/iu.test(name)) {
      throw new Error("Cover does not belong to this story");
    }
    const coverPath = path.join(localFilesRoot, "covers", name);
    if (!fs.existsSync(coverPath)) throw new Error("Cover does not exist");
    const contentType = name.endsWith(".png") ? "image/png" : name.endsWith(".webp") ? "image/webp" : "image/jpeg";
    serveMedia(request, response, coverPath, contentType);
    return true;
  }
  let coverSelectionMatch = routeMatch(pathname, /^\/api\/covers\/(\d+)\/select$/u);
  if (request.method === "POST" && coverSelectionMatch) {
    const body = await readBody(request);
    sendJson(response, 200, selectCoverCandidate(coverSelectionMatch[0], body.name));
    return true;
  }
  if (request.method === "GET" && pathname === "/api/batches") {
    sendJson(response, 200, { batches: listBatches() });
    return true;
  }
  if (request.method === "POST" && pathname === "/api/batches") {
    const body = await readBody(request);
    if (body.confirmed !== true) {
      sendJson(response, 409, {
        error: "confirmation-required",
        message: "批处理会串行调用远端 LLM，请先确认所选章节与执行范围。",
      });
      return true;
    }
    sendJson(response, 202, { batch: createBatch(body) });
    return true;
  }
  let batchMatch = routeMatch(pathname, /^\/api\/batches\/([^/]+)$/u);
  if (request.method === "GET" && batchMatch) {
    sendJson(response, 200, { batch: getBatch(batchMatch[0]) });
    return true;
  }
  batchMatch = routeMatch(pathname, /^\/api\/batches\/([^/]+)\/resume$/u);
  if (request.method === "POST" && batchMatch) {
    const body = await readBody(request);
    if (body.confirmed !== true) {
      sendJson(response, 409, {
        error: "confirmation-required",
        message: "继续推进可能调用远端 LLM 或日语配音稿生成，请先确认。",
      });
      return true;
    }
    sendJson(response, 202, { batch: resumeBatch(batchMatch[0]) });
    return true;
  }
  if (request.method === "GET" && pathname === "/api/workspaces") {
    sendJson(response, 200, { workspaces: listWorkspaces() });
    return true;
  }
  if (request.method === "GET" && pathname === "/api/jobs/running") {
    sendJson(response, 200, runningTaskSnapshot());
    return true;
  }
  if (request.method === "POST" && pathname === "/api/workspaces") {
    const body = await readBody(request);
    const workspace = ensureWorkspace(body);
    sendJson(response, 201, { workspace, status: reconcileWorkspace(workspace.id) });
    return true;
  }
  let match = routeMatch(pathname, /^\/api\/workspaces\/([^/]+)\/status$/u);
  if (request.method === "GET" && match) {
    sendJson(response, 200, reconcileWorkspace(match[0]));
    return true;
  }
  match = routeMatch(pathname, /^\/api\/workspaces\/([^/]+)\/production\/tts\/lines$/u);
  if (request.method === "GET" && match) {
    const production = getProduction(match[0], { includeStory: false, includeHistory: false });
    const paths = productionPaths(match[0]);
    const manifest = readJson(paths.ttsManifest, { tasks: {} });
    const story = productionInputStory(match[0], { includeCn: true, includeScript: true });
    const tasks = manifest.tasks ?? {};
    const audioIndex = parsedUrl.searchParams.get("audio");
    if (audioIndex !== null) {
      if (!/^\d+$/u.test(audioIndex) || !production.voice.tts.current) {
        throw new Error("No current generated audio is available");
      }
      const task = tasks[audioIndex];
      const audioPath = task?.audioPath
        ? assertInsideDirectory(localFilesRoot, task.audioPath, "TTS audio path")
        : "";
      if (!audioPath || !fs.existsSync(audioPath) || String(task.status).toUpperCase() !== "COMPLETED") {
        throw new Error(`No completed audio for line ${audioIndex}`);
      }
      serveAudio(request, response, audioPath);
      return true;
    }
    const skipped = new Set(production.voice.script.effectiveSkippedIndices);
    const indices = [...new Set([
      ...Object.keys(tasks).map(Number).filter(Number.isSafeInteger),
      ...skipped,
    ])].sort((left, right) => left - right);
    sendJson(response, 200, {
      current: production.voice.tts.current,
      lines: indices.map(index => {
        const task = tasks[String(index)] ?? null;
        const skippedLine = skipped.has(index);
        const audioReady = Boolean(production.voice.tts.current && !skippedLine &&
          String(task?.status).toUpperCase() === "COMPLETED" && task?.audioPath &&
          fs.existsSync(task.audioPath));
        return {
          index,
          speaker: String(task?.speaker ?? parseScenarioScriptSpeakers(story.content[index]).dialogueSpeaker ?? ""),
          textCn: String(story.content[index]?.TextCn ?? ""),
          ttsText: effectiveTtsText(story.content[index]),
          skipped: skippedLine,
          status: skippedLine ? "SKIPPED" : String(task?.status ?? "NOT_CREATED"),
          audioReady,
          audioUrl: audioReady ? `${pathname}?audio=${index}&token=${encodeURIComponent(String(task.downloadedTaskId || task.taskId || "audio"))}` : null,
          error: String(task?.errorMessage ?? ""),
        };
      }),
    });
    return true;
  }
  match = routeMatch(pathname, /^\/api\/workspaces\/([^/]+)\/production$/u);
  if (request.method === "GET" && match) {
    sendJson(response, 200, hasProduction(match[0])
      ? { exists: true, production: getProduction(match[0]) }
      : { exists: false, production: null });
    return true;
  }
  match = routeMatch(pathname, /^\/api\/workspaces\/([^/]+)\/production\/context-story$/u);
  if (request.method === "GET" && match) {
    if (!hasProduction(match[0])) throw new Error("Prepare the independent-track production first");
    sendJson(response, 200, { story: productionInputStory(match[0]) });
    return true;
  }
  match = routeMatch(pathname, /^\/api\/workspaces\/([^/]+)\/production\/cn\/approve$/u);
  if (request.method === "POST" && match) {
    const body = await readBody(request);
    sendJson(response, 200, { production: approveCn(match[0], body.runId, body.note) });
    return true;
  }
  match = routeMatch(pathname, /^\/api\/workspaces\/([^/]+)\/production\/cn\/runs\/([^/]+)$/u);
  if (request.method === "GET" && match) {
    sendJson(response, 200, { run: getCnRun(match[0], match[1]) });
    return true;
  }
  match = routeMatch(pathname, /^\/api\/workspaces\/([^/]+)\/production\/cn\/revoke-approval$/u);
  if (request.method === "POST" && match) {
    sendJson(response, 200, { production: revokeCnApproval(match[0]) });
    return true;
  }
  match = routeMatch(pathname, /^\/api\/workspaces\/([^/]+)\/production\/cn$/u);
  if (request.method === "PATCH" && match) {
    const body = await readBody(request);
    sendJson(response, 200, {
      production: editCn(match[0], body.changes, body.note),
    });
    return true;
  }
  match = routeMatch(pathname, /^\/api\/workspaces\/([^/]+)\/production\/voice-script\/approve$/u);
  if (request.method === "POST" && match) {
    const body = await readBody(request);
    sendJson(response, 200, { production: approveVoiceScript(match[0], body.runId, body.note) });
    return true;
  }
  match = routeMatch(pathname, /^\/api\/workspaces\/([^/]+)\/production\/voice-script\/runs\/([^/]+)$/u);
  if (request.method === "GET" && match) {
    sendJson(response, 200, { run: getVoiceScriptRun(match[0], match[1]) });
    return true;
  }
  match = routeMatch(pathname, /^\/api\/workspaces\/([^/]+)\/production\/voice-script\/revoke-approval$/u);
  if (request.method === "POST" && match) {
    sendJson(response, 200, { production: revokeVoiceScriptApproval(match[0]) });
    return true;
  }
  match = routeMatch(pathname, /^\/api\/workspaces\/([^/]+)\/production\/voice-script$/u);
  if (request.method === "PATCH" && match) {
    const body = await readBody(request);
    sendJson(response, 200, {
      production: editVoiceScript(match[0], body.changes, body.note),
    });
    return true;
  }
  match = routeMatch(pathname, /^\/api\/workspaces\/([^/]+)\/production\/voice-script\/skip$/u);
  if (request.method === "POST" && match) {
    const body = await readBody(request);
    sendJson(response, 200, {
      production: setVoiceScriptSkip(match[0], body.index, body.skipped, body.note),
    });
    return true;
  }
  match = routeMatch(pathname, /^\/api\/workspaces\/([^/]+)\/production\/speakers\/([^/]+)$/u);
  if (request.method === "PATCH" && match) {
    const body = await readBody(request);
    sendJson(response, 200, {
      production: updateSpeakerResolution(match[0], match[1], body.resolution, body.note),
    });
    return true;
  }
  match = routeMatch(pathname, /^\/api\/workspaces\/([^/]+)\/production\/references$/u);
  if (request.method === "PUT" && match) {
    const body = await readBody(request);
    sendJson(response, 200, {
      production: writeReferenceArtifact(match[0], body.selections, {
        note: body.note,
        source: "human-fine-tune",
      }),
    });
    return true;
  }
  match = routeMatch(pathname, /^\/api\/workspaces\/([^/]+)\/production\/references\/([^/]+)$/u);
  if (request.method === "GET" && match) {
    const production = getProduction(match[0], { includeStory: false, includeHistory: false });
    const speaker = match[1];
    const resolved = production.voice.speakers.items
      .map(item => item.resolution)
      .find(resolution => resolution?.type === "character" && resolution.stableKey === speaker);
    if (!resolved) throw new Error(`No character resolution exists for ${speaker}`);
    const voiceDirectory = path.join(localFilesRoot, "ba-characters", resolved.characterName, "语音");
    if (!fs.existsSync(voiceDirectory)) throw new Error(`Character resources are missing for ${resolved.characterName}`);
    const audioName = parsedUrl.searchParams.get("audio");
    if (audioName) {
      const candidate = assertInsideDirectory(voiceDirectory, path.join(voiceDirectory, audioName), "reference clip");
      if (!fs.existsSync(candidate) || !resourceAudioExtensions.has(path.extname(candidate).toLowerCase())) {
        throw new Error("Reference clip does not exist");
      }
      response.statusCode = 200;
      response.setHeader("Content-Type", "audio/mpeg");
      fs.createReadStream(candidate).pipe(response);
      return true;
    }
    const selected = production.voice.references.selections[speaker] ?? [];
    const clips = fs.readdirSync(voiceDirectory)
      .filter(name => resourceAudioExtensions.has(path.extname(name).toLowerCase()))
      .sort((left, right) => left.localeCompare(right, "zh-CN"))
      .map(name => {
        const baseName = path.basename(name, path.extname(name));
        const textPath = path.join(voiceDirectory, `${baseName}.txt`);
        return {
          name: baseName,
          text: fs.existsSync(textPath) ? fs.readFileSync(textPath, "utf8").trim() : "",
          selected: selected.includes(baseName),
          audioUrl: `${pathname}?audio=${encodeURIComponent(name)}`,
        };
      });
    sendJson(response, 200, { speaker, characterName: resolved.characterName, selected, clips });
    return true;
  }
  if (request.method === "PUT" && match) {
    const body = await readBody(request);
    const production = getProduction(match[0], { includeStory: false, includeHistory: false });
    const resolved = production.voice.speakers.items
      .map(item => item.resolution)
      .find(resolution => resolution?.type === "character" && resolution.stableKey === match[1]);
    if (!resolved) throw new Error(`No character resolution exists for ${match[1]}`);
    const voiceDirectory = path.join(localFilesRoot, "ba-characters", resolved.characterName, "语音");
    if (!fs.existsSync(voiceDirectory)) throw new Error(`Character resources are missing for ${resolved.characterName}`);
    const available = new Set(fs.readdirSync(voiceDirectory)
      .filter(name => resourceAudioExtensions.has(path.extname(name).toLowerCase()))
      .map(name => path.basename(name, path.extname(name))));
    const selected = [...new Set((body.selected ?? []).map(String))];
    if (!selected.length) throw new Error("Select at least one reference clip");
    const missing = selected.filter(name => !available.has(name));
    if (missing.length) throw new Error(`Unknown reference clips: ${missing.join(", ")}`);
    const selections = { ...production.voice.references.selections, [match[1]]: selected };
    sendJson(response, 200, {
      production: writeReferenceArtifact(match[0], selections, {
        note: body.note || `人工微调 ${match[1]} 的参考音`,
        source: "human-fine-tune",
      }),
    });
    return true;
  }
  match = routeMatch(pathname, /^\/api\/workspaces\/([^/]+)\/production\/assemble$/u);
  if (request.method === "POST" && match) {
    sendJson(response, 200, { production: buildProductionStory(match[0]) });
    return true;
  }
  match = routeMatch(pathname, /^\/api\/workspaces\/([^/]+)\/production\/assembly\/story$/u);
  if (request.method === "GET" && match) {
    const production = getProduction(match[0], { includeStory: false, includeHistory: false });
    if (!production.assembly.current) throw new Error("No current assembly story is available");
    sendJson(response, 200, { story: readJson(productionPaths(match[0]).assemblyStory) });
    return true;
  }
  match = routeMatch(pathname, /^\/api\/workspaces\/([^/]+)\/production\/recording\/video$/u);
  if ((request.method === "GET" || request.method === "HEAD") && match) {
    const production = getProduction(match[0], { includeStory: false, includeHistory: false });
    if (!production.recording.current || !production.recording.output) {
      throw new Error("No current preview video is available");
    }
    serveMedia(request, response, production.recording.output, "video/mp4");
    return true;
  }
  match = routeMatch(pathname, /^\/api\/workspaces\/([^/]+)\/production\/recording\/reveal$/u);
  if (request.method === "POST" && match) {
    const production = getProduction(match[0], { includeStory: false, includeHistory: false });
    if (!production.recording.current || !production.recording.output) {
      throw new Error("No current preview video is available");
    }
    const output = assertInsideDirectory(localFilesRoot, production.recording.output, "recording output");
    if (!fs.existsSync(output)) throw new Error("Preview video does not exist");
    if (process.platform !== "darwin") throw new Error("Reveal in Finder is only available on macOS");
    const revealed = spawnSync("open", ["-R", output], { stdio: "ignore" });
    if (revealed.error) throw revealed.error;
    if (revealed.status !== 0) throw new Error(`Finder failed with exit code ${revealed.status}`);
    sendJson(response, 200, { output, directory: path.dirname(output) });
    return true;
  }
  match = routeMatch(pathname, /^\/api\/workspaces\/([^/]+)\/production\/branches$/u);
  if (request.method === "PATCH" && match) {
    sendJson(response, 200, {
      production: updateProductionBranches(match[0], await readBody(request)),
    });
    return true;
  }
  match = routeMatch(pathname, /^\/api\/workspaces\/([^/]+)\/production\/preview\/complete$/u);
  if (request.method === "POST" && match) {
    sendJson(response, 200, { production: completeProductionPreview(match[0]) });
    return true;
  }
  match = routeMatch(pathname, /^\/api\/workspaces\/([^/]+)\/production\/formal-story$/u);
  if (request.method === "POST" && match) {
    const body = await readBody(request);
    if (body.confirmed !== true) {
      sendJson(response, 409, { error: "confirmation-required", message: "生成正式剧情文件会写入 public/story，请先确认。" });
      return true;
    }
    sendJson(response, 200, { production: materializeProductionStory(match[0]) });
    return true;
  }
  match = routeMatch(pathname, /^\/api\/workspaces\/([^/]+)\/versions\/rework$/u);
  if (request.method === "POST" && match) {
    const body = await readBody(request);
    if (body.confirmed !== true) {
      sendJson(response, 409, {
        error: "confirmation-required",
        message: "这会创建一个干净的大版本并从自动准备重新开始，请先确认。",
      });
      return true;
    }
    const running = listJobs(match[0]).find(job => job.status === "running");
    if (running) throw new Error(`Job ${running.id} is running; wait before creating a rework version`);
    const result = createProductionVersion(match[0], body);
    sendJson(response, 201, {
      version: result.version,
      status: reconcileWorkspace(match[0]),
      stages: workflowStageIds,
    });
    return true;
  }
  match = routeMatch(pathname, /^\/api\/workspaces\/([^/]+)\/versions\/([^/]+)\/activate$/u);
  if (request.method === "POST" && match) {
    const running = listJobs(match[0]).find(job => job.status === "running");
    if (running) throw new Error(`Job ${running.id} is running; wait before switching versions`);
    activateVersion(match[0], match[1]);
    sendJson(response, 200, { status: reconcileWorkspace(match[0]) });
    return true;
  }
  match = routeMatch(pathname, /^\/api\/workspaces\/([^/]+)\/story$/u);
  if (request.method === "GET" && match) {
    const revision = getRevision(match[0], parsedUrl.searchParams.get("revision"));
    sendJson(response, 200, revision ? {
      revision: revision.name,
      stage: revision.stage,
      story: revision.story,
      result: revision.result,
    } : { revision: null, story: null });
    return true;
  }
  match = routeMatch(pathname, /^\/api\/workspaces\/([^/]+)\/tts\/lines$/u);
  if (request.method === "GET" && match) {
    const workspace = loadWorkspace(match[0]);
    const current = getRevision(workspace.id);
    const manifestPath = versionTtsManifestPath(workspace.id);
    const manifest = readJson(manifestPath, { tasks: {} });
    const tasks = manifest.tasks ?? {};
    const review2 = getLatestRevisionForStage(workspace.id, "review-2");
    const review2Result = review2 ? readJson(review2.resultPath, {}) : {};
    const skippedIndices = new Set(resolveTtsSkippedIndices(current.story, review2Result));
    const requestedIndex = parsedUrl.searchParams.get("audio");
    if (requestedIndex !== null) {
      if (!/^\d+$/u.test(requestedIndex)) throw new Error("Invalid TTS line index");
      const task = tasks[requestedIndex];
      const unit = current?.story?.content?.[Number(requestedIndex)];
      const generated = String(task?.generatedText ?? task?.downloadedText ?? task?.text ?? "").trim();
      if (skippedIndices.has(Number(requestedIndex)) || !task?.audioPath ||
        String(task.status).toUpperCase() !== "COMPLETED" ||
        !unit || generated !== effectiveTtsText(unit)) {
        throw new Error(`No current generated audio for line ${requestedIndex}`);
      }
      const audioPath = assertInsideDirectory(localFilesRoot, task.audioPath, "TTS audio path");
      if (!fs.existsSync(audioPath) || !fs.statSync(audioPath).isFile()) {
        throw new Error(`Generated audio is missing for line ${requestedIndex}`);
      }
      serveAudio(request, response, audioPath);
      return true;
    }
    const planByIndex = new Map((review2Result.ttsPlan ?? []).map(item => [Number(item.index), item]));
    const lineIndices = [...new Set([...planByIndex.keys(), ...skippedIndices])]
      .sort((left, right) => left - right);
    const lines = lineIndices.map(index => {
      const item = planByIndex.get(index) ?? {};
      const unit = current.story.content[index];
      const task = tasks[String(index)] ?? null;
      const expectedText = String(item.expected?.ttsText ?? effectiveTtsText(unit)).trim();
      const skipped = skippedIndices.has(index);
      const generated = String(task?.generatedText ?? task?.downloadedText ?? task?.text ?? "").trim();
      const currentTask = Boolean(!skipped && task && generated === expectedText);
      const audioReady = Boolean(currentTask && String(task.status).toUpperCase() === "COMPLETED" &&
        task.audioPath && fs.existsSync(task.audioPath));
      return {
        index,
        speaker: String(task?.speaker ?? parseScenarioScriptSpeakers(unit).dialogueSpeaker ?? ""),
        textCn: String(unit.TextCn ?? ""),
        ttsText: expectedText,
        skipped,
        status: skipped ? "SKIPPED" : currentTask
          ? String(task.status ?? (audioReady ? "COMPLETED" : "UNKNOWN"))
          : "NOT_CREATED",
        audioReady,
        audioUrl: audioReady
          ? `${pathname}?audio=${index}&token=${encodeURIComponent(String(task.downloadedTaskId || task.taskId || "audio"))}`
          : null,
        error: currentTask ? String(task.errorMessage ?? "") : "",
      };
    });
    sendJson(response, 200, { lines });
    return true;
  }
  match = routeMatch(pathname, /^\/api\/workspaces\/([^/]+)\/final-playback$/u);
  if (match && request.method === "POST") {
    const workspace = loadWorkspace(match[0]);
    const state = reconcileWorkspace(workspace.id);
    if (!state.publicArtifact.exists || !state.publicArtifact.matchesCurrent) {
      throw new Error("The published story must match the current revision before final playback can pass");
    }
    writeJsonAtomic(path.join(
      workspace.paths.root,
      `final-playback-${workspace.activeVersionId}.json`,
    ), {
      completedAt: new Date().toISOString(),
      storyDigest: state.publicArtifact.digest,
      player: "ba-story-player",
      versionId: workspace.activeVersionId,
    });
    sendJson(response, 200, { complete: true });
    return true;
  }
  match = routeMatch(pathname, /^\/api\/workspaces\/([^/]+)\/covers$/u);
  if (match && request.method === "GET") {
    const workspace = loadWorkspace(match[0]);
    const coverRoot = path.join(appRoot, ".local-files", "covers");
    const runRoot = path.join(coverRoot, ".runs", workspace.identity.storyId);
    const versionedSelectionPath = path.join(
      workspace.paths.resources, `cover-selection-${workspace.activeVersionId}.json`,
    );
    const legacySelectionPath = path.join(workspace.paths.resources, "cover-selection.json");
    const globalSelectionPath = path.join(coverRoot, ".selections", `${workspace.identity.storyId}.json`);
    const selectionPath = [versionedSelectionPath, legacySelectionPath, globalSelectionPath]
      .find(candidate => fs.existsSync(candidate)) ?? versionedSelectionPath;
    const selection = readJson(selectionPath, null);
    const files = fs.existsSync(coverRoot) ? fs.readdirSync(coverRoot)
      .filter(name => name.startsWith(workspace.identity.storyId) && /\.(?:jpe?g|png|webp)$/iu.test(name))
      .map(name => ({
        name,
        selected: selection?.name === name,
        url: `${pathname}/${encodeURIComponent(name)}`,
        size: fs.statSync(path.join(coverRoot, name)).size,
      })) : [];
    const latestRun = fs.existsSync(runRoot) ? fs.readdirSync(runRoot)
      .map(name => path.join(runRoot, name, "manifest.json"))
      .filter(filePath => fs.existsSync(filePath))
      .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)
      .map(filePath => readJson(filePath, null))
      .find(Boolean) ?? null : null;
    sendJson(response, 200, { files, selection, latestRun });
    return true;
  }
  if (match && request.method === "POST") {
    const workspace = loadWorkspace(match[0]);
    const originalName = decodeURIComponent(String(request.headers["x-file-name"] ?? "cover.jpg"));
    const extension = path.extname(originalName).toLowerCase();
    if (!new Set([".jpg", ".jpeg", ".png", ".webp"]).has(extension)) {
      throw new Error("Cover must be jpg, jpeg, png, or webp");
    }
    const coverRoot = path.join(appRoot, ".local-files", "covers");
    fs.mkdirSync(coverRoot, { recursive: true });
    const base = path.basename(originalName, extension).replace(/[^A-Za-z0-9._-]+/gu, "-").slice(0, 60) || "cover";
    const name = `${workspace.identity.storyId}-${base}${extension}`;
    const destination = path.join(coverRoot, name);
    const temporary = `${destination}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, await readBuffer(request));
    fs.renameSync(temporary, destination);
    sendJson(response, 201, { name, url: `${pathname}/${encodeURIComponent(name)}` });
    return true;
  }
  match = routeMatch(pathname, /^\/api\/workspaces\/([^/]+)\/covers\/select$/u);
  if (match && request.method === "POST") {
    const workspace = loadWorkspace(match[0]);
    const body = await readBody(request);
    sendJson(response, 200, selectCoverCandidate(workspace.identity.storyId, body.name));
    return true;
  }
  match = routeMatch(pathname, /^\/api\/workspaces\/([^/]+)\/covers\/([^/]+)$/u);
  if (match && request.method === "GET") {
    const workspace = loadWorkspace(match[0]);
    const name = path.basename(match[1]);
    if (!name.startsWith(workspace.identity.storyId)) {
      throw new Error("Cover does not belong to this story");
    }
    const coverPath = path.join(appRoot, ".local-files", "covers", name);
    if (!fs.existsSync(coverPath)) throw new Error("Cover does not exist");
    response.statusCode = 200;
    const contentType = name.endsWith(".png") ? "image/png" :
      name.endsWith(".webp") ? "image/webp" : "image/jpeg";
    response.setHeader("Content-Type", contentType);
    fs.createReadStream(coverPath).pipe(response);
    return true;
  }
  match = routeMatch(pathname, /^\/api\/workspaces\/([^/]+)\/revisions$/u);
  if (request.method === "GET" && match) {
    sendJson(response, 200, { revisions: listRevisions(match[0]) });
    return true;
  }
  match = routeMatch(pathname, /^\/api\/workspaces\/([^/]+)\/adopt-public$/u);
  if (request.method === "POST" && match) {
    const workspace = loadWorkspace(match[0]);
    const status = reconcileWorkspace(workspace.id);
    if (!status.publicArtifact.exists || status.publicArtifact.corrupt) {
      throw new Error("No valid public story is available to register");
    }
    const story = readJson(status.publicArtifact.path);
    const revision = createRevision(workspace.id, {
      stage: "adopted-existing",
      story,
      result: {
        sourcePath: status.publicArtifact.path,
        warning: "Registered for review only; it does not prove any pipeline stage completed.",
      },
    });
    sendJson(response, 201, { revision: revision.name });
    return true;
  }
  match = routeMatch(pathname, /^\/api\/workspaces\/([^/]+)\/reviews\/(tool[12])$/u);
  if (match && request.method === "GET") {
    const stageId = match[1] === "tool1" ? "review-1" : "review-2";
    const stage = reconcileWorkspace(match[0]).stages.find(candidate => candidate.id === stageId);
    if (!new Set(["ready", "in-progress", "completed"]).has(stage?.status)) {
      throw new Error(`${stageId} is ${stage?.status || "unavailable"}; finish its prerequisites first`);
    }
    const readOnly = stage.status === "completed";
    let draft = readOnly ? loadDraft(match[0], match[1]) : openReview(match[0], match[1]);
    if (!draft) throw new Error(`No saved ${match[1]} review draft exists`);
    if (readOnly && match[1] === "tool2") {
      draft = structuredClone(draft);
      draft.ttsSkippedIndices = resolveTtsSkippedIndices(
        draft.story,
        draft,
        draft.issues.filter(issue => issue.kind === "voice-script").map(issue => issue.index),
      );
    }
    sendJson(response, 200, { draft, summary: reviewSummary(draft), readOnly });
    return true;
  }
  if (match && request.method === "PATCH") {
    const stageId = match[1] === "tool1" ? "review-1" : "review-2";
    const stage = reconcileWorkspace(match[0]).stages.find(candidate => candidate.id === stageId);
    if (!new Set(["ready", "in-progress"]).has(stage?.status)) {
      sendJson(response, 409, {
        error: "review-read-only",
        message: `${stageId} is read-only or unavailable`,
      });
      return true;
    }
    const draft = updateReview(match[0], match[1], await readBody(request));
    sendJson(response, 200, { draft, summary: reviewSummary(draft) });
    return true;
  }
  match = routeMatch(pathname, /^\/api\/workspaces\/([^/]+)\/reviews\/(tool[12])\/approve$/u);
  if (match && request.method === "POST") {
    const stageId = match[1] === "tool1" ? "review-1" : "review-2";
    const stage = reconcileWorkspace(match[0]).stages.find(candidate => candidate.id === stageId);
    if (!new Set(["ready", "in-progress"]).has(stage?.status)) {
      sendJson(response, 409, {
        error: "review-read-only",
        message: `${stageId} is read-only or unavailable`,
      });
      return true;
    }
    const revision = approveReview(match[0], match[1]);
    sendJson(response, 201, { revision: revision.name, result: revision.result });
    return true;
  }
  match = routeMatch(pathname, /^\/api\/workspaces\/([^/]+)\/jobs$/u);
  if (match && request.method === "GET") {
    const workspace = loadWorkspace(match[0]);
    sendJson(response, 200, { jobs: listJobs(match[0]).filter(job =>
      job.versionId === workspace.activeVersionId ||
      (!job.versionId && workspace.activeVersionId === "v001")).map(job => withLogTail(job)) });
    return true;
  }
  if (match && request.method === "POST") {
    const body = await readBody(request);
    const action = String(body.action ?? "");
    if (!automaticActions.has(action)) throw new Error(`Unsupported action: ${action}`);
    const needsConfirmation = confirmationActions.has(action) ||
      (action === "tts" && new Set(["upload", "tasks", "poll", "all"])
        .has(String(body.params?.ttsStage ?? "prepare")));
    if (needsConfirmation && body.confirmed !== true) {
      sendJson(response, 409, {
        error: "confirmation-required",
        message: "该步骤会访问远端、产生费用或写入正式目录，请先确认执行计划。",
      });
      return true;
    }
    if (action.startsWith("production-")) {
      if (action === "production-prepare") {
        const status = reconcileWorkspace(match[0]);
        if (!status.tables.ready) {
          throw new Error("Story source tables are not ready; run environment setup first");
        }
        if (hasProduction(match[0])) {
          throw new Error("This production version is already prepared; create a new version to restart");
        }
      } else if (!hasProduction(match[0])) {
        throw new Error("Prepare the independent-track production first");
      }
    } else if (!new Set(["download-character", "sync"]).has(action)) {
      const prerequisiteStage = prerequisiteStageForJob(action, body.params ?? {});
      const stage = reconcileWorkspace(match[0]).stages.find(candidate => candidate.id === prerequisiteStage);
      const runnableStatuses = new Set(["tts-line-revise", "tts-line-skip"]).has(action)
        ? new Set(["ready", "completed"])
        : prerequisiteStage === "resources"
        ? new Set(["ready", "in-progress", "completed"])
        : new Set(["ready", "in-progress"]);
      if (!stage || !runnableStatuses.has(stage.status)) {
        throw new Error(
          `Stage ${prerequisiteStage} is ${stage?.status || "unavailable"}; finish its prerequisites first`,
        );
      }
    }
    const job = startJob(match[0], action, body.params ?? {});
    sendJson(response, 202, { job });
    return true;
  }
  match = routeMatch(pathname, /^\/api\/workspaces\/([^/]+)\/resources\/([^/]+)$/u);
  if (match && request.method === "GET") {
    const workspace = loadWorkspace(match[0]);
    const state = reconcileWorkspace(workspace.id).resources;
    const item = state.items.find(candidate => candidate.speakerKr === match[1]);
    if (!item?.resourceReady) throw new Error(`Character resources are not ready for ${match[1]}`);
    const voiceDirectory = path.join(item.resourceDirectory, "语音");
    const selectionsPath = versionResourcePath(
      workspace.id, "reference-selections.json", { legacyFallback: true },
    );
    const selections = readJson(selectionsPath, {});
    const manualSelected = Array.isArray(selections[match[1]]) ? selections[match[1]] : [];
    const prepared = item.referenceManifest ? readJson(item.referenceManifest, null) : null;
    const automaticSelected = Array.isArray(prepared?.clips)
      ? prepared.clips.map(clip => String(clip.name))
      : [];
    const selected = manualSelected.length > 0 ? manualSelected : automaticSelected;
    const clips = fs.readdirSync(voiceDirectory)
      .filter(name => resourceAudioExtensions.has(path.extname(name).toLowerCase()))
      .sort((a, b) => a.localeCompare(b, "zh-CN"))
      .map(name => {
        const baseName = path.basename(name, path.extname(name));
        const textPath = path.join(voiceDirectory, `${baseName}.txt`);
        return {
          name: baseName,
          text: fs.existsSync(textPath) ? fs.readFileSync(textPath, "utf8").trim() : "",
          selected: selected.includes(baseName),
          audioUrl: `${pathname}?audio=${encodeURIComponent(name)}`,
        };
      });
    const audioName = parsedUrl.searchParams.get("audio");
    if (audioName) {
      const audioPath = assertInsideDirectory(voiceDirectory, path.join(voiceDirectory, audioName), "audio path");
      const extension = path.extname(audioName).toLowerCase();
      if (!resourceAudioExtensions.has(extension) || !fs.existsSync(audioPath)) {
        throw new Error("Audio clip does not exist");
      }
      response.statusCode = 200;
      response.setHeader("Content-Type", {
        ".flac": "audio/flac",
        ".m4a": "audio/mp4",
        ".mp3": "audio/mpeg",
        ".ogg": "audio/ogg",
        ".opus": "audio/ogg",
        ".wav": "audio/wav",
      }[extension] || "application/octet-stream");
      fs.createReadStream(audioPath).pipe(response);
      return true;
    }
    sendJson(response, 200, {
      item,
      clips,
      selected,
      selectionSource: manualSelected.length > 0 ? "manual" : "automatic",
    });
    return true;
  }
  if (match && request.method === "POST") {
    const workspace = loadWorkspace(match[0]);
    const body = await readBody(request);
    const selected = [...new Set((body.selected ?? []).map(value => String(value).trim()).filter(Boolean))];
    const state = reconcileWorkspace(workspace.id).resources;
    const item = state.items.find(candidate => candidate.speakerKr === match[1]);
    if (!item?.resourceReady) throw new Error(`Character resources are not ready for ${match[1]}`);
    const available = new Set(fs.readdirSync(path.join(item.resourceDirectory, "语音"))
      .filter(name => resourceAudioExtensions.has(path.extname(name).toLowerCase()))
      .map(name => path.basename(name, path.extname(name))));
    const invalid = selected.filter(name => !available.has(name));
    if (invalid.length) throw new Error(`Unknown clips: ${invalid.join(", ")}`);
    const selectionsPath = versionResourcePath(workspace.id, "reference-selections.json");
    const existingPath = versionResourcePath(
      workspace.id, "reference-selections.json", { legacyFallback: true },
    );
    writeJsonAtomic(selectionsPath, { ...readJson(existingPath, {}), [match[1]]: selected });
    sendJson(response, 200, { speakerKr: match[1], selected });
    return true;
  }
  match = routeMatch(pathname, /^\/api\/workspaces\/([^/]+)\/jobs\/([^/]+)$/u);
  if (match && request.method === "GET") {
    sendJson(response, 200, { job: getJob(match[0], match[1]) });
    return true;
  }
  return false;
}

const frontendDist = path.join(appRoot, ".local-files", "tmp", "create-story-workbench-ui");
await buildFrontend({
  root: workbenchRoot,
  configFile: path.join(workbenchRoot, "vite.config.mjs"),
  build: { outDir: frontendDist, emptyOutDir: true },
});

function serveFrontend(request, response, parsedUrl) {
  const requested = parsedUrl.pathname === "/" ? "index.html" : parsedUrl.pathname.slice(1);
  let filePath = assertInsideDirectory(frontendDist, path.join(frontendDist, requested), "frontend path");
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    filePath = path.join(frontendDist, "index.html");
  }
  const extension = path.extname(filePath);
  const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff2": "font/woff2",
  };
  response.statusCode = 200;
  response.setHeader("Content-Type", contentTypes[extension] || "application/octet-stream");
  fs.createReadStream(filePath).pipe(response);
}

const server = http.createServer(async (request, response) => {
  try {
    const parsedUrl = new URL(request.url, `http://${host}:${port}`);
    if (parsedUrl.pathname.startsWith("/api/")) {
      const handled = await handleApi(request, response, parsedUrl);
      if (!handled) sendJson(response, 404, { error: "not-found" });
      return;
    }
    serveFrontend(request, response, parsedUrl);
  } catch (error) {
    console.error(error.stack || error.message);
    sendJson(response, 400, { error: "request-failed", message: error.message });
  }
});

server.listen(port, host, () => {
  console.log(`Story Production Workbench: http://${host}:${port}`);
  console.log("Only localhost connections are accepted.");
});
