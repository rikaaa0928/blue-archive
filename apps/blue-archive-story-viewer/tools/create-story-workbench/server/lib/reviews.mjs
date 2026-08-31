import fs from "node:fs";
import path from "node:path";

import { getPlayerCharacterId } from "../../../create-story/ba-character-catalog.mjs";
import {
  inferScenarioRole,
  isCollectiveScenarioSpeaker,
  isUnknownScenarioSpeaker,
  parseScenarioScriptSpeakers,
} from "../../../create-story/scenario-script-speakers.mjs";
import {
  applyTtsSkipDecision,
  effectiveTtsText,
  jsonDigest,
  nowIso,
  readJson,
  localFilesRoot, storyRelativePath,
  resolveTtsSkippedIndices,
  storyScanDigest,
  storyDigest,
} from "./utils.mjs";
import {
  createRevision,
  getLatestRevisionForStage,
  getRevision,
  loadDraft,
  loadWorkspace,
  saveDraft,
  versionResourcePath,
} from "./workspaces.mjs";

const tool1EditableFields = new Set([
  "TextCn",
  "ScriptKr",
  "SelectionGroup",
  "BGMId",
  "Sound",
  "Transition",
  "BGName",
  "BGEffect",
  "PopupFileName",
]);
const reviewDefinitionVersion = 8;

function loadCharacterNameByKey() {
  const tablePath = path.join(
    localFilesRoot,
    "player-data",
    "ScenarioCharacterNameExcelTable.json",
  );
  const payload = readJson(tablePath, []);
  const rows = Array.isArray(payload) ? payload : payload.content ?? payload.DataList ?? [];
  const nameById = new Map(rows.map(rawRow => {
    const row = rawRow?.Bytes ?? rawRow;
    return [Number(row.CharacterName), String(row.NameCN || row.NameJP || "")];
  }));
  return stableKey => nameById.get(getPlayerCharacterId(stableKey)) ?? "";
}

function loadVoiceAvailability(workspace, story) {
  const availabilityPath = versionResourcePath(
    workspace.id, "voice-availability.json", { legacyFallback: true },
  );
  const result = readJson(availabilityPath, null);
  if (!result || result.storyDigest !== storyDigest(story) || !Array.isArray(result.items)) {
    return new Map();
  }
  return new Map(result.items.map(item => [item.stableKey, item]));
}

export function buildCollectiveVoiceConfig(workspace, story, speakerReviews = []) {
  return {
    schemaVersion: 2,
    source: {
      storyPath: `public/story/${storyRelativePath(workspace.identity).split(path.sep).join("/")}`,
      contentLength: story.content.length,
      scanDigest: storyScanDigest(story),
    },
    lines: speakerReviews.map(review => {
      const unit = story.content[review.storyIndex];
      if (!unit) throw new Error(`Speaker review references missing story line ${review.storyIndex}`);
      const speaker = parseScenarioScriptSpeakers(unit).dialogueSpeaker;
      const base = {
        storyIndex: review.storyIndex,
        kind: review.kind,
        status: "ready",
        expected: {
          speaker,
          scriptKr: String(unit.ScriptKr ?? ""),
          ttsText: effectiveTtsText(unit),
        },
      };
      return review.kind === "collective"
        ? { ...base, members: review.members, evidence: String(review.evidence ?? "") }
        : {
          ...base,
          resolution: review.resolution,
          resolvedSpeaker: review.resolvedSpeaker,
          evidence: review.evidence,
        };
    }).sort((a, b) => a.storyIndex - b.storyIndex),
  };
}

function buildCharacterRoster(story, voiceAvailabilityByKey) {
  const characterNameFor = loadCharacterNameByKey();
  const roster = new Map();
  for (const unit of story.content) {
    for (const stableKey of parseScenarioScriptSpeakers(unit).speakers) {
      if (isUnknownScenarioSpeaker(stableKey) || roster.has(stableKey)) continue;
      const characterName = characterNameFor(stableKey);
      // A replacement must be usable by the later reference-audio workflow.
      // Anonymous and collective labels still use the explicit manual fallback.
      if (characterName && voiceAvailabilityByKey.get(stableKey)?.available === true) {
        roster.set(stableKey, { stableKey, characterName });
      }
    }
  }
  return [...roster.values()];
}

function taggedSelectionText(value) {
  const result = new Map();
  for (const match of String(value ?? "").matchAll(/(?:^|\n)\[s(\d*)\]\s*([^\n]*)/giu)) {
    result.set(`s${match[1]}`, match[2].trim());
  }
  return result;
}

function buildChoiceOptions(story, index) {
  const unit = story.content[index];
  const source = taggedSelectionText(unit.ScriptKr);
  if (!source.size) return [];
  const languages = {
    textKr: source,
    textJp: taggedSelectionText(unit.TextJp),
    textCn: taggedSelectionText(unit.TextCn),
    textTw: taggedSelectionText(unit.TextTw),
  };
  return [...source.keys()].map(tag => {
    const groupText = tag.slice(1);
    const selectionGroup = groupText ? Number(groupText) : 0;
    const responseIndex = selectionGroup > 0
      ? story.content.findIndex((candidate, candidateIndex) =>
        candidateIndex > index && Number(candidate.SelectionGroup) === selectionGroup)
      : -1;
    return {
      tag: `[${tag}]`,
      selectionGroup,
      isBranch: selectionGroup > 0,
      responseIndex: responseIndex >= 0 ? responseIndex : null,
      ...Object.fromEntries(Object.entries(languages).map(([field, values]) => [field, values.get(tag) ?? ""])),
    };
  });
}

function buildTool1Issues(
  story,
  normalizedStory = null,
  llmHistoryByIndex = new Map(),
  voiceAvailabilityByKey = new Map(),
) {
  const issues = [];
  const characterNameFor = loadCharacterNameByKey();
  story.content.forEach((unit, index) => {
    const { dialogueSpeaker, speakers } = parseScenarioScriptSpeakers(unit);
    if (normalizedStory && unit.TextCn !== normalizedStory.content?.[index]?.TextCn) {
      issues.push({
        id: `cn:${index}`,
        kind: "cn-change",
        index,
        severity: "review",
        title: "中文经过 LLM 修改",
        before: normalizedStory.content?.[index]?.TextCn ?? "",
        after: unit.TextCn ?? "",
        textJp: String(unit.TextJp ?? ""),
        textTw: String(unit.TextTw ?? ""),
        llmHistory: llmHistoryByIndex.get(index) ?? [],
      });
    }
    const choiceOptions = buildChoiceOptions(story, index);
    if (choiceOptions.length) {
      const branchCount = choiceOptions.filter(option => option.isBranch).length;
      issues.push({
        id: `choice:${index}`,
        kind: "choice",
        index,
        severity: "review",
        title: branchCount > 0 ? `选择页（${branchCount} 个响应分支）` : "单项选择页（无分支）",
        options: choiceOptions,
      });
    }
    if (isUnknownScenarioSpeaker(dialogueSpeaker)) {
      issues.push({
        id: `unknown:${index}:${dialogueSpeaker}`,
        kind: "unknown-speaker",
        index,
        severity: "blocking",
        title: `未知说话人：${dialogueSpeaker}`,
        speakerCandidates: speakers
          .filter(speaker => speaker !== dialogueSpeaker && !isUnknownScenarioSpeaker(speaker))
          .filter(speaker => voiceAvailabilityByKey.get(speaker)?.available === true)
          .map(stableKey => ({ stableKey, characterName: characterNameFor(stableKey) })),
      });
    } else if (isCollectiveScenarioSpeaker(dialogueSpeaker)) {
      issues.push({
        id: `collective:${index}:${dialogueSpeaker}`,
        kind: "collective-speaker",
        index,
        severity: "review",
        title: `集体或匿名说话人：${dialogueSpeaker}`,
      });
    } else if (dialogueSpeaker && voiceAvailabilityByKey.get(dialogueSpeaker)?.available === false) {
      const voiceAvailability = voiceAvailabilityByKey.get(dialogueSpeaker);
      issues.push({
        id: `unavailable:${index}:${dialogueSpeaker}`,
        kind: "unknown-speaker",
        index,
        severity: "blocking",
        title: `无可用角色语音：${characterNameFor(dialogueSpeaker) || dialogueSpeaker}`,
        sourceSpeaker: dialogueSpeaker,
        voiceAvailability,
        speakerCandidates: speakers
          .filter(speaker => speaker !== dialogueSpeaker && !isUnknownScenarioSpeaker(speaker))
          .filter(speaker => voiceAvailabilityByKey.get(speaker)?.available === true)
          .map(stableKey => ({ stableKey, characterName: characterNameFor(stableKey) })),
      });
    }
    const hasDisplayText = [unit.TextJp, unit.TextCn, unit.TextTw, unit.TextEn]
      .some(value => String(value ?? "").trim());
    if (inferScenarioRole(unit) === "dialogue" && !dialogueSpeaker && hasDisplayText) {
      issues.push({
        id: `skeleton-speaker:${index}`,
        kind: "skeleton",
        index,
        severity: "blocking",
        title: "对白行未识别出说话人",
      });
    }
    if (!String(unit.ScriptKr ?? "").trim() && [unit.TextJp, unit.TextCn, unit.TextEn]
      .some(value => String(value ?? "").trim())) {
      issues.push({
        id: `skeleton-empty:${index}`,
        kind: "skeleton",
        index,
        severity: "review",
        title: "有文本但没有剧情脚本",
      });
    }
  });
  return issues;
}

function choiceApprovalBlocker(issue, playback) {
  if (issue.kind !== "choice") return "";
  const branches = (issue.options ?? []).filter(option => option.isBranch);
  if (!branches.length) return "";
  const unchecked = branches.filter(option =>
    !(playback.checkedSelectionKeys ?? []).includes(`${issue.index}:${option.selectionGroup}`));
  if (unchecked.length) return "every response branch must be checked first";
  const selectedGroup = Number(playback.defaultSelectionGroups?.[issue.index]);
  if (!branches.some(option => option.selectionGroup === selectedGroup)) {
    return "a recording default branch must be selected first";
  }
  return "";
}

function baseReviewDraft(tool, revision, issues) {
  return {
    schemaVersion: 1,
    definitionVersion: reviewDefinitionVersion,
    tool,
    baseRevision: revision.name,
    baseStoryDigest: storyDigest(revision.story),
    story: revision.story,
    issues,
    decisions: Object.fromEntries(issues.map(issue => [issue.id, "pending"])),
    notes: {},
    resolutions: {},
    manualEdits: [],
    ttsSkippedIndices: [],
    ttsForcedIndices: [],
    playback: {
      defaultComplete: false,
      checkedSelectionKeys: [],
      defaultSelectionGroups: {},
    },
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

function loadLlmHistory(workspaceId) {
  const historyByIndex = new Map();
  for (const stage of ["cn-llm-1", "cn-llm-2"]) {
    const revision = getLatestRevisionForStage(workspaceId, stage);
    if (!revision) continue;
    const result = readJson(revision.resultPath, {});
    for (const change of result.changes ?? []) {
      if (!Number.isInteger(change.index)) continue;
      const history = historyByIndex.get(change.index) ?? [];
      history.push({
        stage,
        revision: revision.name,
        pass: change.pass ?? 1,
        before: String(change.before ?? ""),
        after: String(change.after ?? ""),
        issueTypes: Array.isArray(change.issueTypes) ? change.issueTypes : [],
        rationale: String(change.rationale ?? ""),
        textJp: String(change.TextJp ?? ""),
        textTw: String(change.TextTw ?? ""),
      });
      historyByIndex.set(change.index, history);
    }
  }
  return historyByIndex;
}

export function openReview(workspaceId, tool) {
  const workspace = loadWorkspace(workspaceId);
  const current = getRevision(workspace.id);
  if (!current) throw new Error("The workspace has no story revision to review");
  const existing = loadDraft(workspace.id, tool);
  if (
    existing &&
    existing.baseRevision === current.name &&
    existing.baseStoryDigest === storyDigest(current.story) &&
    existing.definitionVersion === reviewDefinitionVersion
  ) {
    return existing;
  }
  let issues;
  if (tool === "tool1") {
    const normalizedRevision = getLatestRevisionForStage(workspace.id, "cn-normalize");
    const normalizedStory = normalizedRevision && fs.existsSync(normalizedRevision.storyPath)
      ? JSON.parse(fs.readFileSync(normalizedRevision.storyPath, "utf8"))
      : null;
    const canMigrateExisting = existing &&
      existing.baseRevision === current.name &&
      existing.baseStoryDigest === storyDigest(current.story);
    const reviewStory = canMigrateExisting ? existing.story : current.story;
    const voiceAvailabilityByKey = loadVoiceAvailability(workspace, current.story);
    issues = buildTool1Issues(
      reviewStory,
      normalizedStory,
      loadLlmHistory(workspace.id),
      voiceAvailabilityByKey,
    );
    const draft = baseReviewDraft(tool, current, issues);
    draft.story = reviewStory;
    draft.characterRoster = buildCharacterRoster(reviewStory, voiceAvailabilityByKey);
    if (canMigrateExisting) {
      draft.decisions = Object.fromEntries(issues.map(issue => [
        issue.id,
        existing.decisions?.[issue.id] ?? "pending",
      ]));
      draft.notes = existing.notes ?? {};
      draft.resolutions = existing.resolutions ?? {};
      draft.manualEdits = existing.manualEdits ?? [];
      draft.playback = {
        defaultComplete: Boolean(existing.playback?.defaultComplete),
        checkedSelectionKeys: existing.definitionVersion >= 6
          ? existing.playback?.checkedSelectionKeys ?? []
          : [],
        defaultSelectionGroups: existing.playback?.defaultSelectionGroups ?? {},
      };
      draft.createdAt = existing.createdAt ?? draft.createdAt;
    }
    saveDraft(workspace.id, tool, draft);
    return draft;
  } else if (tool === "tool2") {
    issues = current.story.content.flatMap((unit, index) => {
      const role = inferScenarioRole(unit);
      const speaker = parseScenarioScriptSpeakers(unit).dialogueSpeaker;
      if (!effectiveTtsText(unit) || !speaker || !["dialogue", "narration"].includes(role)) return [];
      return [{
        id: `voice:${index}`,
        kind: "voice-script",
        index,
        severity: "review",
        title: speaker,
        textJp: String(unit.TextJp ?? ""),
        textJpVoice: effectiveTtsText(unit),
      }];
    });
  } else {
    throw new Error(`Invalid review tool: ${tool}`);
  }
  const draft = baseReviewDraft(tool, current, issues);
  if (tool === "tool2") {
    draft.ttsSkippedIndices = resolveTtsSkippedIndices(
      current.story,
      draft,
      issues.filter(issue => issue.kind === "voice-script").map(issue => issue.index),
    );
  }
  saveDraft(workspace.id, tool, draft);
  return draft;
}

export function updateReview(workspaceId, tool, patch) {
  const draft = openReview(workspaceId, tool);
  const next = structuredClone(draft);
  if (patch.lineEdit) {
    const index = Number(patch.lineEdit.index);
    const field = String(patch.lineEdit.field ?? "");
    if (!Number.isInteger(index) || index < 0 || index >= next.story.content.length) {
      throw new Error("Invalid story line index");
    }
    if (tool === "tool1" ? !tool1EditableFields.has(field) : field !== "TextJpVoice") {
      throw new Error(`${field} cannot be edited in ${tool}`);
    }
    const before = next.story.content[index][field];
    const after = patch.lineEdit.value;
    if (before !== after) {
      next.story.content[index][field] = after;
      next.manualEdits = [...(next.manualEdits ?? []), {
        index,
        field,
        before,
        after,
        editedAt: nowIso(),
      }];
      for (const issue of next.issues.filter(candidate => candidate.index === index)) {
        next.decisions[issue.id] = "pending";
      }
    }
  }
  if (patch.decision) {
    const { issueId, value, note = "" } = patch.decision;
    const issue = next.issues.find(candidate => candidate.id === issueId);
    if (!issue) throw new Error(`Unknown review issue: ${issueId}`);
    if (!new Set(["approved", "rejected", "pending"]).has(value)) {
      throw new Error(`Invalid review decision: ${value}`);
    }
    if (issue.kind === "cn-change" && value === "rejected") {
      throw new Error("Chinese changes must be manually edited or approved, not rejected");
    }
    const blocker = value === "approved" ? choiceApprovalBlocker(issue, next.playback) : "";
    if (blocker) throw new Error(`Choice page ${issue.index}: ${blocker}`);
    next.decisions[issueId] = value;
    next.notes[issueId] = String(note);
  }
  if (patch.ttsSkip) {
    if (tool !== "tool2") throw new Error("Only tool2 accepts TTS skip decisions");
    const index = Number(patch.ttsSkip.index);
    if (!next.issues.some(issue => issue.kind === "voice-script" && issue.index === index)) {
      throw new Error(`Story line ${index} is not a voice-script review item`);
    }
    const skipDecision = applyTtsSkipDecision(
      next.story,
      next,
      index,
      patch.ttsSkip.skipped === true,
    );
    if (patch.ttsSkip.skipped !== true) {
      for (const issue of next.issues.filter(issue => issue.index === index)) {
        next.decisions[issue.id] = "pending";
      }
    }
    next.ttsSkippedIndices = skipDecision.ttsSkippedIndices;
    next.ttsForcedIndices = skipDecision.ttsForcedIndices;
  }
  if (patch.resolution) {
    const { issueId, ...resolution } = patch.resolution;
    const issue = next.issues.find(candidate => candidate.id === issueId);
    if (!issue || !new Set(["unknown-speaker", "collective-speaker"]).has(issue.kind)) {
      throw new Error(`Issue does not accept speaker resolution: ${issueId}`);
    }
    next.resolutions[issueId] = {
      ...next.resolutions[issueId],
      ...resolution,
    };
  }
  if (patch.playback) {
    const validSelectionKeys = new Set(next.issues.flatMap(issue => issue.kind === "choice"
      ? (issue.options ?? [])
        .filter(option => option.isBranch)
        .map(option => `${issue.index}:${option.selectionGroup}`)
      : []));
    const requestedDefaults = patch.playback.defaultSelectionGroups ??
      next.playback.defaultSelectionGroups ?? {};
    const defaultSelectionGroups = Object.fromEntries(Object.entries(requestedDefaults)
      .map(([index, group]) => [String(Number(index)), Number(group)])
      .filter(([index, group]) => validSelectionKeys.has(`${index}:${group}`))
      .sort(([left], [right]) => Number(left) - Number(right)));
    next.playback = {
      ...next.playback,
      ...patch.playback,
      checkedSelectionKeys: [...new Set(
        (patch.playback.checkedSelectionKeys ?? next.playback.checkedSelectionKeys ?? [])
          .map(String)
          .filter(value => /^\d+:\d+$/u.test(value)),
      )].sort(),
      defaultSelectionGroups,
    };
    for (const issue of next.issues) {
      if (next.decisions[issue.id] === "approved" && choiceApprovalBlocker(issue, next.playback)) {
        next.decisions[issue.id] = "pending";
      }
    }
  }
  saveDraft(workspaceId, tool, next);
  return next;
}

export function reviewSummary(draft) {
  const skipped = new Set(resolveTtsSkippedIndices(draft.story, draft));
  const values = draft.issues.map(issue => skipped.has(issue.index)
    ? "approved"
    : draft.decisions[issue.id]);
  const requiredBranches = draft.issues.flatMap(issue => issue.kind === "choice"
    ? (issue.options ?? [])
      .filter(option => option.isBranch)
      .map(option => `${issue.index}:${option.selectionGroup}`)
    : []);
  const missingBranches = requiredBranches.filter(
    key => !(draft.playback.checkedSelectionKeys ?? []).includes(key),
  );
  const branchPages = draft.issues.flatMap(issue => issue.kind === "choice" &&
    (issue.options ?? []).some(option => option.isBranch) ? [issue] : []);
  const missingDefaultSelections = branchPages.flatMap(issue => {
    const selectedGroup = Number(draft.playback.defaultSelectionGroups?.[issue.index]);
    return (issue.options ?? []).some(option =>
      option.isBranch && option.selectionGroup === selectedGroup) ? [] : [issue.index];
  });
  const playbackRequired = draft.tool === "tool1";
  return {
    total: values.length,
    approved: values.filter(value => value === "approved").length,
    pending: values.filter(value => value === "pending").length,
    rejected: values.filter(value => value === "rejected").length,
    missingBranches,
    missingDefaultSelections,
    playbackRequired,
    playbackComplete: !playbackRequired || Boolean(draft.playback.defaultComplete),
  };
}

export function approveReview(workspaceId, tool) {
  const draft = openReview(workspaceId, tool);
  const summary = reviewSummary(draft);
  if (summary.pending || summary.rejected) {
    throw new Error("Every review item must be explicitly approved");
  }
  if (tool === "tool1" && !summary.playbackComplete) {
    throw new Error("The default story path must be played through before approval");
  }
  if (tool === "tool1" && summary.missingBranches.length) {
    throw new Error(`Unchecked choice pages: ${summary.missingBranches.join(", ")}`);
  }
  if (tool === "tool1" && summary.missingDefaultSelections.length) {
    throw new Error(
      `Choice pages without a recording default: ${summary.missingDefaultSelections.join(", ")}`,
    );
  }
  if (tool === "tool1") {
    for (const issue of draft.issues) {
      const resolution = draft.resolutions[issue.id] ?? {};
      if (issue.kind === "collective-speaker") {
        const members = [...new Set((resolution.members ?? []).map(value => String(value).trim()).filter(Boolean))];
        if (members.length < 2) {
          throw new Error(
            `Collective line ${issue.index} requires at least two stable Korean member keys`,
          );
        }
      }
      if (issue.kind === "unknown-speaker") {
        if (!new Set(["character", "anonymous"]).has(resolution.resolution)) {
          throw new Error(`Unknown speaker line ${issue.index} requires a character/anonymous resolution`);
        }
        if (!String(resolution.resolvedSpeaker ?? "").trim() || !String(resolution.evidence ?? "").trim()) {
          throw new Error(`Unknown speaker line ${issue.index} requires resolvedSpeaker and evidence`);
        }
      }
    }
  }
  const stage = tool === "tool1" ? "review-1" : "review-2";
  const result = {
    approvedAt: nowIso(),
    reviewDigest: jsonDigest({
      baseRevision: draft.baseRevision,
      decisions: draft.decisions,
      playback: draft.playback,
      story: draft.story,
      manualEdits: draft.manualEdits ?? [],
    }),
    summary,
  };
  if (tool === "tool1") {
    result.manualEdits = draft.manualEdits ?? [];
    result.recordingPreSelections = Object.entries(draft.playback.defaultSelectionGroups ?? {})
      .map(([storyIndex, selectionGroup]) => ({
        storyIndex: Number(storyIndex),
        selectionGroup: Number(selectionGroup),
      }))
      .sort((left, right) => left.storyIndex - right.storyIndex);
    result.speakerReviews = draft.issues.flatMap(issue => {
      if (!new Set(["unknown-speaker", "collective-speaker"]).has(issue.kind)) return [];
      return [{
        storyIndex: issue.index,
        kind: issue.kind === "collective-speaker" ? "collective" : "unknown-speaker",
        ...draft.resolutions[issue.id],
      }];
    });
  }
  let extraJsonFiles = {};
  if (tool === "tool2") {
    const skippedIndices = new Set(resolveTtsSkippedIndices(draft.story, draft));
    result.ttsSkippedIndices = [...skippedIndices].sort((left, right) => left - right);
    result.ttsForcedIndices = [...new Set((draft.ttsForcedIndices ?? []).map(Number))]
      .sort((left, right) => left - right);
    result.ttsPlan = draft.story.content.flatMap((unit, index) => {
      if (skippedIndices.has(index)) return [];
      const text = effectiveTtsText(unit);
      const speaker = parseScenarioScriptSpeakers(unit).dialogueSpeaker;
      if (!text || !speaker || !["dialogue", "narration"].includes(inferScenarioRole(unit))) return [];
      return [{
        index,
        speakerKr: speaker,
        expected: { ttsText: text },
        contentLength: text.length,
        scanDigest: jsonDigest([String(unit.ScriptKr ?? ""), text]),
      }];
    });
    const review1Revision = getLatestRevisionForStage(workspaceId, "review-1");
    const speakerReviews = review1Revision
      ? readJson(review1Revision.resultPath, {}).speakerReviews ?? []
      : [];
    const config = buildCollectiveVoiceConfig(loadWorkspace(workspaceId), draft.story, speakerReviews);
    extraJsonFiles = { "collective-voice-config.json": config };
  }
  return createRevision(workspaceId, {
    stage,
    story: draft.story,
    result,
    inputRevision: draft.baseRevision,
    metadata: { humanReviewed: true },
    extraJsonFiles,
  });
}
