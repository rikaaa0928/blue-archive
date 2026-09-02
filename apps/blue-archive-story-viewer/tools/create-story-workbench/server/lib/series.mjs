import fs from "node:fs";
import path from "node:path";

import { findEventStories } from "../../../create-story/find-event-story.mjs";
import { localFilesRoot, publicStoryPath, readJson } from "./utils.mjs";
import { getProduction, hasProduction, productionPaths } from "./production.mjs";
import { listWorkspaces } from "./workspaces.mjs";
import { applyContinuationTitles, extractStoryTitle } from "./chapter-titles.mjs";

const cacheRoot = path.join(localFilesRoot, "ba-l10n", "index", "event");

function cleanText(value) {
  const text = String(value ?? "").trim();
  return /^\[[^\]]+not found\]$/iu.test(text) ? "" : text;
}

function loadLocalizationCache() {
  const files = {
    manifest: path.join(cacheRoot, "manifest.json"),
    groupKeys: path.join(cacheRoot, "group-keys.json"),
    keyHashes: path.join(cacheRoot, "key-hashes.json"),
    strings: path.join(cacheRoot, "strings.json"),
  };
  if (!Object.values(files).every(filePath => fs.existsSync(filePath))) return null;
  return Object.fromEntries(Object.entries(files).map(([key, filePath]) => [key, readJson(filePath)]));
}

function localizedText(key, cache) {
  if (!key || !cache) return {};
  const hash = cache.keyHashes[key];
  const messages = hash === undefined ? null : cache.strings[String(hash)];
  return {
    TextJp: cleanText(messages?.j_ja || messages?.g_ja),
    TextCn: cleanText(messages?.g_tw_cn || messages?.c_cn),
    TextTw: cleanText(messages?.g_tw),
    TextEn: cleanText(messages?.g_en),
    TextKr: cleanText(messages?.j_ko || messages?.g_ko),
  };
}

function workspaceProgress(workspace) {
  if (!workspace) return { code: "not-started", label: "尚未开始", latestStage: null };
  if (!hasProduction(workspace.id)) {
    return { code: "started", label: "待建立新版流程", latestStage: null };
  }
  const production = getProduction(workspace.id, { includeStory: false, includeHistory: false });
  if (production.recording.current && !production.preview.complete) {
    return { code: "before-review-2", label: "等待确认预览视频", latestStage: "recording" };
  }
  if (production.recording.current) return { code: "completed", label: "视频已验收", latestStage: "recording" };
  if (production.publicArtifact.current) return { code: "completed", label: "正式文件已生成", latestStage: "formal-story" };
  if (production.preview.complete) return { code: "review-2-complete", label: "最终预览已完成", latestStage: "preview" };
  if (production.assembly.current) return { code: "before-review-2", label: "等待最终预览", latestStage: "assembly" };
  const pending = [];
  if (!production.cn.ready) pending.push(production.cn.generationCount ? "简中整体审查" : "简中自动处理");
  if (!production.voice.speakers.ready) pending.push(production.voice.speakers.scannedAt ? "说话人例外" : "说话人扫描");
  if (!production.voice.script.ready) pending.push(production.voice.script.generationCount ? "配音稿整体审查" : "配音稿生成");
  if (pending.length) {
    return { code: "awaiting-review-1", label: `等待${pending.join("、")}`, latestStage: "independent-tracks" };
  }
  if (!production.voice.references.ready) return { code: "started", label: "等待准备参考音", latestStage: "references" };
  if (!production.voice.tts.current) return { code: "started", label: "等待生成语音", latestStage: "tts" };
  return { code: "started", label: "可进行最终装配", latestStage: "assembly" };
}

function localStoryTitle(workspace, identity) {
  const candidates = [];
  if (workspace && hasProduction(workspace.id)) {
    const paths = productionPaths(workspace.id);
    candidates.push(paths.assemblyStory, paths.baseStory);
  }
  candidates.push(publicStoryPath(identity));
  const storyPath = candidates.find(candidate => fs.existsSync(candidate));
  return storyPath ? extractStoryTitle(readJson(storyPath)) : {};
}

export function resolveEventSeries(query) {
  const normalizedQuery = String(query ?? "").trim();
  const cache = loadLocalizationCache();
  const directoryMatch = /^\d{5}$/u.test(normalizedQuery)
    ? cache?.manifest.find(item => (item.data ?? []).some(
      groupId => String(groupId).startsWith(normalizedQuery),
    ))
    : null;
  const lookupQuery = directoryMatch?.data?.[0] ?? normalizedQuery;
  const results = findEventStories({ query: String(lookupQuery) });
  const event = results.find(item => !item.isReturn && item.eventId === item.originalEventId) ?? results[0];
  const manifestEntry = cache?.manifest.find(item => Number(item.id) === event.originalEventId);
  const orderedIds = (manifestEntry?.data ?? event.scenarioGroupIds)
    .map(Number)
    .filter(groupId => event.scenarioGroupIds.includes(groupId));
  const workspaceByStoryId = new Map(listWorkspaces()
    .filter(item => !item.corrupt && item.identity?.type === "event")
    .map(item => [String(item.identity.storyId), item]));
  const chapters = applyContinuationTitles(orderedIds.map((storyId, index) => {
    const [titleKey] = cache?.groupKeys?.[String(storyId)] ?? [];
    const workspace = workspaceByStoryId.get(String(storyId));
    const indexedTitle = localizedText(titleKey, cache);
    const fallbackTitle = Object.values(indexedTitle).some(value => !cleanText(value))
      ? localStoryTitle(workspace, {
        type: "event",
        directoryId: String(storyId).slice(0, 5),
        storyId: String(storyId),
      })
      : {};
    const sourceTitle = {
      ...fallbackTitle,
      ...Object.fromEntries(Object.entries(indexedTitle).filter(([, value]) => cleanText(value))),
    };
    return {
      order: index + 1,
      storyId: String(storyId),
      directoryId: String(storyId).slice(0, 5),
      title: {
        ...sourceTitle,
        fallback: `第 ${index + 1} 话`,
      },
      progress: workspaceProgress(workspace),
    };
  }));
  return {
    type: "event",
    id: String(event.originalEventId),
    sourceEventId: String(event.storySourceEventId),
    title: {
      ...localizedText(manifestEntry?.name, cache),
      fallback: event.nameJp || event.nameKr || `活动 ${event.originalEventId}`,
    },
    chapters,
  };
}

export function resolveMainSeries(query = "all") {
  const normalizedQuery = String(query ?? "").trim().toLowerCase();
  if (normalizedQuery && !new Set(["all", "main", "全部", "主线"]).has(normalizedQuery) &&
      !/^\d+$/u.test(normalizedQuery)) {
    throw new Error("主线筛选必须是 all、main 或 StoryId 数字前缀");
  }
  const mainRoot = path.dirname(publicStoryPath({ type: "main", storyId: "0" }));
  const storyIds = fs.existsSync(mainRoot)
    ? fs.readdirSync(mainRoot)
      .filter(name => /^\d+\.json$/u.test(name))
      .map(name => name.replace(/\.json$/u, ""))
      .filter(storyId => !/^\d+$/u.test(normalizedQuery) || storyId.startsWith(normalizedQuery))
      .sort((left, right) => Number(left) - Number(right))
    : [];
  if (!storyIds.length) throw new Error(`没有找到匹配的主线剧情：${query}`);
  const workspaceByStoryId = new Map(listWorkspaces()
    .filter(item => !item.corrupt && item.identity?.type === "main")
    .map(item => [String(item.identity.storyId), item]));
  return {
    type: "main",
    id: /^\d+$/u.test(normalizedQuery) ? normalizedQuery : "all",
    title: { TextCn: normalizedQuery && /^\d+$/u.test(normalizedQuery)
      ? `主线剧情 ${normalizedQuery}*`
      : "全部主线剧情" },
    chapters: storyIds.map((storyId, index) => {
      const workspace = workspaceByStoryId.get(storyId);
      return {
        order: index + 1,
        storyId,
        directoryId: "",
        title: {
          ...localStoryTitle(workspace, { type: "main", storyId }),
          fallback: `主线 ${storyId}`,
        },
        progress: workspaceProgress(workspace),
      };
    }),
  };
}
