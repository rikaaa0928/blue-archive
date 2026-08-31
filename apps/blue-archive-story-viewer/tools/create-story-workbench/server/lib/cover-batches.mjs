import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { hasProduction, productionPaths } from "./production.mjs";
import { resolveEventSeries } from "./series.mjs";
import { listWorkspaces } from "./workspaces.mjs";
import { appRoot, localFilesRoot, nowIso, readJson, safeSegment, writeJsonAtomic } from "./utils.mjs";

const coverBatchRoot = path.join(localFilesRoot, "create-story", "_cover-batches");
const coverRoot = path.join(localFilesRoot, "covers");
const coverSelectionRoot = path.join(coverRoot, ".selections");
const runnerPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "series-cover-runner.mjs");
const activeCoverBatches = new Map();

function directory(batchId) {
  return path.join(coverBatchRoot, safeSegment(batchId, "cover batch id"));
}

function payloadPath(batchId) {
  return path.join(directory(batchId), "batch.json");
}

function refreshInterrupted(batch) {
  if (batch.status !== "running" || activeCoverBatches.has(batch.id)) return batch;
  let alive = false;
  try { process.kill(batch.pid, 0); alive = true; } catch {}
  if (alive) return batch;
  const next = { ...batch, status: "interrupted", pid: null, finishedAt: nowIso() };
  writeJsonAtomic(payloadPath(batch.id), next);
  return next;
}

export function getCoverBatch(batchId) {
  const batch = refreshInterrupted(readJson(payloadPath(batchId)));
  const logPath = path.join(directory(batchId), "log.txt");
  return { ...batch, log: fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "" };
}

export function listCoverBatches() {
  if (!fs.existsSync(coverBatchRoot)) return [];
  return fs.readdirSync(coverBatchRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && fs.existsSync(payloadPath(entry.name)))
    .map(entry => getCoverBatch(entry.name))
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}

export function listRunningCoverBatches() {
  return listCoverBatches().filter(batch => batch.status === "running");
}

function selectedCoverName(workspace, storyId) {
  const versioned = workspace
    ? path.join(workspace.paths.resources, `cover-selection-${workspace.activeVersionId}.json`)
    : "";
  const legacy = workspace ? path.join(workspace.paths.resources, "cover-selection.json") : "";
  const global = path.join(coverSelectionRoot, `${storyId}.json`);
  const selectionPath = [versioned, legacy, global].find(candidate => candidate && fs.existsSync(candidate));
  const selection = selectionPath ? readJson(selectionPath, null) : null;
  return selection?.name?.startsWith(storyId) ? selection.name : null;
}

export function selectCoverCandidate(storyId, rawName) {
  const normalizedStoryId = safeSegment(String(storyId), "cover story id");
  const name = path.basename(String(rawName ?? ""));
  const coverPath = path.join(coverRoot, name);
  if (!name.startsWith(normalizedStoryId) || !/\.(?:jpe?g|png|webp)$/iu.test(name) || !fs.existsSync(coverPath)) {
    throw new Error("Cover does not exist for this story");
  }
  const selection = { name, selectedAt: nowIso(), storyId: normalizedStoryId };
  writeJsonAtomic(path.join(coverSelectionRoot, `${normalizedStoryId}.json`), selection);
  const workspace = listWorkspaces().find(item =>
    !item.corrupt && item.identity?.type === "event" && String(item.identity.storyId) === normalizedStoryId);
  if (workspace) {
    writeJsonAtomic(
      path.join(workspace.paths.resources, `cover-selection-${workspace.activeVersionId}.json`),
      { ...selection, versionId: workspace.activeVersionId },
    );
  }
  return selection;
}

export function resolveCoverSeries(query) {
  const series = resolveEventSeries(query);
  const workspaceByStoryId = new Map(listWorkspaces()
    .filter(item => !item.corrupt && item.identity?.type === "event")
    .map(item => [String(item.identity.storyId), item]));
  const coverNames = fs.existsSync(coverRoot) ? fs.readdirSync(coverRoot)
    .filter(name => /\.(?:jpe?g|png|webp)$/iu.test(name)) : [];
  return {
    ...series,
    chapters: series.chapters.map(chapter => {
      const workspace = workspaceByStoryId.get(chapter.storyId);
      let speakerConfig = null;
      if (workspace && hasProduction(workspace.id)) {
        const paths = productionPaths(workspace.id);
        if (fs.existsSync(paths.speakers)) speakerConfig = paths.speakers;
      }
      const candidates = coverNames.filter(name => name.startsWith(chapter.storyId));
      return {
        ...chapter,
        workspaceId: workspace?.id ?? null,
        coverReady: true,
        coverReadyReason: "可自动导出日文剧情",
        storyPath: null,
        speakerConfig,
        candidates,
        selectedCover: selectedCoverName(workspace, chapter.storyId),
      };
    }),
  };
}

function launch(batchId) {
  const batchDirectory = directory(batchId);
  const logStream = fs.createWriteStream(path.join(batchDirectory, "log.txt"), { flags: "a" });
  const child = spawn(process.execPath, [runnerPath, batchId], {
    cwd: appRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const payload = readJson(payloadPath(batchId));
  writeJsonAtomic(payloadPath(batchId), {
    ...payload,
    status: "running",
    startedAt: nowIso(),
    finishedAt: null,
    pid: child.pid,
  });
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);
  activeCoverBatches.set(batchId, child);
  child.on("close", exitCode => {
    logStream.end();
    activeCoverBatches.delete(batchId);
    const latest = readJson(payloadPath(batchId));
    writeJsonAtomic(payloadPath(batchId), {
      ...latest,
      status: exitCode === 0 ? "completed" : "failed",
      exitCode,
      pid: null,
      finishedAt: nowIso(),
    });
  });
}

export function createCoverBatch({ query, storyIds, params = {} }) {
  const series = resolveCoverSeries(query);
  const selected = [...new Set((storyIds ?? []).map(String))];
  if (!selected.length) throw new Error("At least one cover chapter must be selected");
  const allowed = new Set(series.chapters.map(chapter => chapter.storyId));
  if (selected.some(storyId => !allowed.has(storyId))) throw new Error("Cover batch contains a chapter outside the event series");
  const chapters = series.chapters.filter(chapter => selected.includes(chapter.storyId));
  const unavailable = chapters.filter(chapter => !chapter.coverReady);
  if (unavailable.length) throw new Error(`Cover inputs are not ready: ${unavailable.map(item => item.storyId).join(", ")}`);
  if (listRunningCoverBatches().length) throw new Error("Another series cover batch is already running");
  const batchId = `${Date.now()}-covers-event-${series.id}`;
  fs.mkdirSync(directory(batchId), { recursive: true });
  const sourceRoot = path.join(directory(batchId), "japanese-stories");
  const input = {
    series: { type: series.type, id: series.id, title: series.title },
    chapters: chapters.map(chapter => ({
      order: chapter.order,
      storyId: chapter.storyId,
      directoryId: chapter.directoryId,
      title: chapter.title,
      rawTitle: chapter.rawTitle,
      titleInherited: chapter.titleInherited,
      continuationIndex: chapter.continuationIndex,
      storyPath: path.join(sourceRoot, `${chapter.storyId}.json`),
      speakerConfig: chapter.speakerConfig,
    })),
  };
  writeJsonAtomic(path.join(directory(batchId), "input.json"), input);
  writeJsonAtomic(path.join(directory(batchId), "params.json"), params);
  writeJsonAtomic(payloadPath(batchId), {
    schemaVersion: 1,
    id: batchId,
    kind: "event-series-covers",
    series: input.series,
    query: String(query),
    status: "queued",
    createdAt: nowIso(),
    startedAt: null,
    finishedAt: null,
    pid: null,
    params,
    items: input.chapters.map(chapter => ({
      order: chapter.order,
      storyId: chapter.storyId,
      directoryId: chapter.directoryId,
      title: chapter.title,
      titleInherited: chapter.titleInherited,
      continuationIndex: chapter.continuationIndex,
      status: "queued",
      assignment: null,
      output: null,
      qaPassed: null,
      qaScore: null,
      error: null,
    })),
  });
  launch(batchId);
  return getCoverBatch(batchId);
}
