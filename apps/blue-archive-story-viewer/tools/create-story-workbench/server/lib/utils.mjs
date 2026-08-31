import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const currentDir = path.dirname(url.fileURLToPath(import.meta.url));

export const workbenchRoot = path.resolve(currentDir, "..", "..");
export const appRoot = path.resolve(workbenchRoot, "..", "..");
export const repoRoot = path.resolve(appRoot, "..", "..");
export const createStoryToolsRoot = path.join(appRoot, "tools", "create-story");
export const localFilesRoot = path.join(appRoot, ".local-files");
export const workspaceRoot = path.join(localFilesRoot, "create-story");
export const publicStoryRoot = path.join(appRoot, "public", "story");

export const supportedStoryTypes = new Set([
  "main",
  "favor",
  "event",
  "group",
  "mini",
  "other",
]);

const flatStoryTypes = new Set(["main", "other"]);

export function nowIso() {
  return new Date().toISOString();
}

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function jsonDigest(value) {
  return `sha256:${sha256(JSON.stringify(value))}`;
}

export function fileDigest(filePath) {
  return `sha256:${sha256(fs.readFileSync(filePath))}`;
}

export function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    if (arguments.length > 1) return fallback;
    throw new Error(`JSON file does not exist: ${filePath}`);
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot parse JSON ${filePath}: ${error.message}`);
  }
}

export function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporaryPath, filePath);
}

export function writeTextAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, value);
  fs.renameSync(temporaryPath, filePath);
}

export function isInsideDirectory(baseDir, candidatePath) {
  const relative = path.relative(baseDir, candidatePath);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export function assertInsideDirectory(baseDir, candidatePath, label = "path") {
  const resolvedBase = path.resolve(baseDir);
  const resolvedCandidate = path.resolve(candidatePath);
  if (!isInsideDirectory(resolvedBase, resolvedCandidate)) {
    throw new Error(`${label} escapes ${resolvedBase}: ${resolvedCandidate}`);
  }
  return resolvedCandidate;
}

export function validateStoryIdentity({ type, storyId, directoryId = "" }) {
  const normalizedType = String(type || "").toLowerCase();
  const normalizedStoryId = String(storyId || "");
  if (!supportedStoryTypes.has(normalizedType)) {
    throw new Error(`Unsupported story type: ${type}`);
  }
  if (!/^\d+$/u.test(normalizedStoryId)) {
    throw new Error("storyId must contain digits only");
  }
  const nested = !flatStoryTypes.has(normalizedType);
  const normalizedDirectoryId = nested
    ? String(directoryId || normalizedStoryId.slice(0, 5))
    : "";
  if (nested && !/^\d+$/u.test(normalizedDirectoryId)) {
    throw new Error("directoryId must contain digits only");
  }
  if (!nested && directoryId) {
    throw new Error(`${normalizedType} stories do not use directoryId`);
  }
  return {
    type: normalizedType,
    storyId: normalizedStoryId,
    directoryId: normalizedDirectoryId,
  };
}

export function storyRelativePath(identity) {
  const value = validateStoryIdentity(identity);
  return value.directoryId
    ? path.join(value.type, value.directoryId, `${value.storyId}.json`)
    : path.join(value.type, `${value.storyId}.json`);
}

export function publicStoryPath(identity) {
  return path.join(publicStoryRoot, storyRelativePath(identity));
}

export function workspaceDirectory(identity) {
  const value = validateStoryIdentity(identity);
  return value.directoryId
    ? path.join(workspaceRoot, value.type, value.directoryId, value.storyId)
    : path.join(workspaceRoot, value.type, value.storyId);
}

export function workspaceId(identity) {
  const value = validateStoryIdentity(identity);
  return [value.type, value.directoryId || "_", value.storyId].join(":");
}

export function parseWorkspaceId(value) {
  const [type, rawDirectoryId, storyId, ...rest] = String(value || "").split(":");
  if (rest.length > 0 || !type || !rawDirectoryId || !storyId) {
    throw new Error(`Invalid workspace id: ${value}`);
  }
  return validateStoryIdentity({
    type,
    directoryId: rawDirectoryId === "_" ? "" : rawDirectoryId,
    storyId,
  });
}

export function loadEnvFiles() {
  for (const envPath of [path.join(appRoot, ".env"), path.join(repoRoot, ".env")]) {
    if (!fs.existsSync(envPath)) continue;
    for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(trimmed);
      if (!match || match[1] in process.env) continue;
      let value = match[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[match[1]] = value;
    }
  }
}

export function effectiveTtsText(unit) {
  if (unit?.TextJpVoice !== undefined && unit?.TextJpVoice !== null) {
    return String(unit.TextJpVoice).trim();
  }
  return String(unit?.TextJp || "").trim();
}

export function isPunctuationOnlyTtsText(value) {
  const text = String(value ?? "").trim();
  if (!text) return false;
  const withoutEmotionTags = text.replace(/\[[^\]\r\n]{1,30}\]/gu, "");
  return withoutEmotionTags.replace(/[\s\p{P}\p{S}…⋯ー〜～]+/gu, "") === "";
}

function normalizedTtsIndices(values) {
  return [...new Set((values ?? []).map(Number))]
    .filter(index => Number.isSafeInteger(index) && index >= 0)
    .sort((left, right) => left - right);
}

export function resolveTtsSkippedIndices(story, state = {}, candidateIndices = null) {
  const candidates = candidateIndices === null
    ? null
    : new Set(normalizedTtsIndices(candidateIndices));
  const forced = new Set(normalizedTtsIndices(state.ttsForcedIndices));
  const skipped = new Set(normalizedTtsIndices(state.ttsSkippedIndices)
    .filter(index => candidates === null || candidates.has(index)));
  (story?.content ?? []).forEach((unit, index) => {
    if ((candidates === null || candidates.has(index)) && !forced.has(index) &&
      isPunctuationOnlyTtsText(effectiveTtsText(unit))) {
      skipped.add(index);
    }
  });
  return [...skipped].sort((left, right) => left - right);
}

export function applyTtsSkipDecision(story, state, index, skipped) {
  const explicit = new Set(normalizedTtsIndices(state.ttsSkippedIndices));
  const forced = new Set(normalizedTtsIndices(state.ttsForcedIndices));
  const wasSkipped = resolveTtsSkippedIndices(story, state).includes(index);
  if (skipped) {
    explicit.add(index);
    forced.delete(index);
  } else {
    explicit.delete(index);
    forced.add(index);
  }
  return {
    wasSkipped,
    ttsSkippedIndices: [...explicit].sort((left, right) => left - right),
    ttsForcedIndices: [...forced].sort((left, right) => left - right),
  };
}

export function missingPlannedVoiceIndices(story, ttsPlan, skippedIndices = []) {
  const skipped = new Set(skippedIndices.map(Number));
  return [...new Set((ttsPlan ?? []).map(item => Number(item.index)))]
    .filter(index => Number.isSafeInteger(index) && index >= 0 && !skipped.has(index))
    .filter(index => !String(story?.content?.[index]?.VoiceJp ?? "").trim())
    .sort((left, right) => left - right);
}

export function storyScanDigest(story) {
  const rows = story.content.map(unit => [
    String(unit.ScriptKr ?? ""),
    effectiveTtsText(unit),
  ]);
  return jsonDigest(rows);
}

export function storyDigest(story) {
  return jsonDigest(story);
}

export function safeSegment(value, label = "segment") {
  const normalized = String(value || "");
  if (!/^[A-Za-z0-9._-]+$/u.test(normalized)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return normalized;
}

export function statSummary(filePath) {
  const stat = fs.statSync(filePath);
  return {
    path: filePath,
    size: stat.size,
    mtimeMs: Math.trunc(stat.mtimeMs),
  };
}
