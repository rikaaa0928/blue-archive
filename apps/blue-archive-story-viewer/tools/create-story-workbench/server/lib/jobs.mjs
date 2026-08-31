import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { nowIso, readJson, writeJsonAtomic } from "./utils.mjs";
import { loadWorkspace } from "./workspaces.mjs";

const runnerPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "stage-runner.mjs");
const activeJobs = new Map();

function jobDirectory(workspace, jobId) {
  return path.join(workspace.paths.jobs, jobId);
}

function jobPayloadPath(workspace, jobId) {
  return path.join(jobDirectory(workspace, jobId), "job.json");
}

function readJob(workspace, jobId) {
  let payload = readJson(jobPayloadPath(workspace, jobId));
  if (payload.status === "running" && !activeJobs.has(`${workspace.id}/${jobId}`)) {
    let alive = false;
    try { process.kill(payload.pid, 0); alive = true; } catch {}
    if (!alive) {
      payload = { ...payload, status: "interrupted", finishedAt: nowIso() };
      writeJsonAtomic(jobPayloadPath(workspace, jobId), payload);
    }
  }
  const logPath = path.join(jobDirectory(workspace, jobId), "log.txt");
  return {
    ...payload,
    params: readJson(path.join(jobDirectory(workspace, jobId), "params.json"), {}),
    log: fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "",
    result: readJson(path.join(jobDirectory(workspace, jobId), "stage-result.json"), null),
  };
}

export function listJobs(workspaceId) {
  const workspace = loadWorkspace(workspaceId);
  if (!fs.existsSync(workspace.paths.jobs)) return [];
  return fs.readdirSync(workspace.paths.jobs, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && fs.existsSync(jobPayloadPath(workspace, entry.name)))
    .map(entry => readJob(workspace, entry.name))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function listRunningJobs(workspaceId) {
  const workspace = loadWorkspace(workspaceId);
  if (!fs.existsSync(workspace.paths.jobs)) return [];
  return fs.readdirSync(workspace.paths.jobs, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && fs.existsSync(jobPayloadPath(workspace, entry.name)))
    .filter(entry => readJson(jobPayloadPath(workspace, entry.name)).status === "running")
    .map(entry => readJob(workspace, entry.name))
    .filter(job => job.status === "running")
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function getJob(workspaceId, jobId) {
  return readJob(loadWorkspace(workspaceId), jobId);
}

export function startJob(workspaceId, action, params = {}) {
  const workspace = loadWorkspace(workspaceId);
  const running = listJobs(workspace.id).find(job => job.status === "running");
  if (running) throw new Error(`Job ${running.id} is already running for this workspace`);
  const jobId = `${Date.now()}-${action}`;
  const directory = jobDirectory(workspace, jobId);
  fs.mkdirSync(directory, { recursive: true });
  const paramsPath = path.join(directory, "params.json");
  writeJsonAtomic(paramsPath, params);
  const payload = {
    schemaVersion: 1,
    id: jobId,
    workspaceId: workspace.id,
    versionId: workspace.activeVersionId,
    action,
    status: "running",
    createdAt: nowIso(),
    startedAt: nowIso(),
    finishedAt: null,
    exitCode: null,
    pid: null,
  };
  writeJsonAtomic(jobPayloadPath(workspace, jobId), payload);
  const logStream = fs.createWriteStream(path.join(directory, "log.txt"), { flags: "a" });
  const child = spawn(process.execPath, [runnerPath, workspace.id, action, paramsPath, directory], {
    cwd: workspace.paths.root,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  payload.pid = child.pid;
  writeJsonAtomic(jobPayloadPath(workspace, jobId), payload);
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);
  activeJobs.set(`${workspace.id}/${jobId}`, child);
  child.on("close", exitCode => {
    logStream.end();
    activeJobs.delete(`${workspace.id}/${jobId}`);
    const latest = readJson(jobPayloadPath(workspace, jobId));
    writeJsonAtomic(jobPayloadPath(workspace, jobId), {
      ...latest,
      status: exitCode === 0 ? "completed" : "failed",
      exitCode,
      finishedAt: nowIso(),
    });
  });
  return readJob(workspace, jobId);
}
