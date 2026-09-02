import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { localFilesRoot, nowIso, readJson, safeSegment, writeJsonAtomic } from "./utils.mjs";
import { resolveEventSeries, resolveMainSeries } from "./series.mjs";

const batchRoot = path.join(localFilesRoot, "create-story", "_batches");
const runnerPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "batch-runner.mjs");
const activeBatches = new Map();

function normalizeMode(value, fallback = "review") {
  const mode = String(value || fallback);
  if (!new Set(["review", "complete"]).has(mode)) {
    throw new Error(`Unsupported batch mode: ${mode}`);
  }
  return mode;
}

function batchDirectory(batchId) {
  return path.join(batchRoot, safeSegment(batchId, "batch id"));
}

function batchPath(batchId) {
  return path.join(batchDirectory(batchId), "batch.json");
}

function refreshInterrupted(batch) {
  if (batch.status !== "running" || activeBatches.has(batch.id)) return batch;
  let alive = false;
  try { process.kill(batch.pid, 0); alive = true; } catch {}
  if (alive) return batch;
  const next = { ...batch, status: "interrupted", finishedAt: nowIso() };
  writeJsonAtomic(batchPath(batch.id), next);
  return next;
}

export function getBatch(batchId) {
  const payload = refreshInterrupted(readJson(batchPath(batchId)));
  const logPath = path.join(batchDirectory(batchId), "log.txt");
  return { ...payload, log: fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "" };
}

export function listBatches() {
  if (!fs.existsSync(batchRoot)) return [];
  return fs.readdirSync(batchRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && fs.existsSync(batchPath(entry.name)))
    .map(entry => getBatch(entry.name))
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}

export function listRunningBatches() {
  if (!fs.existsSync(batchRoot)) return [];
  return fs.readdirSync(batchRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && fs.existsSync(batchPath(entry.name)))
    .filter(entry => readJson(batchPath(entry.name)).status === "running")
    .map(entry => getBatch(entry.name))
    .filter(batch => batch.status === "running")
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}

function launch(batchId) {
  const directory = batchDirectory(batchId);
  const logStream = fs.createWriteStream(path.join(directory, "log.txt"), { flags: "a" });
  const child = spawn(process.execPath, [runnerPath, batchId], {
    cwd: directory,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const payload = readJson(batchPath(batchId));
  writeJsonAtomic(batchPath(batchId), {
    ...payload,
    status: "running",
    pid: child.pid,
    startedAt: nowIso(),
    finishedAt: null,
    runCount: Number(payload.runCount ?? 0) + 1,
  });
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);
  activeBatches.set(batchId, child);
  child.on("close", exitCode => {
    logStream.end();
    activeBatches.delete(batchId);
    const latest = readJson(batchPath(batchId));
    const status = exitCode !== 0 || latest.items.some(item => item.status === "failed")
      ? "failed"
      : latest.items.every(item => item.status === "completed") ? "completed" : "waiting";
    writeJsonAtomic(batchPath(batchId), {
      ...latest,
      status,
      exitCode,
      pid: null,
      finishedAt: nowIso(),
    });
  });
}

export function createBatch({ seriesType = "event", query, storyIds, params = {}, mode = "complete" }) {
  if (!new Set(["event", "main"]).has(seriesType)) {
    throw new Error(`Unsupported batch series type: ${seriesType}`);
  }
  const series = seriesType === "main"
    ? resolveMainSeries(query)
    : resolveEventSeries(query);
  const allowed = new Set(series.chapters.map(chapter => chapter.storyId));
  const selected = [...new Set((storyIds ?? []).map(String))];
  if (!selected.length) throw new Error("At least one chapter must be selected");
  if (selected.some(storyId => !allowed.has(storyId))) {
    throw new Error("The batch contains a chapter outside the selected series");
  }
  const ordered = series.chapters.filter(chapter => selected.includes(chapter.storyId));
  const normalizedMode = normalizeMode(mode, "complete");
  const batchId = `${Date.now()}-${series.type}-${series.id}`;
  fs.mkdirSync(batchDirectory(batchId), { recursive: true });
  writeJsonAtomic(batchPath(batchId), {
    schemaVersion: 2,
    id: batchId,
    kind: `${series.type}-series-${normalizedMode === "complete" ? "complete" : "next-human"}`,
    series: { type: series.type, id: series.id, title: series.title },
    query: String(query),
    status: "queued",
    createdAt: nowIso(),
    startedAt: null,
    finishedAt: null,
    runCount: 0,
    mode: normalizedMode,
    pid: null,
    params,
    items: ordered.map(chapter => ({
      order: chapter.order,
      storyId: chapter.storyId,
      directoryId: chapter.directoryId,
      title: chapter.title,
      status: "queued",
      gate: null,
      lastAction: null,
      error: null,
    })),
  });
  launch(batchId);
  return getBatch(batchId);
}

export function resumeBatch(batchId, options = {}) {
  const batch = getBatch(batchId);
  if (Number(batch.schemaVersion) < 2) {
    throw new Error("旧版线性批次不能继续；请按当前活动重新创建独立产物批次");
  }
  if (batch.status === "running") throw new Error("The batch is already running");
  const mode = normalizeMode(options.mode, batch.mode ?? "review");
  writeJsonAtomic(batchPath(batchId), {
    ...batch,
    log: undefined,
    status: "queued",
    mode,
    items: batch.items.map(item => ({ ...item, status: "queued", error: null })),
  });
  launch(batchId);
  return getBatch(batchId);
}
