import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { listJobs } from "./lib/jobs.mjs";
import {
  approveCn,
  approveVoiceScript,
  buildProductionStory,
  getProduction,
  hasProduction,
  updateProductionBranches,
  updateSpeakerResolution,
} from "./lib/production.mjs";
import { reconcileWorkspace } from "./lib/reconcile.mjs";
import { localFilesRoot, nowIso, readJson, writeJsonAtomic } from "./lib/utils.mjs";
import { ensureWorkspace } from "./lib/workspaces.mjs";

const runnerPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "stage-runner.mjs");
export function nextBatchStep(state, production = null, mode = "review") {
  if (!state.tables.ready) return { gate: "tables", label: "原始表未就绪" };
  if (!production) return { action: "production-prepare" };
  if (!production.cn.ready && production.cn.generationCount === 0) {
    return { action: "production-cn-generate" };
  }
  if (mode === "complete" && !production.cn.ready) {
    return { action: "production-cn-approve" };
  }
  if (production.voice.speakers.scannedAt === null) return { action: "production-speaker-scan" };
  if (mode === "complete" && !production.voice.speakers.ready) {
    return { action: "production-speakers-default-npc" };
  }
  if (!production.voice.script.ready && production.voice.script.generationCount === 0) {
    return { action: "production-voice-script-generate" };
  }
  if (mode === "complete" && !production.voice.script.ready) {
    return { action: "production-voice-script-approve" };
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
  if (mode !== "complete") {
    return { gate: "production-prerequisites-complete", label: "两条线路前置任务已完成" };
  }
  if (!production.voice.references.ready) return { action: "production-reference-prepare" };
  if (!production.voice.tts.voiceStoryReady) return { action: "production-tts" };
  if (!production.assembly.current) return { action: "production-assemble" };
  if (production.assembly.inspection.errors.length) {
    return {
      gate: "production-structure-error",
      label: `结构检查失败：${production.assembly.inspection.errors.join("；")}`,
    };
  }
  const choices = production.assembly.inspection.choices;
  const checked = new Set(production.preview.branches.checkedSelectionKeys);
  const branchesReady = choices.every(choice => {
    const options = choice.options.filter(option => option.selectionGroup > 0);
    return options.every(option => checked.has(option.key)) &&
      (!options.length || options.some(option => option.selectionGroup ===
        Number(production.preview.branches.defaultSelectionGroups[choice.index])));
  });
  if (!branchesReady) return { action: "production-branches-default" };
  if (!production.recording.current) return { action: "production-record" };
  return { gate: "production-recording-complete", label: "录制与完整性验收已完成" };
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
    action === "production-voice-script-generate" ? params.voiceDraft ?? {} :
    action === "production-tts" ? params.tts ?? {} :
    action === "production-record" ? { subtitle: "cn", ...(params.recording ?? {}) } : {};
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

function runInlineAction(workspace, action) {
  if (action === "production-cn-approve") {
    approveCn(workspace.id, "", "批处理自动采用最新 LLM 结果");
    return true;
  }
  if (action === "production-speakers-default-npc") {
    const production = getProduction(workspace.id, { includeStory: false, includeHistory: false });
    for (const item of production.voice.speakers.items.filter(item => item.requiresHuman && !item.resolution)) {
      updateSpeakerResolution(workspace.id, item.stableKey, { type: "npc" }, "批处理按默认 NPC 处理未知身份");
    }
    return true;
  }
  if (action === "production-voice-script-approve") {
    approveVoiceScript(workspace.id, "", "批处理自动采用最新 LLM 结果");
    return true;
  }
  if (action === "production-assemble") {
    buildProductionStory(workspace.id);
    return true;
  }
  if (action === "production-branches-default") {
    const production = getProduction(workspace.id, { includeStory: false, includeHistory: false });
    const defaultSelectionGroups = {};
    const checkedSelectionKeys = [];
    for (const choice of production.assembly.inspection.choices) {
      const options = choice.options.filter(option => option.selectionGroup > 0);
      checkedSelectionKeys.push(...options.map(option => option.key));
      const existing = Number(production.preview.branches.defaultSelectionGroups[choice.index]);
      if (options.length && !options.some(option => option.selectionGroup === existing)) {
        defaultSelectionGroups[choice.index] = options[0].selectionGroup;
      }
    }
    updateProductionBranches(workspace.id, {
      defaultSelectionGroups,
      checkedSelectionKeys,
      note: "批处理检查全部分支，并仅为缺少有效默认值的选择页补选第一个分支",
    });
    return true;
  }
  return false;
}

async function main() {
  const batchId = process.argv[2];
  const batchDirectory = path.join(localFilesRoot, "create-story", "_batches", batchId);
  const batchPath = path.join(batchDirectory, "batch.json");
  const batch = readJson(batchPath);
  for (const item of batch.items) {
    const workspace = ensureWorkspace({
      type: batch.series.type,
      storyId: item.storyId,
      directoryId: item.directoryId || "",
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
          batch.mode ?? "review",
        );
        if (!step.action) {
          updateItem(batchPath, item.storyId, {
            status: step.gate === "production-recording-complete" ? "completed" : "waiting",
            gate: step.gate,
            gateLabel: step.label,
          });
          console.log(`[${item.order}] ${item.storyId}: ${step.label}`);
          break;
        }
        console.log(`[${item.order}] ${item.storyId}: start ${step.action}`);
        updateItem(batchPath, item.storyId, { lastAction: step.action, gate: null });
        if (!runInlineAction(workspace, step.action)) {
          runAction(workspace, step.action, batch.params ?? {}, batchDirectory);
        }
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
