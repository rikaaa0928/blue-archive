import fs from "node:fs";
import path from "node:path";

import { getPlayerCharacterId } from "../../../create-story/ba-character-catalog.mjs";
import { anonymousNpcPresetVoice } from "../../../create-story/shared-config.mjs";
import { inferScenarioRole, parseScenarioScriptSpeakers } from "../../../create-story/scenario-script-speakers.mjs";
import {
  fileDigest,
  effectiveTtsText,
  loadEnvFiles,
  localFilesRoot,
  publicStoryPath,
  readJson,
  resolveTtsSkippedIndices,
  statSummary,
  storyDigest,
  writeJsonAtomic,
} from "./utils.mjs";
import {
  getLatestRevisionForStage,
  getRevision,
  listRevisionLineage,
  listRevisions,
  loadDraft,
  loadWorkspace,
  versionResourcePath,
  versionTtsManifestPath,
} from "./workspaces.mjs";
import { listJobs } from "./jobs.mjs";

const resourceAudioExtensions = new Set([".flac", ".m4a", ".mp3", ".ogg", ".opus", ".wav"]);

export const stageDefinitions = [
  { id: "sync", title: "同步原始表", kind: "automatic", shared: true },
  { id: "locate", title: "确认 GroupId", kind: "automatic" },
  { id: "raw-import", title: "导入多语言原稿", kind: "automatic" },
  { id: "cn-normalize", title: "繁转中与角色名规范", kind: "automatic" },
  { id: "cn-llm-1", title: "中文 LLM 校对 1", kind: "automatic", remote: true },
  { id: "cn-llm-2", title: "中文 LLM 校对 2", kind: "automatic", remote: true },
  { id: "voice-catalog", title: "查询角色语音可用性", kind: "automatic", remote: true },
  { id: "review-1", title: "剧情、中文与说话人审核", kind: "human" },
  { id: "voice-draft", title: "生成日语配音稿", kind: "automatic", remote: true },
  { id: "resources", title: "角色与参考音资源", kind: "resource" },
  { id: "review-2", title: "日语配音稿审核", kind: "human" },
  { id: "tts", title: "生成语音", kind: "automatic", remote: true },
  { id: "r2", title: "上传语音到 R2", kind: "automatic", remote: true },
  { id: "release-validate", title: "发布前校验", kind: "automatic" },
  { id: "publish", title: "写入 public/story", kind: "publish" },
  { id: "event-index", title: "更新活动索引", kind: "automatic" },
  { id: "final-playback", title: "最终播放检查", kind: "human" },
  { id: "record", title: "录制视频", kind: "optional" },
  { id: "cover", title: "封面管理", kind: "optional" },
];

const revisionStages = new Set([
  "raw-import", "cn-normalize", "cn-llm-1", "cn-llm-2", "review-1",
  "voice-draft", "review-2", "r2", "release-validate", "publish",
]);

const requiredTableFiles = [
  "ScenarioScriptDBSchema.json",
  "EventContentScenarioDBSchema.json",
  "EventContentSeasonDBSchema.json",
  "LocalizeDBSchema.json",
  "LocalizeEtcDBSchema.json",
  "ScenarioCharacterNameDBSchema.json",
];

function schemaDirectory() {
  loadEnvFiles();
  const schema = process.env.BA_SCENARIO_SCHEMA_PATH ||
    "/Volumes/storage/ba-asset-data-global/extracted/Table/ExcelDB/ScenarioScriptDBSchema.json";
  return path.dirname(schema);
}

export function inspectTables() {
  const directory = schemaDirectory();
  const cachePath = path.join(localFilesRoot, "create-story", "_shared", "table-scan.json");
  const cache = readJson(cachePath, { schemaVersion: 1, files: {} });
  let cacheChanged = false;
  const files = requiredTableFiles.map(name => {
    const filePath = path.join(directory, name);
    if (!fs.existsSync(filePath)) return { name, path: filePath, ready: false };
    try {
      const stat = fs.statSync(filePath);
      const cached = cache.files[filePath];
      if (cached && cached.size === stat.size && cached.mtimeMs === Math.trunc(stat.mtimeMs)) {
        return { name, path: filePath, ...cached, ready: true, cached: true };
      }
      const parsed = readJson(filePath);
      const rows = Array.isArray(parsed) ? parsed : parsed.content ?? parsed.DataList;
      const inspected = {
        name,
        ...statSummary(filePath),
        digest: fileDigest(filePath),
        rows: Array.isArray(rows) ? rows.length : null,
        ready: Array.isArray(rows),
      };
      if (inspected.ready) {
        cache.files[filePath] = {
          size: inspected.size,
          mtimeMs: inspected.mtimeMs,
          digest: inspected.digest,
          rows: inspected.rows,
        };
        cacheChanged = true;
      }
      return inspected;
    } catch (error) {
      return { name, path: filePath, ready: false, error: error.message };
    }
  });
  if (cacheChanged) writeJsonAtomic(cachePath, cache);
  const rawDatabase = path.resolve(directory, "..", "..", "raw", "Table", "ExcelDB.db");
  return {
    directory,
    ready: files.every(file => file.ready),
    files,
    rawDatabase: fs.existsSync(rawDatabase) ? statSummary(rawDatabase) : null,
    upstreamFreshness: "unknown",
    note: "本地就绪可自动确认；是否为上游最新版本只在主动同步时确认。",
  };
}

function readPlayerNameRows() {
  loadEnvFiles();
  const candidates = [
    process.env.BA_PLAYER_CHARACTER_NAME_TABLE_PATH,
    path.join(localFilesRoot, "player-data", "ScenarioCharacterNameExcelTable.json"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const data = readJson(candidate);
      const rows = Array.isArray(data) ? data : data.content ?? data.DataList;
      if (Array.isArray(rows)) return rows.map(row => row?.Bytes ?? row);
    } catch {}
  }
  return [];
}

export function inspectResources(story, workspaceId = null) {
  loadEnvFiles();
  const characterRoot = path.resolve(
    process.env.BA_CHARACTER_RESOURCE_ROOT || path.join(localFilesRoot, "ba-characters"),
  );
  const rows = readPlayerNameRows();
  const rowById = new Map(rows.map(row => [Number(row.CharacterName), row]));
  const review1Revision = workspaceId ? getLatestRevisionForStage(workspaceId, "review-1") : null;
  const workspace = workspaceId ? loadWorkspace(workspaceId) : null;
  const referenceSelections = workspace
    ? readJson(versionResourcePath(
      workspace.id, "reference-selections.json", { legacyFallback: true },
    ), {})
    : {};
  const speakerReviewByIndex = new Map(
    (review1Revision ? readJson(review1Revision.resultPath, {}).speakerReviews ?? [] : [])
      .map(review => [review.storyIndex, review]),
  );
  const speakers = new Map();
  for (let index = 0; index < (story?.content?.length ?? 0); index++) {
    const unit = story.content[index];
    if (!["dialogue", "narration"].includes(inferScenarioRole(unit))) continue;
    const { dialogueSpeaker } = parseScenarioScriptSpeakers(unit);
    const review = speakerReviewByIndex.get(index);
    const stableSpeakers = review?.kind === "collective"
      ? (review.members ?? []).map(speaker => ({ speaker, anonymous: false }))
      : review?.kind === "unknown-speaker"
        ? [{ speaker: review.resolvedSpeaker, anonymous: review.resolution === "anonymous" }]
        : [{ speaker: dialogueSpeaker, anonymous: false }];
    for (const candidate of stableSpeakers) {
      const stableSpeaker = candidate.speaker;
      const speakerKey = candidate.anonymous ? "__anonymous_npc__" : stableSpeaker;
      if (!stableSpeaker || speakers.has(speakerKey)) continue;
      if (candidate.anonymous) {
        speakers.set(speakerKey, {
          speakerKr: stableSpeaker,
          sourceSpeakerKr: dialogueSpeaker,
          characterId: null,
          characterName: anonymousNpcPresetVoice.characterName,
          resourceDirectory: "",
          resourceReady: true,
          referenceReady: true,
          referenceId: anonymousNpcPresetVoice.referenceId,
          resolution: "anonymous-npc",
          manualSelectionAvailable: false,
        });
        continue;
      }
      const characterId = getPlayerCharacterId(stableSpeaker);
      const row = rowById.get(characterId);
      const characterName = String(row?.NameCN || row?.NameJP || "");
      const resourceDirectory = characterName ? path.join(characterRoot, characterName) : "";
      const voiceDirectory = resourceDirectory ? path.join(resourceDirectory, "语音") : "";
      const resourceReady = Boolean(
        voiceDirectory && fs.existsSync(voiceDirectory) &&
        fs.readdirSync(voiceDirectory)
          .some(name => resourceAudioExtensions.has(path.extname(name).toLowerCase())),
      );
      const referenceSlug = `${stableSpeaker}_${characterName}`
        .normalize("NFKC")
        .replace(/[\\/:*?"<>|]/gu, "_")
        .replace(/\s+/gu, "_")
        .slice(0, 80);
      const referenceManifest = characterName
        ? path.join(localFilesRoot, "tts", "references", referenceSlug, "reference-manifest.json")
        : "";
      const preparedReference = referenceManifest ? readJson(referenceManifest, null) : null;
      const preparedClipNames = Array.isArray(preparedReference?.clips)
        ? preparedReference.clips.map(clip => String(clip.name))
        : [];
      const manualClipNames = Array.isArray(referenceSelections[stableSpeaker])
        ? referenceSelections[stableSpeaker].map(String)
        : [];
      const manualSelectionMatches = manualClipNames.length === 0 || (
        manualClipNames.length === preparedClipNames.length &&
        manualClipNames.every((name, index) => name === preparedClipNames[index])
      );
      speakers.set(speakerKey, {
        speakerKr: stableSpeaker,
        sourceSpeakerKr: dialogueSpeaker,
        characterId,
        characterName,
        resourceDirectory,
        resourceReady,
        referenceReady: Boolean(
          referenceManifest && fs.existsSync(referenceManifest) && manualSelectionMatches,
        ),
        referenceManifest,
        selectedClipCount: preparedClipNames.length,
        selectionSource: manualClipNames.length > 0 ? "manual" : "automatic",
        resolution: row ? "player-character-table" : "unresolved",
        manualSelectionAvailable: true,
      });
    }
  }
  const items = [...speakers.values()];
  return {
    characterRoot,
    ready: items.length > 0 && items.every(item => item.resourceReady && item.referenceReady),
    items,
  };
}

function inspectTtsManifest(workspace, current) {
  const defaultPath = versionTtsManifestPath(workspace.id);
  const review2 = getLatestRevisionForStage(workspace.id, "review-2");
  const review2Result = review2 ? readJson(review2.resultPath, {}) : {};
  const skippedIndices = new Set(resolveTtsSkippedIndices(current?.story, review2Result));
  const expectedTextByIndex = new Map((review2Result.ttsPlan ?? []).flatMap(item => {
    const index = Number(item.index);
    const text = String(item.expected?.ttsText ?? "").trim();
    return Number.isSafeInteger(index) && text && !skippedIndices.has(index) ? [[index, text]] : [];
  }));
  if (!fs.existsSync(defaultPath)) return {
    path: defaultPath,
    exists: false,
    completed: 0,
    total: expectedTextByIndex.size,
    manifestTasks: 0,
    referencesTotal: 0,
    referencesUploaded: 0,
  };
  try {
    const manifest = readJson(defaultPath);
    const tasks = Object.values(manifest.tasks ?? {});
    const matchingTasks = tasks.filter(task => {
      const expected = expectedTextByIndex.get(Number(task.index));
      const generated = String(
        task.generatedText ?? task.downloadedText ?? task.text ?? "",
      ).trim();
      return expected && generated === expected;
    });
    const completedTasks = matchingTasks.filter(task =>
      ["completed", "COMPLETED"].includes(task.status) || Boolean(task.localPath || task.audioPath));
    const references = Object.values(manifest.references ?? {});
    return {
      path: defaultPath,
      exists: true,
      total: expectedTextByIndex.size,
      completed: completedTasks.length,
      manifestTasks: tasks.length,
      matchingTasks: matchingTasks.length,
      active: matchingTasks.filter(task => !new Set(["COMPLETED", "FAILED", "CANCELLED"])
        .has(String(task.status).toUpperCase())).length,
      failed: matchingTasks.filter(task => new Set(["FAILED", "CANCELLED"])
        .has(String(task.status).toUpperCase())).length,
      referencesTotal: references.length,
      referencesUploaded: references.filter(reference => reference.referenceId).length,
      matchesCurrent: expectedTextByIndex.size > 0 &&
        completedTasks.length === expectedTextByIndex.size,
      digest: fileDigest(defaultPath),
    };
  } catch (error) {
    return { path: defaultPath, exists: true, corrupt: true, error: error.message };
  }
}

function inspectVoiceAvailability(workspace, current) {
  const availabilityPath = versionResourcePath(
    workspace.id, "voice-availability.json", { legacyFallback: true },
  );
  if (!fs.existsSync(availabilityPath)) {
    return { path: availabilityPath, exists: false, complete: false, total: 0, unavailable: 0 };
  }
  try {
    const result = readJson(availabilityPath);
    const items = Array.isArray(result.items) ? result.items : [];
    const complete = Boolean(current && result.storyDigest === storyDigest(current.story));
    return {
      path: availabilityPath,
      exists: true,
      complete,
      checkedAt: result.checkedAt,
      sourceRevision: result.sourceRevision,
      storyDigest: result.storyDigest,
      total: items.length,
      available: items.filter(item => item.available === true).length,
      unavailable: items.filter(item => item.available === false).length,
      items,
    };
  } catch (error) {
    return { path: availabilityPath, exists: true, complete: false, corrupt: true, error: error.message };
  }
}

export function reconcileWorkspace(workspaceId) {
  const workspace = loadWorkspace(workspaceId);
  const revisions = listRevisions(workspace.id);
  const lineage = listRevisionLineage(workspace.id);
  const current = getRevision(workspace.id);
  const revisionByStage = new Map();
  const stageOrder = new Map(stageDefinitions.map((stage, index) => [stage.id, index]));
  for (const revision of lineage) {
    const revisionIndex = stageOrder.get(revision.stage);
    if (revisionIndex !== undefined) {
      for (const existingStage of revisionByStage.keys()) {
        if ((stageOrder.get(existingStage) ?? -1) >= revisionIndex) {
          revisionByStage.delete(existingStage);
        }
      }
    }
    revisionByStage.set(revision.stage, revision);
  }
  const tables = inspectTables();
  const voiceAvailability = inspectVoiceAvailability(workspace, current);
  const resources = inspectResources(current?.story, workspace.id);
  const tts = inspectTtsManifest(workspace, current);
  const publicPath = publicStoryPath(workspace.identity);
  let publicArtifact = { path: publicPath, exists: false };
  if (fs.existsSync(publicPath)) {
    try {
      const story = readJson(publicPath);
      publicArtifact = {
        path: publicPath,
        exists: true,
        digest: storyDigest(story),
        matchesCurrent: current ? storyDigest(story) === storyDigest(current.story) : false,
      };
    } catch (error) {
      publicArtifact = { path: publicPath, exists: true, corrupt: true, error: error.message };
    }
  }
  const versionedFinalPlaybackPath = path.join(
    workspace.paths.root,
    `final-playback-${workspace.activeVersionId}.json`,
  );
  const legacyFinalPlaybackPath = path.join(workspace.paths.root, "final-playback.json");
  const finalPlaybackPath = fs.existsSync(versionedFinalPlaybackPath)
    ? versionedFinalPlaybackPath
    : workspace.activeVersionId === "v001" ? legacyFinalPlaybackPath : versionedFinalPlaybackPath;
  const finalPlayback = readJson(finalPlaybackPath, null);
  const finalPlaybackComplete = Boolean(
    finalPlayback?.completedAt && publicArtifact.digest &&
    finalPlayback.storyDigest === publicArtifact.digest,
  );
  const jobs = listJobs(workspace.id).filter(job =>
    job.versionId === workspace.activeVersionId ||
    (!job.versionId && workspace.activeVersionId === "v001"));
  const completedRecord = jobs.find(job =>
    job.action === "record" && job.status === "completed" &&
    job.result?.summary?.output && fs.existsSync(job.result.summary.output),
  );
  const completedEventIndex = jobs.find(job =>
    job.action === "event-index" && job.status === "completed" &&
    job.result?.summary?.output && fs.existsSync(job.result.summary.output),
  );
  const versionedCoverSelectionPath = path.join(
    workspace.paths.resources, `cover-selection-${workspace.activeVersionId}.json`,
  );
  const legacyCoverSelectionPath = path.join(workspace.paths.resources, "cover-selection.json");
  const globalCoverSelectionPath = path.join(
    localFilesRoot, "covers", ".selections", `${workspace.identity.storyId}.json`,
  );
  const coverSelectionPath = [
    versionedCoverSelectionPath,
    legacyCoverSelectionPath,
    globalCoverSelectionPath,
  ].find(candidate => fs.existsSync(candidate)) ?? versionedCoverSelectionPath;
  const coverSelection = readJson(coverSelectionPath, null);
  const selectedCoverPath = coverSelection?.name
    ? path.join(localFilesRoot, "covers", path.basename(coverSelection.name))
    : "";
  const coverComplete = Boolean(selectedCoverPath && fs.existsSync(selectedCoverPath));
  const activeVersion = workspace.versions.find(version => version.id === workspace.activeVersionId);
  const inheritedCompletedStages = new Set(activeVersion?.inheritedCompletedStages ?? []);

  const stages = stageDefinitions.map((definition, index) => {
    let status = "locked";
    let detail = "等待前置步骤";
    const revision = revisionByStage.get(definition.id);
    if (definition.id === "sync") {
      status = tables.ready ? "completed" : "ready";
      detail = tables.ready ? "六张本地表可解析" : "需要同步或指定本地数据目录";
    } else if (definition.id === "locate") {
      status = workspace.identity.storyId ? "completed" : "ready";
      detail = `GroupId ${workspace.identity.storyId}`;
    } else if (revisionStages.has(definition.id) && revision && !revision.corrupt) {
      status = "completed";
      detail = revision.name;
    } else if (definition.id === "voice-catalog") {
      status = voiceAvailability.complete
        ? "completed"
        : revisionByStage.has("cn-llm-2") ? "ready" : "locked";
      detail = voiceAvailability.complete
        ? revisionByStage.has("review-1")
          ? `${voiceAvailability.available}/${voiceAvailability.total} 个说话人有日语语音，` +
            `${voiceAvailability.unavailable} 个无直接下载源（已完成说话人审核）`
          : `${voiceAvailability.available}/${voiceAvailability.total} 个说话人有日语语音，` +
            `${voiceAvailability.unavailable} 个无直接下载源（将在下一步审核）`
        : voiceAvailability.exists ? "剧情已变化，需要重新查询" : "等待查询角色语音下载源";
    } else if (definition.id === "resources") {
      status = resources.ready ? "completed" : revisionByStage.has("voice-draft") ? "ready" : "locked";
      detail = resources.ready
        ? `${resources.items.length} 个角色资源与参考音已就绪`
        : `${resources.items.filter(item => item.resourceReady).length}/${resources.items.length} 个角色资源目录就绪`;
    } else if (definition.id === "tts") {
      status = tts.matchesCurrent ? "completed" :
        revisionByStage.has("review-2") ? "ready" : "locked";
      detail = `${tts.completed}/${tts.total} 条语音完成`;
    } else if (definition.id === "publish" && revision && publicArtifact.exists && publicArtifact.matchesCurrent) {
      status = "completed";
      detail = "public/story 与当前修订一致";
    } else if (definition.id === "final-playback" && finalPlaybackComplete) {
      status = "completed";
      detail = `完成于 ${finalPlayback.completedAt}`;
    } else if (definition.id === "event-index") {
      status = workspace.identity.type !== "event" ? "not-applicable" :
        completedEventIndex ? "completed" : revisionByStage.has("publish") ? "ready" : "locked";
      detail = workspace.identity.type !== "event" ? "仅活动剧情需要" :
        completedEventIndex ? completedEventIndex.result.summary.output : "发布后更新活动索引";
    } else if (definition.id === "record") {
      status = completedRecord ? "completed" : finalPlaybackComplete ? "ready" : "locked";
      detail = completedRecord ? completedRecord.result.summary.output :
        finalPlaybackComplete ? "可选步骤" : "等待最终播放检查";
    } else if (definition.id === "cover") {
      status = coverComplete ? "completed" : finalPlaybackComplete ? "ready" : "locked";
      detail = coverComplete ? coverSelection.name :
        finalPlaybackComplete ? "可选步骤" : "等待最终播放检查";
    } else {
      const previousRequired = stagesCompletedBefore(
        index, definition.id, revisionByStage, tables, voiceAvailability, resources, tts,
      );
      if (previousRequired) {
        const reviewTool = definition.id === "review-1" ? "tool1" : "tool2";
        status = definition.kind === "human" && loadDraft(workspace.id, reviewTool)
          ? "in-progress"
          : "ready";
        detail = definition.kind === "human" ? "等待人工审核" : "可以执行";
      }
    }
    if (inheritedCompletedStages.has(definition.id) && status !== "not-applicable") {
      status = "completed";
      detail = `继承自 ${activeVersion.parentVersionId}`;
    }
    return { ...definition, status, detail, revision: revision?.name ?? null };
  });
  return {
    workspace: {
      id: workspace.id,
      identity: workspace.identity,
      currentRevision: workspace.currentRevision,
      updatedAt: workspace.updatedAt,
      activeVersionId: workspace.activeVersionId,
      versions: workspace.versions.map(version => {
        const revision = version.currentRevision
          ? revisions.find(candidate => candidate.name === version.currentRevision)
          : null;
        return {
          ...version,
          currentStage: revision?.stage ?? null,
          active: version.id === workspace.activeVersionId,
        };
      }),
    },
    current: current ? {
      revision: current.name,
      stage: current.stage,
      digest: storyDigest(current.story),
      rows: current.story.content.length,
    } : null,
    stages,
    tables,
    voiceAvailability,
    resources,
    tts,
    publicArtifact,
    finalPlayback: { path: finalPlaybackPath, complete: finalPlaybackComplete, ...finalPlayback },
    cover: { complete: coverComplete, selection: coverSelection, path: selectedCoverPath || null },
    revisions: lineage.map(revision => ({
      name: revision.name,
      stage: revision.stage,
      versionId: revision.versionId,
      createdAt: revision.metadata?.createdAt,
      digest: revision.metadata?.storyDigest,
      corrupt: revision.corrupt,
    })),
  };
}

function stagesCompletedBefore(index, stageId, revisionByStage, tables, voiceAvailability, resources, tts) {
  if (stageId === "raw-import") return tables.ready;
  const required = {
    "cn-normalize": "raw-import",
    "cn-llm-1": "cn-normalize",
    "cn-llm-2": "cn-llm-1",
    "voice-catalog": "cn-llm-2",
    "review-1": "voice-catalog",
    "voice-draft": "review-1",
    "review-2": "resources",
    "tts": "review-2",
    "r2": "tts",
    "release-validate": "r2",
    "publish": "release-validate",
    "final-playback": "publish",
  }[stageId];
  if (!required) return index <= 1;
  if (required === "voice-catalog") return voiceAvailability.complete;
  if (required === "resources") return resources.ready;
  if (required === "tts") return Boolean(tts.matchesCurrent);
  return revisionByStage.has(required);
}
