import { inferScenarioRole, parseScenarioScriptSpeakers } from "../../../create-story/scenario-script-speakers.mjs";

import {
  effectiveTtsText,
  isPunctuationOnlyTtsText,
} from "./utils.mjs";

const inheritedFields = ["TextCn", "TextJpVoice", "VoiceJp"];

function rowIdentity(story, unit) {
  return JSON.stringify([
    Number(unit?.GroupId ?? story?.GroupId ?? 0),
    Number(unit?.SelectionGroup ?? 0),
    String(unit?.ScriptKr ?? ""),
  ]);
}

function mergeProvenance(current, existing) {
  return [...new Set(
    [current, existing]
      .flatMap(value => String(value ?? "").split(/\s+\+\s+/u))
      .map(value => value.trim())
      .filter(Boolean),
  )].join(" + ");
}

export function adoptExistingStoryBaseline(importedStory, existingStory) {
  const story = structuredClone(importedStory);
  const importedRows = Array.isArray(story?.content) ? story.content : [];
  const existingRows = Array.isArray(existingStory?.content) ? existingStory.content : [];
  const summary = {
    available: existingRows.length > 0,
    compatible: existingRows.length > 0 && importedRows.length === existingRows.length,
    importedRows: importedRows.length,
    existingRows: existingRows.length,
    matchedRows: 0,
    unmatchedIndices: [],
    inherited: Object.fromEntries(inheritedFields.map(field => [field, 0])),
  };
  if (!summary.compatible) return { story, summary };

  importedRows.forEach((unit, index) => {
    const existing = existingRows[index];
    if (rowIdentity(story, unit) !== rowIdentity(existingStory, existing)) {
      summary.unmatchedIndices.push(index);
      return;
    }
    summary.matchedRows++;
    for (const field of inheritedFields) {
      const value = String(existing?.[field] ?? "");
      if (!value.trim()) continue;
      unit[field] = value;
      summary.inherited[field]++;
    }
  });
  story.translator = mergeProvenance(story.translator, existingStory.translator);
  story.proofreader = mergeProvenance(story.proofreader, existingStory.proofreader);
  return { story, summary };
}

export function inspectExistingTrackCompletion(story) {
  const rows = Array.isArray(story?.content) ? story.content : [];
  const cnTargetIndices = rows.flatMap((unit, index) =>
    String(unit?.TextJp || unit?.TextTw || "").trim() ? [index] : []);
  const missingCnIndices = cnTargetIndices.filter(index =>
    !String(rows[index]?.TextCn ?? "").trim());
  const voiceTargetIndices = rows.flatMap((unit, index) => {
    if (!new Set(["dialogue", "narration"]).has(inferScenarioRole(unit))) return [];
    if (!parseScenarioScriptSpeakers(unit).dialogueSpeaker) return [];
    const existingVoice = String(unit?.VoiceJp ?? "").trim();
    const text = effectiveTtsText(unit) || (existingVoice ? String(unit?.TextJp ?? "").trim() : "");
    if (!text || isPunctuationOnlyTtsText(text)) return [];
    return [index];
  });
  const preservedVoiceIndices = voiceTargetIndices.filter(index =>
    String(rows[index]?.VoiceJp ?? "").trim());
  const missingVoiceScriptIndices = voiceTargetIndices.filter(index =>
    !String(rows[index]?.VoiceJp ?? "").trim() &&
    !String(rows[index]?.TextJpVoice ?? "").trim());
  return {
    cnTargetIndices,
    missingCnIndices,
    cnComplete: missingCnIndices.length === 0,
    voiceTargetIndices,
    preservedVoiceIndices,
    missingVoiceScriptIndices,
    voiceScriptComplete: missingVoiceScriptIndices.length === 0,
  };
}
