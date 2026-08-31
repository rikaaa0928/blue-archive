import fs from "node:fs";
import path from "node:path";

import {
  nowIso,
  localFilesRoot,
  parseWorkspaceId,
  readJson,
  storyDigest,
  validateStoryIdentity,
  workspaceDirectory,
  workspaceId,
  workspaceRoot,
  writeJsonAtomic,
} from "./utils.mjs";

const revisionPattern = /^r(\d{6})-([a-z0-9-]+)$/u;
export const workflowStageIds = Object.freeze([
  "sync", "locate", "raw-import", "cn-normalize", "cn-llm-1", "cn-llm-2",
  "voice-catalog", "review-1", "voice-draft", "resources", "review-2", "tts",
  "r2", "release-validate", "publish", "event-index", "final-playback", "record", "cover",
]);

function normalizedManifest(manifest) {
  if (Array.isArray(manifest.versions) && manifest.versions.length) {
    const activeVersionId = manifest.activeVersionId || manifest.versions.at(-1).id;
    const versions = manifest.versions.map(version => ({
      ...version,
      currentRevision: version.currentRevision ?? null,
    }));
    const active = versions.find(version => version.id === activeVersionId) ?? versions.at(-1);
    return {
      ...manifest,
      schemaVersion: Math.max(Number(manifest.schemaVersion) || 1, 2),
      activeVersionId: active.id,
      currentRevision: active.currentRevision,
      versions,
    };
  }
  const createdAt = manifest.createdAt || nowIso();
  return {
    ...manifest,
    schemaVersion: 2,
    activeVersionId: "v001",
    versions: [{
      id: "v001",
      label: "版本 1",
      createdAt,
      parentVersionId: null,
      forkedFromRevision: null,
      restartStage: "sync",
      currentRevision: manifest.currentRevision ?? null,
    }],
  };
}

function migrateLegacyArtifactDirectories(paths) {
  if (!fs.existsSync(paths.artifacts)) return;
  for (const entry of fs.readdirSync(paths.artifacts, { withFileTypes: true })) {
    if (!entry.isDirectory() || !revisionPattern.test(entry.name)) continue;
    const source = path.join(paths.artifacts, entry.name);
    let versionId = "v001";
    try {
      versionId = readJson(path.join(source, "metadata.json"), {}).versionId || "v001";
    } catch {}
    if (!/^v\d+$/u.test(versionId)) versionId = "v001";
    const target = path.join(paths.artifacts, versionId, entry.name);
    if (fs.existsSync(target)) {
      throw new Error(`Cannot migrate revision because target already exists: ${target}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(source, target);
  }
}

export function workspacePaths(identityOrId) {
  const identity = typeof identityOrId === "string"
    ? parseWorkspaceId(identityOrId)
    : validateStoryIdentity(identityOrId);
  const root = workspaceDirectory(identity);
  return {
    identity,
    id: workspaceId(identity),
    root,
    manifest: path.join(root, "workspace.json"),
    artifacts: path.join(root, "artifacts"),
    drafts: path.join(root, "drafts"),
    resources: path.join(root, "resources"),
    jobs: path.join(root, "jobs"),
  };
}

export function ensureWorkspace(identity) {
  const paths = workspacePaths(identity);
  if (!fs.existsSync(paths.manifest)) {
    fs.mkdirSync(paths.artifacts, { recursive: true });
    fs.mkdirSync(paths.drafts, { recursive: true });
    fs.mkdirSync(paths.resources, { recursive: true });
    fs.mkdirSync(paths.jobs, { recursive: true });
    const timestamp = nowIso();
    writeJsonAtomic(paths.manifest, {
      schemaVersion: 2,
      id: paths.id,
      identity: paths.identity,
      createdAt: timestamp,
      updatedAt: timestamp,
      currentRevision: null,
      activeVersionId: "v001",
      versions: [{
        id: "v001",
        label: "版本 1",
        createdAt: timestamp,
        parentVersionId: null,
        forkedFromRevision: null,
        restartStage: "sync",
        currentRevision: null,
      }],
    });
  }
  return loadWorkspace(paths.id);
}

export function loadWorkspace(identityOrId) {
  const paths = workspacePaths(identityOrId);
  const raw = readJson(paths.manifest);
  const manifest = normalizedManifest(raw);
  if (JSON.stringify(raw) !== JSON.stringify(manifest)) {
    writeJsonAtomic(paths.manifest, manifest);
  }
  migrateLegacyArtifactDirectories(paths);
  return { ...manifest, paths };
}

export function getActiveVersion(identityOrId) {
  const workspace = loadWorkspace(identityOrId);
  return workspace.versions.find(version => version.id === workspace.activeVersionId);
}

export function listVersions(identityOrId) {
  return loadWorkspace(identityOrId).versions.map(version => ({ ...version }));
}

export function listWorkspaces() {
  if (!fs.existsSync(workspaceRoot)) return [];
  const manifests = [];
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(entryPath);
      else if (entry.name === "workspace.json") manifests.push(entryPath);
    }
  };
  walk(workspaceRoot);
  return manifests.flatMap(manifestPath => {
    try {
      const manifest = readJson(manifestPath);
      const workspace = loadWorkspace(manifest.id);
      const current = getRevision(workspace.id);
      return [{
        ...workspace,
        revisionCount: listRevisions(workspace.id).length,
        versionCount: workspace.versions.length,
        latestStage: current?.stage ?? null,
      }];
    } catch (error) {
      return [{
        id: path.relative(workspaceRoot, path.dirname(manifestPath)),
        corrupt: true,
        error: error.message,
      }];
    }
  }).sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
}

export function listRevisions(identityOrId) {
  const paths = workspacePaths(identityOrId);
  if (!fs.existsSync(paths.artifacts)) return [];
  const revisionDirectories = [];
  for (const entry of fs.readdirSync(paths.artifacts, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (revisionPattern.test(entry.name)) {
      revisionDirectories.push({ entry, root: path.join(paths.artifacts, entry.name) });
      continue;
    }
    if (!/^v\d+$/u.test(entry.name)) continue;
    const versionRoot = path.join(paths.artifacts, entry.name);
    for (const revisionEntry of fs.readdirSync(versionRoot, { withFileTypes: true })) {
      if (revisionEntry.isDirectory() && revisionPattern.test(revisionEntry.name)) {
        revisionDirectories.push({
          entry: revisionEntry,
          root: path.join(versionRoot, revisionEntry.name),
        });
      }
    }
  }
  return revisionDirectories
    .map(({ entry, root }) => {
      const match = revisionPattern.exec(entry.name);
      let metadata = null;
      let error = null;
      try {
        metadata = readJson(path.join(root, "metadata.json"));
      } catch (cause) {
        error = cause.message;
      }
      return {
        name: entry.name,
        number: Number(match[1]),
        stage: match[2],
        root,
        storyPath: path.join(root, "story.json"),
        resultPath: path.join(root, "result.json"),
        metadataPath: path.join(root, "metadata.json"),
        metadata,
        versionId: metadata?.versionId || "v001",
        corrupt: Boolean(error),
        error,
      };
    })
    .sort((a, b) => a.number - b.number);
}

export function getRevision(identityOrId, revisionName = null) {
  const workspace = loadWorkspace(identityOrId);
  const revisions = listRevisions(workspace.id);
  const wanted = revisionName || workspace.currentRevision;
  if (!wanted) return null;
  const revision = revisions.find(candidate => candidate.name === wanted);
  if (!revision) throw new Error(`Revision does not exist: ${wanted}`);
  return {
    ...revision,
    story: readJson(revision.storyPath),
    result: readJson(revision.resultPath, {}),
  };
}

export function listRevisionLineage(identityOrId, revisionName = null) {
  const workspace = loadWorkspace(identityOrId);
  const revisions = listRevisions(workspace.id);
  const byName = new Map(revisions.map(revision => [revision.name, revision]));
  let name = revisionName ?? workspace.currentRevision;
  const lineage = [];
  const seen = new Set();
  while (name) {
    if (seen.has(name)) throw new Error(`Revision lineage contains a cycle at ${name}`);
    seen.add(name);
    const revision = byName.get(name);
    if (!revision) throw new Error(`Revision lineage references missing revision: ${name}`);
    lineage.push(revision);
    name = revision.metadata?.inputRevision ?? null;
  }
  return lineage.reverse();
}

export function getLatestRevisionForStage(identityOrId, stage) {
  return listRevisionLineage(identityOrId).filter(revision => revision.stage === stage).at(-1) ?? null;
}

export function createRevision(identityOrId, {
  stage,
  story,
  result = {},
  inputRevision = null,
  metadata = {},
  extraJsonFiles = {},
}) {
  if (!/^[a-z0-9-]+$/u.test(stage)) throw new Error(`Invalid stage: ${stage}`);
  if (!story || !Array.isArray(story.content)) {
    throw new Error("A complete story object with content[] is required");
  }
  const workspace = loadWorkspace(identityOrId);
  const revisions = listRevisions(workspace.id);
  const number = (revisions.at(-1)?.number ?? 0) + 1;
  const revisionName = `r${String(number).padStart(6, "0")}-${stage}`;
  const versionArtifactsRoot = path.join(workspace.paths.artifacts, workspace.activeVersionId);
  const finalRoot = path.join(versionArtifactsRoot, revisionName);
  const temporaryRoot = path.join(
    versionArtifactsRoot,
    `.${revisionName}.${process.pid}.${Date.now()}.tmp`,
  );
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const revisionMetadata = {
    schemaVersion: 1,
    revision: revisionName,
    stage,
    createdAt: nowIso(),
    inputRevision: inputRevision ?? workspace.currentRevision,
    storyDigest: storyDigest(story),
    ...metadata,
    versionId: workspace.activeVersionId,
  };
  try {
    writeJsonAtomic(path.join(temporaryRoot, "story.json"), story);
    writeJsonAtomic(path.join(temporaryRoot, "result.json"), result);
    writeJsonAtomic(path.join(temporaryRoot, "metadata.json"), revisionMetadata);
    for (const [fileName, value] of Object.entries(extraJsonFiles)) {
      if (!/^[A-Za-z0-9._-]+\.json$/u.test(fileName)) {
        throw new Error(`Invalid revision JSON filename: ${fileName}`);
      }
      writeJsonAtomic(path.join(temporaryRoot, fileName), value);
    }
    fs.renameSync(temporaryRoot, finalRoot);
  } catch (error) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
  const manifest = normalizedManifest(readJson(workspace.paths.manifest));
  writeJsonAtomic(workspace.paths.manifest, {
    ...manifest,
    updatedAt: nowIso(),
    currentRevision: revisionName,
    versions: manifest.versions.map(version => version.id === manifest.activeVersionId
      ? { ...version, currentRevision: revisionName, updatedAt: nowIso() }
      : version),
  });
  return getRevision(workspace.id, revisionName);
}

export function draftPath(identityOrId, tool) {
  if (!new Set(["tool1", "tool2"]).has(tool)) throw new Error(`Invalid review tool: ${tool}`);
  const workspace = loadWorkspace(identityOrId);
  return path.join(workspace.paths.drafts, workspace.activeVersionId, `${tool}.json`);
}

export function saveDraft(identityOrId, tool, draft) {
  writeJsonAtomic(draftPath(identityOrId, tool), {
    ...draft,
    updatedAt: nowIso(),
  });
}

export function loadDraft(identityOrId, tool) {
  const workspace = loadWorkspace(identityOrId);
  const versioned = draftPath(workspace.id, tool);
  if (fs.existsSync(versioned)) return readJson(versioned, null);
  const legacy = path.join(workspace.paths.drafts, `${tool}.json`);
  return workspace.activeVersionId === "v001" ? readJson(legacy, null) : null;
}

export function activateVersion(identityOrId, versionId) {
  const workspace = loadWorkspace(identityOrId);
  const version = workspace.versions.find(candidate => candidate.id === versionId);
  if (!version) throw new Error(`Unknown production version: ${versionId}`);
  writeJsonAtomic(workspace.paths.manifest, {
    ...workspace,
    paths: undefined,
    activeVersionId: version.id,
    currentRevision: version.currentRevision,
    updatedAt: nowIso(),
  });
  return loadWorkspace(workspace.id);
}

export function versionTtsManifestPath(identityOrId, { migrateLegacy = false } = {}) {
  const workspace = loadWorkspace(identityOrId);
  const target = path.join(
    workspace.paths.root, "versions", workspace.activeVersionId, "tts",
    "voice-zero-tts-manifest.json",
  );
  const legacy = path.join(
    localFilesRoot, "tts", workspace.identity.type, workspace.identity.storyId,
    "voice-zero-tts-manifest.json",
  );
  if (workspace.activeVersionId === "v001" && !fs.existsSync(target) && fs.existsSync(legacy)) {
    if (!migrateLegacy) return legacy;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(legacy, target, fs.constants.COPYFILE_EXCL);
  }
  return target;
}

export function versionResourcePath(identityOrId, name, { legacyFallback = false } = {}) {
  if (!/^[A-Za-z0-9._-]+\.json$/u.test(name)) throw new Error(`Invalid resource JSON name: ${name}`);
  const workspace = loadWorkspace(identityOrId);
  const target = path.join(workspace.paths.resources, workspace.activeVersionId, name);
  const legacy = path.join(workspace.paths.resources, name);
  return legacyFallback && workspace.activeVersionId === "v001" &&
    !fs.existsSync(target) && fs.existsSync(legacy)
    ? legacy
    : target;
}

export function createReworkVersion(identityOrId, {
  restartStage,
  label = "",
  inheritedCompletedStages = [],
}) {
  const workspace = loadWorkspace(identityOrId);
  const stage = String(restartStage ?? "");
  const targetIndex = workflowStageIds.indexOf(stage);
  if (targetIndex < 0) throw new Error(`Unknown rework stage: ${stage}`);
  const lineage = listRevisionLineage(workspace.id);
  const baseRevision = lineage.filter(revision => {
    const stageIndex = workflowStageIds.indexOf(revision.stage);
    return stageIndex >= 0 && stageIndex < targetIndex;
  }).at(-1) ?? null;
  const nextNumber = workspace.versions.reduce((max, version) => {
    const match = /^v(\d+)$/u.exec(version.id);
    return Math.max(max, match ? Number(match[1]) : 0);
  }, 0) + 1;
  const id = `v${String(nextNumber).padStart(3, "0")}`;
  const timestamp = nowIso();
  const version = {
    id,
    label: String(label).trim() || `版本 ${nextNumber}`,
    createdAt: timestamp,
    parentVersionId: workspace.activeVersionId,
    forkedFromRevision: workspace.currentRevision,
    restartStage: stage,
    currentRevision: baseRevision?.name ?? null,
    inheritedCompletedStages: [...new Set(inheritedCompletedStages)]
      .filter(stageId => workflowStageIds.indexOf(stageId) >= 0)
      .filter(stageId => workflowStageIds.indexOf(stageId) < targetIndex),
  };
  const parentTtsManifest = versionTtsManifestPath(workspace.id);
  const inheritedResourceFiles = [
    ["voice-catalog", "voice-availability.json"],
    ["resources", "reference-selections.json"],
  ].flatMap(([stageId, name]) => {
    if (targetIndex <= workflowStageIds.indexOf(stageId)) return [];
    const source = versionResourcePath(workspace.id, name, { legacyFallback: true });
    return fs.existsSync(source) ? [{ name, source }] : [];
  });
  const manifest = {
    ...workspace,
    paths: undefined,
    schemaVersion: 2,
    activeVersionId: id,
    currentRevision: version.currentRevision,
    updatedAt: timestamp,
    versions: [...workspace.versions, version],
  };
  writeJsonAtomic(workspace.paths.manifest, manifest);
  for (const resource of inheritedResourceFiles) {
    const target = path.join(workspace.paths.resources, id, resource.name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(resource.source, target, fs.constants.COPYFILE_EXCL);
  }
  if (targetIndex > workflowStageIds.indexOf("tts")) {
    const targetManifest = path.join(
      workspace.paths.root, "versions", id, "tts", "voice-zero-tts-manifest.json",
    );
    if (fs.existsSync(parentTtsManifest)) {
      fs.mkdirSync(path.dirname(targetManifest), { recursive: true });
      fs.copyFileSync(parentTtsManifest, targetManifest, fs.constants.COPYFILE_EXCL);
    }
  }
  if (targetIndex > workflowStageIds.indexOf("final-playback")) {
    const source = path.join(workspace.paths.root, `final-playback-${workspace.activeVersionId}.json`);
    const legacy = path.join(workspace.paths.root, "final-playback.json");
    const selectedSource = fs.existsSync(source)
      ? source
      : workspace.activeVersionId === "v001" && fs.existsSync(legacy) ? legacy : null;
    if (selectedSource) {
      fs.copyFileSync(
        selectedSource,
        path.join(workspace.paths.root, `final-playback-${id}.json`),
        fs.constants.COPYFILE_EXCL,
      );
    }
  }
  return { workspace: loadWorkspace(workspace.id), version };
}

export function createProductionVersion(identityOrId, { label = "" } = {}) {
  const workspace = loadWorkspace(identityOrId);
  const nextNumber = workspace.versions.reduce((max, version) => {
    const match = /^v(\d+)$/u.exec(version.id);
    return Math.max(max, match ? Number(match[1]) : 0);
  }, 0) + 1;
  const id = `v${String(nextNumber).padStart(3, "0")}`;
  const timestamp = nowIso();
  const version = {
    id,
    label: String(label).trim() || `版本 ${nextNumber}`,
    createdAt: timestamp,
    parentVersionId: workspace.activeVersionId,
    forkedFromRevision: null,
    restartStage: "production-prepare",
    currentRevision: null,
    inheritedCompletedStages: [],
  };
  writeJsonAtomic(workspace.paths.manifest, {
    ...workspace,
    paths: undefined,
    schemaVersion: 2,
    activeVersionId: id,
    currentRevision: null,
    updatedAt: timestamp,
    versions: [...workspace.versions, version],
  });
  return { workspace: loadWorkspace(workspace.id), version };
}
