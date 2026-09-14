import fs from "node:fs";
import path from "node:path";

function rowsFrom(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.content)) return payload.content;
  if (Array.isArray(payload?.DataList)) return payload.DataList;
  throw new Error("ScenarioMode source must contain an array of rows");
}

function positiveIds(values) {
  return (Array.isArray(values) ? values : [])
    .map(Number)
    .filter(value => Number.isSafeInteger(value) && value > 0);
}

function unique(values) {
  return [...new Set(values)];
}

function episodeFromRow(rawRow) {
  const row = rawRow?.Bytes ?? rawRow;
  if (!row || !new Set(["Main", "Prologue"]).has(row.ModeType)) return null;
  if (row.Hide === true || row.Open === false) return null;
  const frontGroupIds = positiveIds(row.FrontScenarioGroupId);
  const backGroupIds = positiveIds(row.BackScenarioGroupId);
  if (!frontGroupIds.length) return null;
  const storyId = frontGroupIds[0];
  return {
    storyId: String(storyId),
    modeId: Number(row.ModeId) || storyId,
    modeType: row.ModeType,
    volumeId: Number(row.VolumeId) || 0,
    chapterId: Number(row.ChapterId) || 0,
    episodeId: Number(row.EpisodeId) || 0,
    groupIds: unique([...frontGroupIds, ...backGroupIds]).map(String),
  };
}

function compareEpisodes(left, right) {
  const leftPrologue = left.modeType === "Prologue" ? 0 : 1;
  const rightPrologue = right.modeType === "Prologue" ? 0 : 1;
  return leftPrologue - rightPrologue ||
    left.volumeId - right.volumeId ||
    left.chapterId - right.chapterId ||
    left.episodeId - right.episodeId ||
    left.modeId - right.modeId;
}

export function parseMainStoryEpisodes(payload) {
  const byStoryId = new Map();
  for (const rawRow of rowsFrom(payload)) {
    const episode = episodeFromRow(rawRow);
    if (!episode) continue;
    const existing = byStoryId.get(episode.storyId);
    if (existing && JSON.stringify(existing.groupIds) !== JSON.stringify(episode.groupIds)) {
      throw new Error(`Conflicting ScenarioMode rows for main story ${episode.storyId}`);
    }
    byStoryId.set(episode.storyId, episode);
  }
  return [...byStoryId.values()].sort(compareEpisodes);
}

export function findMainStoryEpisode(episodes, storyId) {
  const normalized = String(storyId);
  const canonical = episodes.find(episode => episode.storyId === normalized);
  if (canonical) return canonical;
  const owner = episodes.find(episode => episode.groupIds.includes(normalized));
  if (owner) {
    throw new Error(
      `Scenario GroupId ${normalized} belongs to main story ${owner.storyId}; ` +
      `import ${owner.storyId} instead`,
    );
  }
  return null;
}

export function scenarioModeSchemaPath(scenarioScriptSchemaPath, explicitPath = "") {
  return explicitPath
    ? path.resolve(explicitPath)
    : path.join(path.dirname(path.resolve(scenarioScriptSchemaPath)), "ScenarioModeDBSchema.json");
}

export function loadMainStoryEpisodes(scenarioScriptSchemaPath, explicitPath = "") {
  const modePath = scenarioModeSchemaPath(scenarioScriptSchemaPath, explicitPath);
  if (!fs.existsSync(modePath)) return { path: modePath, episodes: [] };
  const payload = JSON.parse(fs.readFileSync(modePath, "utf8"));
  return { path: modePath, episodes: parseMainStoryEpisodes(payload) };
}

export function mainStorySeriesKey(episode) {
  return episode.modeType === "Prologue"
    ? "prologue"
    : `${episode.volumeId}:${episode.chapterId}`;
}
