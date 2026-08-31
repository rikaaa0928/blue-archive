import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { listJobs } from "./lib/jobs.mjs";
import { getProduction, hasProduction } from "./lib/production.mjs";
import { reconcileWorkspace } from "./lib/reconcile.mjs";
import { localFilesRoot, nowIso, readJson, writeJsonAtomic } from "./lib/utils.mjs";
import { ensureWorkspace } from "./lib/workspaces.mjs";

const runnerPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "stage-runner.mjs");
export function nextBatchStep(state, production = null) {
  if (!state.tables.ready) return { gate: "tables", label: "原始表未就绪" };
  if (!production) return { action: "production-prepare" };
  if (production.cn.generationCount === 0) return { action: "production-cn-generate" };
  if (production.voice.speakers.scannedAt === null) return { action: "production-speaker-scan" };
  if (production.voice.script.generationCount === 0) {
    return { action: "production-voice-script-generate" };
  }
  const pending = [];
  if (!production.cn.ready) pending.push("简中整体审查");
  if (!production.voice.speakers.ready) {
    pending.push(`${production.voice.speakers.unresolvedCount} 个说话人例外`);
  }
  if (!production.voice.script.ready) pending.push("配音稿整体审查");
  if (pending.length) {
    return { gate: "production-human", label: `等待${pending.join("、")}` };
  }
  return { gate: "production-prerequisites-complete", label: "两条线路前置任务已完成" };
}

function updateBatch(batchPath, transform) {
  const current = readJson(batchPath);
  writeJsonAtomic(batchPath, transform(current));
}

function updateItem(batchPath, storyId, patch) {
  updateBatch(batchPath, batch => ({
    ...batch,
    items: batch.items.map(item => item.storyId === storyId ? { ...item, ...patch } : item),
  }));
}

function runAction(workspace, action, params, batchDirectory) {
  const jobId = `${Date.now()}-batch-${action}`;
  const directory = path.join(workspace.paths.jobs, jobId);
  fs.mkdirSync(directory, { recursive: true });
  const actionParams = action === "production-cn-generate" ? params.llm ?? {} :
    action === "production-voice-script-generate" ? params.voiceDraft ?? {} : {};
  const paramsPath = path.join(directory, "params.json");
  writeJsonAtomic(paramsPath, actionParams);
  const jobPath = path.join(directory, "job.json");
  const payload = {
    schemaVersion: 1,
    id: jobId,
    workspaceId: workspace.id,
    versionId: workspace.activeVersionId,
    action,
    source: "series-batch",
    status: "running",
    createdAt: nowIso(),
    startedAt: nowIso(),
    finishedAt: null,
    exitCode: null,
    pid: process.pid,
  };
  writeJsonAtomic(jobPath, payload);
  const logPath = path.join(directory, "log.txt");
  const logFd = fs.openSync(logPath, "a");
  const result = spawnSync(
    process.execPath,
    [runnerPath, workspace.id, action, paramsPath, directory],
    { cwd: batchDirectory, env: process.env, stdio: ["ignore", logFd, logFd] },
  );
  fs.closeSync(logFd);
  const exitCode = result.status ?? 1;
  writeJsonAtomic(jobPath, {
    ...payload,
    status: exitCode === 0 ? "completed" : "failed",
    exitCode,
    finishedAt: nowIso(),
  });
  if (result.error) throw result.error;
  if (exitCode !== 0) throw new Error(`${action} failed; see ${logPath}`);
}

async function main() {
  const batchId = process.argv[2];
  const batchDirectory = path.join(localFilesRoot, "create-story", "_batches", batchId);
  const batchPath = path.join(batchDirectory, "batch.json");
  const batch = readJson(batchPath);
  for (const item of batch.items) {
    const workspace = ensureWorkspace({
      type: "event",
      storyId: item.storyId,
      directoryId: item.directoryId,
    });
    updateItem(batchPath, item.storyId, { status: "running", error: null });
    try {
      const running = listJobs(workspace.id).find(job => job.status === "running" && job.pid !== process.pid);
      if (running) throw new Error(`已有任务正在运行：${running.action}`);
      for (;;) {
        const step = nextBatchStep(
          reconcileWorkspace(workspace.id),
          hasProduction(workspace.id)
            ? getProduction(workspace.id, { includeStory: false, includeHistory: false })
            : null,
        );
        if (!step.action) {
          updateItem(batchPath, item.storyId, {
            status: "waiting",
            gate: step.gate,
            gateLabel: step.label,
          });
          console.log(`[${item.order}] ${item.storyId}: ${step.label}`);
          break;
        }
        console.log(`[${item.order}] ${item.storyId}: start ${step.action}`);
        updateItem(batchPath, item.storyId, { lastAction: step.action, gate: null });
        runAction(workspace, step.action, batch.params ?? {}, batchDirectory);
        console.log(`[${item.order}] ${item.storyId}: complete ${step.action}`);
      }
    } catch (error) {
      updateItem(batchPath, item.storyId, {
        status: "failed",
        error: error.message,
      });
      console.error(`[${item.order}] ${item.storyId}: ${error.stack || error.message}`);
    }
  }
  if (readJson(batchPath).items.some(item => item.status === "failed")) {
    process.exitCode = 2;
  }
}

const isDirectRun = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
