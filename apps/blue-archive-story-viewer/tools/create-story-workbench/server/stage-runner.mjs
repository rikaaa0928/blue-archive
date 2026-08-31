import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  getPlayerCharacterId,
  loadTraditionalToSimplifiedCharacterNameMap,
} from "../../create-story/ba-character-catalog.mjs";
import {
  extractVoiceLines,
  fetchCharacterList,
  fetchContentJson,
  searchCharacter,
} from "../../create-story/download-ba-character.mjs";
import {
  fillMissingTextCnFromTextTw,
  markOpenCcTranslationSource,
  normalizeExistingTextCnCharacterNames,
} from "../../create-story/fill-text-cn-from-tw.mjs";
import { proofreadStoryTextCnWithLlm } from "../../create-story/proofread-text-cn-with-llm.mjs";
import {
  inferScenarioRole,
  isCollectiveScenarioSpeaker,
  isUnknownScenarioSpeaker,
  parseScenarioScriptSpeakers,
} from "../../create-story/scenario-script-speakers.mjs";
import { resolveRecordOutputPath } from "../../../scripts/record-story/record-output-path.mjs";
import {
  appRoot,
  applyTtsSkipDecision,
  createStoryToolsRoot,
  effectiveTtsText,
  jsonDigest,
  loadEnvFiles,
  localFilesRoot,
  missingPlannedVoiceIndices,
  nowIso,
  publicStoryPath,
  readJson,
  resolveTtsSkippedIndices,
  storyDigest,
  writeJsonAtomic,
} from "./lib/utils.mjs";
import {
  createRevision,
  getLatestRevisionForStage,
  getRevision,
  loadDraft,
  loadWorkspace,
  saveDraft,
  versionResourcePath,
  versionTtsManifestPath,
} from "./lib/workspaces.mjs";
import { buildCollectiveVoiceConfig } from "./lib/reviews.mjs";
import { reconcileWorkspace } from "./lib/reconcile.mjs";
import {
  getProduction,
  initializeProduction,
  productionInputStory,
  productionPaths,
  recordCnGeneration,
  recordSpeakerScan,
  recordVoiceScriptGeneration,
  validateProductionPreviewBranches,
  writeReferenceArtifact,
} from "./lib/production.mjs";

function playerCharacterNameByKey() {
  const tablePath = path.join(localFilesRoot, "player-data", "ScenarioCharacterNameExcelTable.json");
  const payload = readJson(tablePath, []);
  const rows = Array.isArray(payload) ? payload : payload.content ?? payload.DataList ?? [];
  const byId = new Map(rows.map(rawRow => {
    const row = rawRow?.Bytes ?? rawRow;
    return [Number(row.CharacterName), String(row.NameCN || row.NameJP || "")];
  }));
  return stableKey => byId.get(getPlayerCharacterId(stableKey)) ?? "";
}

function run(command, args, options = {}) {
  console.log(`$ ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: appRoot,
    stdio: "inherit",
    env: process.env,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} failed with exit code ${result.status}`);
  }
}

function cli(name) {
  return path.join(createStoryToolsRoot, name);
}

function temporaryStoryPath(jobDirectory, label) {
  fs.mkdirSync(jobDirectory, { recursive: true });
  return path.join(jobDirectory, `${label}.json`);
}

function reviewedTtsSkippedIndices(workspace, story) {
  const review2 = getLatestRevisionForStage(workspace.id, "review-2");
  const result = review2 ? readJson(review2.resultPath, {}) : {};
  return resolveTtsSkippedIndices(story, result);
}

async function rawImport(workspace, params, jobDirectory) {
  const output = temporaryStoryPath(jobDirectory, "raw-import-story");
  const args = [
    cli("import-ba-raw-story.mjs"),
    workspace.identity.storyId,
    "--type", workspace.identity.type,
    "--output", output,
    "--workbench-raw-import",
    "--force",
  ];
  if (workspace.identity.directoryId) args.push("--directory-id", workspace.identity.directoryId);
  if (params.schema) args.push("--schema", String(params.schema));
  if (params.baL10nInput) args.push("--ba-l10n-input", String(params.baL10nInput));
  run(process.execPath, args);
  const story = readJson(output);
  return createRevision(workspace.id, {
    stage: "raw-import",
    story,
    result: { importedAt: nowIso(), source: "raw-table-plus-ba-l10n" },
  });
}

async function productionPrepare(workspace, params, jobDirectory) {
  const output = temporaryStoryPath(jobDirectory, "production-base-import");
  const args = [
    cli("import-ba-raw-story.mjs"),
    workspace.identity.storyId,
    "--type", workspace.identity.type,
    "--output", output,
    "--workbench-raw-import",
    "--force",
  ];
  if (workspace.identity.directoryId) args.push("--directory-id", workspace.identity.directoryId);
  if (params.schema) args.push("--schema", String(params.schema));
  if (params.baL10nInput) args.push("--ba-l10n-input", String(params.baL10nInput));
  run(process.execPath, args);
  const story = readJson(output);
  const mappings = await loadTraditionalToSimplifiedCharacterNameMap();
  const fill = fillMissingTextCnFromTextTw(story.content, mappings);
  const names = normalizeExistingTextCnCharacterNames(story.content, mappings);
  markOpenCcTranslationSource(story, fill);
  initializeProduction(workspace.id, story, {
    preparedAt: nowIso(),
    source: "raw-table-plus-ba-l10n",
    normalization: { fill, names },
  });
  return {
    stage: "production-prepare",
    rows: story.content.length,
    baseStoryPath: productionPaths(workspace.id).baseStory,
  };
}

async function productionCnGenerate(workspace, params) {
  const story = productionInputStory(workspace.id, { includeCn: false, includeScript: false });
  const result = await proofreadStoryTextCnWithLlm(story, {
    passes: 2,
    model: params.model,
    guidance: params.guidance,
    thinkingLevel: params.thinkingLevel,
    project: params.project,
    location: params.location,
    refreshCache: Boolean(params.refreshCache),
    logger: console,
  });
  recordCnGeneration(workspace.id, story, result, {
    model: params.model,
    guidance: params.guidance,
  });
  return {
    stage: "production-cn-generate",
    model: result.model,
    passes: result.passes,
    changedRows: result.netChanges.length,
  };
}

function productionVoiceScriptGenerate(workspace, params, jobDirectory) {
  const input = temporaryStoryPath(jobDirectory, "production-voice-script-input");
  const output = temporaryStoryPath(jobDirectory, "production-voice-script-output");
  const story = productionInputStory(workspace.id, { includeCn: false, includeScript: false });
  writeJsonAtomic(input, story);
  const args = [
    cli("enrich-story-with-llm.mjs"), input,
    "--output", output,
    "--force",
    "--no-apply-overrides",
  ];
  if (params.model) args.push("--model", String(params.model));
  if (params.guidance) args.push("--guidance", String(params.guidance));
  if (params.project) args.push("--project", String(params.project));
  if (params.location) args.push("--location", String(params.location));
  run(process.execPath, args);
  const generated = readJson(output);
  const changes = generated.content.flatMap((unit, index) => {
    const before = String(story.content[index]?.TextJpVoice ?? story.content[index]?.TextJp ?? "");
    const after = String(unit.TextJpVoice ?? "");
    return before === after ? [] : [{ index, before, after }];
  });
  recordVoiceScriptGeneration(workspace.id, generated, {
    changedRows: changes.length,
    changes,
  }, {
    model: params.model || process.env.GEMINI_MODEL || "gemini-3.7-flash",
    guidance: params.guidance,
  });
  return {
    stage: "production-voice-script-generate",
    changedRows: changes.length,
  };
}

async function cnNormalize(workspace) {
  const current = getRevision(workspace.id);
  if (!current) throw new Error("Raw import revision is required");
  const story = structuredClone(current.story);
  const mappings = await loadTraditionalToSimplifiedCharacterNameMap();
  const fill = fillMissingTextCnFromTextTw(story.content, mappings);
  const names = normalizeExistingTextCnCharacterNames(story.content, mappings);
  markOpenCcTranslationSource(story, fill);
  return createRevision(workspace.id, {
    stage: "cn-normalize",
    story,
    result: { fill, names },
    inputRevision: current.name,
  });
}

async function cnProofread(workspace, stage, params) {
  const current = getRevision(workspace.id);
  if (!current) throw new Error("A story revision is required");
  const story = structuredClone(current.story);
  const result = await proofreadStoryTextCnWithLlm(story, {
    passes: 1,
    model: params.model,
    thinkingLevel: params.thinkingLevel,
    project: params.project,
    location: params.location,
    refreshCache: Boolean(params.refreshCache),
    logger: console,
  });
  return createRevision(workspace.id, {
    stage,
    story,
    result,
    inputRevision: current.name,
  });
}

async function voiceDraft(workspace, params, jobDirectory) {
  const current = getRevision(workspace.id);
  const output = temporaryStoryPath(jobDirectory, "voice-draft-story");
  const args = [cli("enrich-story-with-llm.mjs"), current.storyPath, "--output", output];
  if (params.force) args.push("--force");
  if (params.model) args.push("--model", String(params.model));
  if (params.project) args.push("--project", String(params.project));
  if (params.location) args.push("--location", String(params.location));
  run(process.execPath, args);
  const story = readJson(output);
  const review1Revision = getLatestRevisionForStage(workspace.id, "review-1");
  if (!review1Revision) throw new Error("Tool 1 approval is required before generating the voice draft");
  const speakerReviews = readJson(review1Revision.resultPath, {}).speakerReviews ?? [];
  const collectiveConfig = buildCollectiveVoiceConfig(workspace, story, speakerReviews);
  return createRevision(workspace.id, {
    stage: "voice-draft",
    story,
    result: { generatedAt: nowIso(), changedRows: story.content.filter((unit, index) =>
      unit.TextJpVoice !== current.story.content[index]?.TextJpVoice).length },
    inputRevision: current.name,
    extraJsonFiles: { "collective-voice-config.json": collectiveConfig },
  });
}

async function voiceRegenerate(workspace, params, jobDirectory) {
  const initialDraft = loadDraft(workspace.id, "tool2");
  if (!initialDraft || !Array.isArray(initialDraft.story?.content)) {
    throw new Error("An active tool2 review draft is required");
  }
  const allowed = new Set((initialDraft.issues ?? [])
    .filter(issue => issue.kind === "voice-script")
    .map(issue => issue.index));
  const indices = [...new Set((params.indices ?? []).map(Number))]
    .filter(index => Number.isSafeInteger(index) && allowed.has(index))
    .sort((a, b) => a - b);
  if (!indices.length) throw new Error("Select at least one voice-script line to regenerate");

  const input = temporaryStoryPath(jobDirectory, "voice-regenerate-input");
  const output = temporaryStoryPath(jobDirectory, "voice-regenerate-output");
  writeJsonAtomic(input, initialDraft.story);
  const args = [
    cli("enrich-story-with-llm.mjs"), input,
    "--output", output,
    "--force",
    "--indices", indices.join(","),
    "--no-apply-overrides",
  ];
  if (params.model) args.push("--model", String(params.model));
  if (params.project) args.push("--project", String(params.project));
  if (params.location) args.push("--location", String(params.location));
  run(process.execPath, args);

  const generated = readJson(output);
  const latestDraft = loadDraft(workspace.id, "tool2");
  if (!latestDraft || latestDraft.baseRevision !== initialDraft.baseRevision) {
    throw new Error("The tool2 review draft changed to another base revision while regenerating");
  }
  const next = structuredClone(latestDraft);
  const changes = [];
  for (const index of indices) {
    const before = String(next.story.content[index]?.TextJpVoice ?? "");
    const after = String(generated.content[index]?.TextJpVoice ?? "");
    next.story.content[index].TextJpVoice = after;
    for (const issue of next.issues.filter(issue => issue.index === index)) {
      next.decisions[issue.id] = "pending";
    }
    changes.push({ index, before, after, changed: before !== after });
  }
  const model = String(params.model || process.env.GEMINI_MODEL || "gemini-3.7-flash");
  next.regenerationHistory = [...(next.regenerationHistory ?? []), {
    regeneratedAt: nowIso(),
    model,
    indices,
    changes,
  }];
  saveDraft(workspace.id, "tool2", next);
  return {
    stage: "voice-regenerate",
    result: {
      model,
      requestedRows: indices.length,
      changedRows: changes.filter(change => change.changed).length,
      indices,
    },
  };
}

async function scanVoiceAvailability(story) {
  const cachePath = path.join(
    localFilesRoot,
    "create-story",
    "_shared",
    "gamekee-voice-catalog-cache.json",
  );
  const cache = readJson(cachePath, { schemaVersion: 1, characters: null, content: {} });
  const cacheAge = cache.characters?.checkedAt
    ? Date.now() - Date.parse(cache.characters.checkedAt)
    : Number.POSITIVE_INFINITY;
  const remoteCharacters = cacheAge < 24 * 60 * 60 * 1000 && Array.isArray(cache.characters?.items)
    ? cache.characters.items
    : await fetchCharacterList();
  if (remoteCharacters !== cache.characters?.items) {
    cache.characters = { checkedAt: nowIso(), items: remoteCharacters };
    writeJsonAtomic(cachePath, cache);
  }
  const characterNameFor = playerCharacterNameByKey();
  const stableKeys = [...new Set(story.content
    .map(unit => parseScenarioScriptSpeakers(unit).dialogueSpeaker)
    .filter(Boolean))]
    .filter(stableKey => !/^\?{2,}$/u.test(stableKey));
  const items = [];
  for (const stableKey of stableKeys) {
    const characterName = characterNameFor(stableKey);
    if (!characterName) {
      items.push({ stableKey, characterName: "", available: false, reason: "player-character-unresolved" });
      continue;
    }
    const remoteCharacter = searchCharacter(remoteCharacters, characterName);
    if (!remoteCharacter) {
      items.push({ stableKey, characterName, available: false, reason: "download-source-missing" });
      continue;
    }
    const contentId = String(remoteCharacter.content_id);
    let contentSummary = cache.content?.[contentId];
    if (
      contentSummary?.checkedAt &&
      Date.now() - Date.parse(contentSummary.checkedAt) >= 7 * 24 * 60 * 60 * 1000
    ) {
      contentSummary = null;
    }
    if (!contentSummary) {
      let content;
      try {
        content = await fetchContentJson(remoteCharacter.content_id);
      } catch (error) {
        if (/illustrated-book.*暂不支持/iu.test(String(error.message))) {
          items.push({
            stableKey,
            characterName,
            available: false,
            reason: "download-source-unsupported",
            remoteName: remoteCharacter.name,
            contentId: remoteCharacter.content_id,
          });
          continue;
        }
        throw error;
      }
      const voiceLines = extractVoiceLines(Array.isArray(content.baseData) ? content.baseData : []);
      contentSummary = {
        checkedAt: nowIso(),
        voiceLineCount: voiceLines.length,
        japaneseAudioCount: voiceLines.filter(line => line.audioJp).length,
      };
      cache.content ??= {};
      cache.content[contentId] = contentSummary;
      writeJsonAtomic(cachePath, cache);
    }
    const { voiceLineCount, japaneseAudioCount } = contentSummary;
    items.push({
      stableKey,
      characterName,
      available: japaneseAudioCount > 0,
      reason: japaneseAudioCount > 0 ? "japanese-voice-found" : "japanese-voice-missing",
      remoteName: remoteCharacter.name,
      contentId: remoteCharacter.content_id,
      voiceLineCount,
      japaneseAudioCount,
    });
  }
  return items;
}

async function voiceCatalog(workspace) {
  const current = getRevision(workspace.id);
  if (!current) throw new Error("A story revision is required");
  const items = await scanVoiceAvailability(current.story);
  const result = {
    schemaVersion: 1,
    checkedAt: nowIso(),
    sourceRevision: current.name,
    storyDigest: storyDigest(current.story),
    items,
  };
  writeJsonAtomic(versionResourcePath(workspace.id, "voice-availability.json"), result);
  return { stage: "voice-catalog", ...result };
}

async function productionSpeakerScan(workspace) {
  const story = productionInputStory(workspace.id, { includeCn: false, includeScript: false });
  const availability = await scanVoiceAvailability(story);
  const availabilityByKey = new Map(availability.map(item => [item.stableKey, item]));
  const storyIndicesBySpeaker = new Map();
  story.content.forEach((unit, storyIndex) => {
    const { dialogueSpeaker } = parseScenarioScriptSpeakers(unit);
    if (!dialogueSpeaker) return;
    const indices = storyIndicesBySpeaker.get(dialogueSpeaker) ?? [];
    indices.push(storyIndex);
    storyIndicesBySpeaker.set(dialogueSpeaker, indices);
  });
  const items = [];
  const known = new Set();
  story.content.forEach((unit, storyIndex) => {
    if (!new Set(["dialogue", "narration"]).has(inferScenarioRole(unit))) return;
    const { dialogueSpeaker } = parseScenarioScriptSpeakers(unit);
    if (!dialogueSpeaker) return;
    const exceptional = isUnknownScenarioSpeaker(dialogueSpeaker) ||
      isCollectiveScenarioSpeaker(dialogueSpeaker);
    if (exceptional) {
      items.push({
        stableKey: `line:${storyIndex}`,
        storyIndex,
        storyIndices: [storyIndex],
        sourceSpeaker: dialogueSpeaker,
        characterName: "",
        available: false,
        requiresHuman: true,
        reason: isUnknownScenarioSpeaker(dialogueSpeaker)
          ? "unknown-speaker"
          : "collective-speaker",
        resolution: null,
      });
      return;
    }
    if (known.has(dialogueSpeaker)) return;
    known.add(dialogueSpeaker);
    const catalog = availabilityByKey.get(dialogueSpeaker) ?? {
      stableKey: dialogueSpeaker,
      characterName: "",
      available: false,
      reason: "player-character-unresolved",
    };
    items.push({
      ...catalog,
      sourceSpeaker: dialogueSpeaker,
      storyIndices: [...(storyIndicesBySpeaker.get(dialogueSpeaker) ?? [])],
      requiresHuman: catalog.available !== true,
      resolution: catalog.available === true ? {
        type: "character",
        stableKey: dialogueSpeaker,
        characterName: catalog.characterName,
      } : null,
    });
  });
  recordSpeakerScan(workspace.id, items, { catalogCheckedAt: nowIso() });
  return {
    stage: "production-speaker-scan",
    total: items.length,
    automatic: items.filter(item => !item.requiresHuman).length,
    requiresHuman: items.filter(item => item.requiresHuman).length,
  };
}

function replaceScriptSpeaker(unit, nextSpeaker) {
  const parts = String(unit.ScriptKr ?? "").split(";");
  if (parts.length < 2) return;
  parts[1] = nextSpeaker;
  unit.ScriptKr = parts.join(";");
}

function prepareProductionVoiceInput(workspace, { requireScript = true } = {}) {
  const production = getProduction(workspace.id, { includeStory: false, includeHistory: false });
  if (!production.voice.speakers.ready) throw new Error("Resolve all speaker exceptions first");
  if (requireScript && !production.voice.script.ready) {
    throw new Error("Approve the overall voice script first");
  }
  const story = productionInputStory(workspace.id, { includeCn: true, includeScript: true });
  const items = production.voice.speakers.items;
  const speakerReviews = [];
  for (const item of items) {
    const resolution = item.resolution;
    if (!resolution) continue;
    if (resolution.type === "collective") {
      const members = [...new Set((resolution.members ?? []).map(String).map(value => value.trim()).filter(Boolean))];
      if (members.length < 2) {
        throw new Error(`Collective speaker at line ${item.storyIndex} requires at least two members`);
      }
      if (effectiveTtsText(story.content[item.storyIndex] ?? {})) {
        speakerReviews.push({
          storyIndex: item.storyIndex,
          kind: "collective",
          members,
          evidence: "人工确认的团体发言成员",
        });
      }
      continue;
    }
    if (!new Set(["character", "npc"]).has(resolution.type)) continue;
    const nextSpeaker = resolution.type === "npc"
      ? "__anonymous_npc__"
      : String(resolution.stableKey ?? "").trim();
    if (!nextSpeaker) throw new Error(`Speaker ${item.sourceSpeaker} needs a stable character key`);
    const applicableIndices = story.content.flatMap((unit, index) => {
      const applies = Number.isSafeInteger(item.storyIndex)
        ? index === item.storyIndex
        : parseScenarioScriptSpeakers(unit).dialogueSpeaker === item.sourceSpeaker;
      return applies ? [index] : [];
    });
    const needsReviewedLine = resolution.type === "npc" || item.reason === "unknown-speaker";
    if (needsReviewedLine) {
      for (const storyIndex of applicableIndices) {
        if (!effectiveTtsText(story.content[storyIndex] ?? {})) continue;
        speakerReviews.push({
          storyIndex,
          kind: "unknown-speaker",
          resolution: resolution.type === "npc" ? "anonymous" : "character",
          resolvedSpeaker: nextSpeaker,
          evidence: resolution.type === "npc"
            ? "人工确认使用预制 NPC 音色"
            : `人工确认未知说话人为 ${resolution.characterName || nextSpeaker}`,
        });
      }
      continue;
    }
    for (const storyIndex of applicableIndices) replaceScriptSpeaker(story.content[storyIndex], nextSpeaker);
  }
  const config = buildCollectiveVoiceConfig(workspace, story, speakerReviews);
  return { production, story, config };
}

function ensureProductionCharacterResources(production) {
  const characterNameFor = playerCharacterNameByKey();
  const stableKeys = new Set();
  for (const item of production.voice.speakers.items) {
    const resolution = item.resolution;
    if (resolution?.type === "character") stableKeys.add(String(resolution.stableKey));
    if (resolution?.type === "collective") {
      for (const member of resolution.members ?? []) stableKeys.add(String(member));
    }
  }
  const downloaded = [];
  for (const stableKey of stableKeys) {
    const item = production.voice.speakers.items.find(candidate =>
      candidate.resolution?.type === "character" && candidate.resolution.stableKey === stableKey);
    const characterName = String(item?.resolution?.characterName || characterNameFor(stableKey)).trim();
    if (!characterName) throw new Error(`Cannot resolve a Chinese character name for ${stableKey}`);
    const characterDirectory = path.join(localFilesRoot, "ba-characters", characterName);
    if (!fs.existsSync(characterDirectory)) {
      downloadCharacter({ characterName });
      downloaded.push(characterName);
    }
  }
  return downloaded;
}

function runProductionTts(workspace, stage, params = {}) {
  const paths = productionPaths(workspace.id);
  const { production, story, config } = prepareProductionVoiceInput(workspace, {
    requireScript: stage !== "prepare",
  });
  fs.mkdirSync(paths.ttsRoot, { recursive: true });
  writeJsonAtomic(paths.ttsInputStory, story);
  writeJsonAtomic(paths.ttsSpeakerConfig, config);
  writeJsonAtomic(paths.ttsReferenceSelections, production.voice.references.selections ?? {});
  const args = [
    cli("voice-zero-tts.mjs"), paths.ttsInputStory,
    "--type", workspace.identity.type,
    "--story-id", workspace.identity.storyId,
    "--stage", stage,
    "--manifest", paths.ttsManifest,
    "--collective-config", paths.ttsSpeakerConfig,
    "--reference-selection", paths.ttsReferenceSelections,
  ];
  if (workspace.identity.directoryId) args.push("--directory-id", workspace.identity.directoryId);
  if (production.voice.script.effectiveSkippedIndices.length) {
    args.push("--skip-indices", production.voice.script.effectiveSkippedIndices.join(","));
  }
  if (Array.isArray(params.indices) && params.indices.length) {
    args.push("--indices", params.indices.map(Number).join(","));
  }
  if (params.force) args.push("--force");
  run(process.execPath, args);
  return { paths, production };
}

function productionReferencePrepare(workspace) {
  const before = prepareProductionVoiceInput(workspace, { requireScript: false }).production;
  const downloaded = ensureProductionCharacterResources(before);
  const { paths } = runProductionTts(workspace, "prepare");
  const manifest = readJson(paths.ttsManifest);
  const selections = Object.fromEntries(Object.entries(manifest.references ?? {})
    .filter(([, reference]) => !reference.presetReference)
    .map(([speaker, reference]) => [speaker, (reference.clips ?? []).map(clip => String(clip.name))]));
  writeReferenceArtifact(workspace.id, selections, {
    note: "一键拉取并自动选择参考音",
    source: "automatic",
    manifestDigest: jsonDigest(manifest.references ?? {}),
  });
  return { stage: "production-reference-prepare", downloaded, speakers: Object.keys(selections).length };
}

function productionTts(workspace, params) {
  const { paths, production } = runProductionTts(workspace, "all", params);
  const publishedTransformed = path.join(paths.ttsRoot, "published-transformed-story.json");
  const publishArgs = [
    cli("publish-voice-r2.mjs"), paths.ttsInputStory,
    "--type", workspace.identity.type,
    "--output", publishedTransformed,
    "--manifest", paths.ttsManifest,
  ];
  if (workspace.identity.directoryId) publishArgs.push("--directory-id", workspace.identity.directoryId);
  if (production.voice.script.effectiveSkippedIndices.length) {
    publishArgs.push("--skip-indices", production.voice.script.effectiveSkippedIndices.join(","));
  }
  if (params.proxy) publishArgs.push("--proxy", String(params.proxy));
  run(process.execPath, publishArgs);
  const published = readJson(publishedTransformed);
  const canonical = productionInputStory(workspace.id, { includeCn: true, includeScript: true });
  canonical.content.forEach((unit, index) => {
    unit.VoiceJp = String(published.content?.[index]?.VoiceJp ?? "");
  });
  writeJsonAtomic(paths.ttsOutputStory, canonical);
  const latest = getProduction(workspace.id, { includeStory: false, includeHistory: false });
  writeJsonAtomic(paths.ttsState, {
    schemaVersion: 1,
    completedAt: nowIso(),
    inputs: {
      speakers: latest.voice.speakers.digest,
      references: latest.voice.references.digest,
      script: latest.voice.script.digest,
      skipped: jsonDigest(latest.voice.script.effectiveSkippedIndices),
    },
    storyDigest: storyDigest(canonical),
  });
  return {
    stage: "production-tts",
    manifestPath: paths.ttsManifest,
    outputStoryPath: paths.ttsOutputStory,
    voicedRows: canonical.content.filter(unit => String(unit.VoiceJp ?? "").trim()).length,
  };
}

function tts(workspace, params, jobDirectory) {
  const current = getRevision(workspace.id);
  const stage = String(params.ttsStage || "prepare");
  if (!new Set(["prepare", "upload", "tasks", "poll", "all"]).has(stage)) {
    throw new Error(`Invalid TTS stage: ${stage}`);
  }
  const manifestPath = versionTtsManifestPath(workspace.id, { migrateLegacy: true });
  const args = [
    cli("voice-zero-tts.mjs"), current.storyPath,
    "--type", workspace.identity.type,
    "--story-id", workspace.identity.storyId,
    "--stage", stage,
    "--manifest", manifestPath,
  ];
  const skippedIndices = reviewedTtsSkippedIndices(workspace, current.story);
  if (skippedIndices.length) args.push("--skip-indices", skippedIndices.join(","));
  let collectiveConfig = path.join(current.root, "collective-voice-config.json");
  if (!fs.existsSync(collectiveConfig)) {
    // Revisions created before the workbench stored this artifact must remain runnable.
    // Rebuild it in the disposable job directory without mutating the immutable revision.
    const review1Revision = getLatestRevisionForStage(workspace.id, "review-1");
    if (!review1Revision) {
      throw new Error("Tool 1 speaker review is required before preparing voice resources");
    }
    const speakerReviews = readJson(review1Revision.resultPath, {}).speakerReviews ?? [];
    collectiveConfig = path.join(jobDirectory, "collective-voice-config.json");
    writeJsonAtomic(
      collectiveConfig,
      buildCollectiveVoiceConfig(workspace, current.story, speakerReviews),
    );
  }
  args.push("--collective-config", collectiveConfig);
  const referenceSelections = versionResourcePath(
    workspace.id, "reference-selections.json", { legacyFallback: true },
  );
  if (fs.existsSync(referenceSelections)) {
    args.push("--reference-selection", referenceSelections);
  }
  if (workspace.identity.directoryId) args.push("--directory-id", workspace.identity.directoryId);
  if (params.missingOnly) args.push("--missing-only");
  if (params.changedOnly) args.push("--changed-only");
  if (Array.isArray(params.indices) && params.indices.length) {
    args.push("--indices", params.indices.join(","));
  }
  if (params.force) args.push("--force");
  run(process.execPath, args);
  const archived = archiveTtsAudio(workspace, manifestPath);
  return { stage: "tts", ttsStage: stage, manifestPath, archived };
}

function ttsLineRevise(workspace, params, jobDirectory) {
  const current = getRevision(workspace.id);
  const review2 = getLatestRevisionForStage(workspace.id, "review-2");
  if (!current || !review2) throw new Error("An approved Japanese voice script is required");
  const index = Number(params.index);
  const text = String(params.ttsText ?? "").trim();
  const note = String(params.note ?? "").trim();
  if (!Number.isSafeInteger(index) || index < 0 || !current.story.content[index]) {
    throw new Error("A valid voice line index is required");
  }
  if (!text || text.length > 2000) throw new Error("TTS text must contain 1-2000 characters");
  if (!note || note.length > 500) throw new Error("A 1-500 character revision note is required");
  const previousResult = readJson(review2.resultPath, {});
  const planIndex = (previousResult.ttsPlan ?? []).findIndex(item => Number(item.index) === index);
  if (planIndex < 0) throw new Error(`Story line ${index} is not an approved voice line`);

  const story = structuredClone(current.story);
  const before = String(story.content[index].TextJpVoice ?? story.content[index].TextJp ?? "").trim();
  story.content[index].TextJpVoice = text;
  const ttsPlan = structuredClone(previousResult.ttsPlan);
  ttsPlan[planIndex] = {
    ...ttsPlan[planIndex],
    expected: { ...ttsPlan[planIndex].expected, ttsText: text },
    contentLength: text.length,
    scanDigest: jsonDigest([String(story.content[index].ScriptKr ?? ""), text]),
  };
  const review1 = getLatestRevisionForStage(workspace.id, "review-1");
  const speakerReviews = review1
    ? readJson(review1.resultPath, {}).speakerReviews ?? []
    : [];
  const revision = createRevision(workspace.id, {
    stage: "review-2",
    story,
    result: {
      approvedAt: nowIso(),
      reviewDigest: jsonDigest({ inputRevision: current.name, index, before, after: text, note }),
      summary: { localizedRevision: true, changedLines: before === text ? 0 : 1 },
      ttsPlan,
      ttsSkippedIndices: previousResult.ttsSkippedIndices ?? [],
      ttsForcedIndices: previousResult.ttsForcedIndices ?? [],
      localizedRevision: { index, before, after: text, note, revisedAt: nowIso() },
    },
    inputRevision: current.name,
    metadata: { humanReviewed: true, localizedVoiceRevision: true },
    extraJsonFiles: {
      "collective-voice-config.json": buildCollectiveVoiceConfig(workspace, story, speakerReviews),
    },
  });
  const synthesis = tts(loadWorkspace(workspace.id), {
    ttsStage: "all",
    indices: [index],
    force: true,
  }, jobDirectory);
  return {
    stage: "tts-line-revise",
    revision: revision.name,
    index,
    before,
    after: text,
    note,
    synthesis,
  };
}

function ttsLineSkip(workspace, params) {
  const current = getRevision(workspace.id);
  const review2 = getLatestRevisionForStage(workspace.id, "review-2");
  if (!current || !review2) throw new Error("An approved Japanese voice script is required");
  const index = Number(params.index);
  const skipped = params.skipped === true;
  if (!Number.isSafeInteger(index) || index < 0 || !current.story.content[index]) {
    throw new Error("A valid voice line index is required");
  }
  const previousResult = readJson(review2.resultPath, {});
  const skipDecision = applyTtsSkipDecision(
    current.story,
    previousResult,
    index,
    skipped,
  );
  const skippedIndices = new Set(skipDecision.ttsSkippedIndices);
  const existingPlan = structuredClone(previousResult.ttsPlan ?? []);
  if (skipped === skipDecision.wasSkipped) {
    throw new Error(`Story line ${index} is already ${skipped ? "skipped" : "enabled"}`);
  }
  const story = structuredClone(current.story);
  let ttsPlan = existingPlan.filter(item => Number(item.index) !== index);
  if (skipped) {
    story.content[index].VoiceJp = "";
  } else {
    const text = effectiveTtsText(story.content[index]);
    const speaker = parseScenarioScriptSpeakers(story.content[index]).dialogueSpeaker;
    if (!text || !speaker) throw new Error(`Story line ${index} cannot be restored to TTS`);
    ttsPlan.push({
      index,
      speakerKr: speaker,
      expected: { ttsText: text },
      contentLength: text.length,
      scanDigest: jsonDigest([String(story.content[index].ScriptKr ?? ""), text]),
    });
    ttsPlan.sort((left, right) => left.index - right.index);
  }
  const review1 = getLatestRevisionForStage(workspace.id, "review-1");
  const speakerReviews = review1 ? readJson(review1.resultPath, {}).speakerReviews ?? [] : [];
  const revision = createRevision(workspace.id, {
    stage: "review-2",
    story,
    result: {
      approvedAt: nowIso(),
      reviewDigest: jsonDigest({ inputRevision: current.name, index, skipped }),
      summary: { localizedSkipDecision: true },
      ttsPlan,
      ttsSkippedIndices: skipDecision.ttsSkippedIndices,
      ttsForcedIndices: skipDecision.ttsForcedIndices,
      localizedSkipDecision: { index, skipped, decidedAt: nowIso() },
    },
    inputRevision: current.name,
    metadata: { humanReviewed: true, localizedVoiceRevision: true },
    extraJsonFiles: {
      "collective-voice-config.json": buildCollectiveVoiceConfig(workspace, story, speakerReviews),
    },
  });
  return { stage: "tts-line-skip", revision: revision.name, index, skipped };
}

function archiveTtsAudio(workspace, manifestPath) {
  if (!fs.existsSync(manifestPath)) return 0;
  const manifest = readJson(manifestPath);
  const archiveRoot = path.join(
    workspace.paths.root, "versions", workspace.activeVersionId, "tts", "audio",
  );
  let archived = 0;
  const visit = (task, suffix = "") => {
    if (!task || typeof task !== "object") return;
    const source = String(task.audioPath ?? "");
    if (source && fs.existsSync(source)) {
      const token = String(task.downloadedTaskId || task.taskId || task.mix?.inputsHash || "audio")
        .replace(/[^A-Za-z0-9._-]+/gu, "-")
        .slice(0, 80);
      const index = String(Number.isSafeInteger(task.index) ? task.index : "line").padStart(4, "0");
      const destination = path.join(archiveRoot, `${index}${suffix}-${token}.mp3`);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      if (path.resolve(source) !== path.resolve(destination) && !fs.existsSync(destination)) {
        fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      }
      task.audioPath = destination;
      archived += 1;
    }
    for (const [speaker, member] of Object.entries(task.members ?? {})) {
      visit(member, `-${String(speaker).replace(/[^A-Za-z0-9._-]+/gu, "-").slice(0, 40)}`);
    }
  };
  Object.values(manifest.tasks ?? {}).forEach(task => visit(task));
  writeJsonAtomic(manifestPath, manifest);
  return archived;
}

function downloadCharacter(params) {
  const characterName = String(params.characterName ?? "").trim();
  if (!characterName || characterName.length > 80 || /[\\/]/u.test(characterName)) {
    throw new Error("A valid characterName is required");
  }
  run(process.execPath, [cli("download-ba-character.mjs"), characterName]);
  return { stage: "download-character", characterName };
}

function downloadMissingCharacters(workspace) {
  const resources = reconcileWorkspace(workspace.id).resources;
  const characterNames = [...new Set(resources.items
    .filter(item => !item.resourceReady && item.manualSelectionAvailable && item.characterId)
    .map(item => String(item.characterName ?? "").trim())
    .filter(Boolean))];
  console.log(`Missing character resource directories: ${characterNames.length}`);
  characterNames.forEach((characterName, index) => {
    console.log(`\n═══ Character ${index + 1}/${characterNames.length}: ${characterName} ═══`);
    downloadCharacter({ characterName });
  });
  return {
    stage: "download-missing-characters",
    total: characterNames.length,
    downloaded: characterNames,
  };
}

function syncTables(params) {
  const args = [cli("sync-ba-story-data.mjs")];
  if (params.skipDownload) args.push("--skip-download");
  if (params.dataDir) args.push("--data-dir", String(params.dataDir));
  if (params.region) args.push("--region", String(params.region));
  if (params.proxy) args.push("--proxy", String(params.proxy));
  run(process.execPath, args);
  return { stage: "sync" };
}

function eventIndex(workspace, params) {
  if (workspace.identity.type !== "event") throw new Error("Event index only applies to event stories");
  const place = String(params.place ?? "").toLowerCase();
  if (!new Set(["shanhaijing", "millennium", "trinity"]).has(place)) {
    throw new Error("place must be shanhaijing, millennium, or trinity");
  }
  run(process.execPath, [
    cli("generate-event-story-index.mjs"), workspace.identity.storyId,
    "--place", place,
  ]);
  const output = path.join(appRoot, "src", "index", "eventStoryIndex.generated.json");
  if (!fs.existsSync(output)) throw new Error(`Event index output is missing: ${output}`);
  return { stage: "event-index", place, output, size: fs.statSync(output).size };
}

function productionEventIndex(workspace, params) {
  const production = getProduction(workspace.id, { includeStory: false, includeHistory: false });
  if (!production.publicArtifact.current) throw new Error("Publish the current assembly first");
  const result = eventIndex(workspace, params);
  writeJsonAtomic(productionPaths(workspace.id).eventIndex, {
    schemaVersion: 1,
    completedAt: nowIso(),
    assemblyDigest: production.assembly.manifest.storyDigest,
    place: result.place,
    output: result.output,
  });
  return { ...result, stage: "production-event-index" };
}

function recordStory(workspace, params) {
  const typePrefix = {
    event: "eventStory", group: "groupStory", favor: "favorStory",
    main: "mainStory", mini: "miniStory", other: "otherStory",
  }[workspace.identity.type];
  const recordingStoryPath = `${typePrefix}/${workspace.identity.storyId}`;
  const args = [recordingStoryPath, `--subtitle=${params.subtitle || "cn"}`];
  const review1 = getLatestRevisionForStage(workspace.id, "review-1");
  const recordingPreSelections = review1
    ? readJson(review1.resultPath, {}).recordingPreSelections ?? []
    : [];
  const preselectionArguments = [cli("preselect-options.mjs"), recordingStoryPath];
  for (const selection of recordingPreSelections) {
    preselectionArguments.push(`--selection=${selection.storyIndex}:${selection.selectionGroup}`);
  }
  run(process.execPath, preselectionArguments);
  if (params.headed) args.push("--no-headless");
  run(path.join(appRoot, "run-record.sh"), args);
  const resolved = resolveRecordOutputPath(args[0], {
    subtitleLanguage: params.subtitle || "cn",
    appRoot,
  });
  const output = path.join(appRoot, "scripts", "record-story", "videos", `${resolved.relativeBasePath}.mp4`);
  if (!fs.existsSync(output) || fs.statSync(output).size === 0) {
    throw new Error(`Recording output is missing: ${output}`);
  }
  const archive = path.join(
    workspace.paths.root, "versions", workspace.activeVersionId, "record",
    `${path.basename(output, ".mp4")}-${Date.now()}.mp4`,
  );
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.copyFileSync(output, archive, fs.constants.COPYFILE_EXCL);
  return {
    stage: "record",
    story: args[0],
    subtitle: params.subtitle || "cn",
    output: archive,
    sourceOutput: output,
    size: fs.statSync(archive).size,
  };
}

function productionRecord(workspace, params) {
  const production = validateProductionPreviewBranches(workspace.id);
  const paths = productionPaths(workspace.id);
  const typePrefix = {
    event: "eventStory", group: "groupStory", favor: "favorStory",
    main: "mainStory", mini: "miniStory", other: "otherStory",
  }[workspace.identity.type];
  const recordingStoryPath = `${typePrefix}/${workspace.identity.storyId}`;
  const preselectionArguments = [
    cli("preselect-options.mjs"), recordingStoryPath,
    `--story-file=${paths.assemblyStory}`,
  ];
  for (const [storyIndex, selectionGroup] of Object.entries(
    production.preview.branches.defaultSelectionGroups ?? {},
  )) {
    preselectionArguments.push(`--selection=${storyIndex}:${selectionGroup}`);
  }
  run(process.execPath, preselectionArguments);
  const args = [
    recordingStoryPath,
    `--subtitle=${params.subtitle || "cn"}`,
    `--story-file=${paths.assemblyStory}`,
  ];
  if (params.headed) args.push("--no-headless");
  run(path.join(appRoot, "run-record.sh"), args);
  const resolved = resolveRecordOutputPath(args[0], {
    subtitleLanguage: params.subtitle || "cn",
    appRoot,
    storyFile: paths.assemblyStory,
  });
  const output = path.join(
    appRoot, "scripts", "record-story", "videos", `${resolved.relativeBasePath}.mp4`,
  );
  if (!fs.existsSync(output) || fs.statSync(output).size === 0) {
    throw new Error(`Recording output is missing: ${output}`);
  }
  run("ffprobe", [
    "-v", "error", "-show_entries", "format=duration,size",
    "-of", "json", output,
  ]);
  run("ffmpeg", ["-v", "error", "-i", output, "-f", "null", "-"]);
  const previewOutput = path.join(paths.root, "preview-video.mp4");
  const temporaryPreviewOutput = `${previewOutput}.tmp-${process.pid}`;
  fs.copyFileSync(output, temporaryPreviewOutput);
  fs.renameSync(temporaryPreviewOutput, previewOutput);
  writeJsonAtomic(paths.recording, {
    schemaVersion: 1,
    completedAt: nowIso(),
    assemblyDigest: production.assembly.manifest.storyDigest,
    branchDigest: jsonDigest(production.preview.branches),
    output: previewOutput,
    sourceOutput: output,
    size: fs.statSync(previewOutput).size,
    validation: { ffprobe: true, fullDecode: true },
  });
  return {
    stage: "production-record",
    output: previewOutput,
    sourceOutput: output,
    size: fs.statSync(previewOutput).size,
    validated: true,
  };
}

function productionCoverGenerate(workspace, params, jobDirectory) {
  const production = getProduction(workspace.id, { includeStory: false, includeHistory: false });
  const paths = productionPaths(workspace.id);
  if (!production.assembly.current || !fs.existsSync(paths.assemblyStory)) {
    throw new Error("The current subtitle and voice tracks must be assembled before cover generation");
  }
  const resultPath = path.join(jobDirectory, "cover-generation-result.json");
  const args = [
    cli("generate-story-cover.mjs"),
    paths.assemblyStory,
    "--story-id", workspace.identity.storyId,
    "--analysis-model", String(params.analysisModel || "gemini-3.7-flash"),
    "--image-model", String(params.imageModel || "gemini-3.1-flash-image"),
    "--qa-model", String(params.qaModel || "gemini-3.7-flash"),
    "--resolution", String(params.resolution || "2K"),
    "--max-attempts", String(params.maxAttempts || 2),
    "--result-json", resultPath,
  ];
  if (fs.existsSync(paths.speakers)) args.push("--speaker-config", paths.speakers);
  if (String(params.guidance || "").trim()) args.push("--guidance", String(params.guidance).trim());
  if (params.includeLobby) args.push("--include-lobby");
  run(process.execPath, args);
  const result = readJson(resultPath);
  return {
    stage: "production-cover-generate",
    ...result,
  };
}

function r2(workspace, params, jobDirectory) {
  const current = getRevision(workspace.id);
  const output = temporaryStoryPath(jobDirectory, "r2-story");
  const args = [
    cli("publish-voice-r2.mjs"), current.storyPath,
    "--type", workspace.identity.type,
    "--output", output,
    "--manifest", versionTtsManifestPath(workspace.id, { migrateLegacy: true }),
  ];
  const skippedIndices = reviewedTtsSkippedIndices(workspace, current.story);
  if (skippedIndices.length) args.push("--skip-indices", skippedIndices.join(","));
  if (workspace.identity.directoryId) args.push("--directory-id", workspace.identity.directoryId);
  if (params.skipUpload) args.push("--skip-upload");
  if (params.missingOnly) args.push("--missing-only");
  if (params.proxy) args.push("--proxy", String(params.proxy));
  run(process.execPath, args);
  const story = readJson(output);
  return createRevision(workspace.id, {
    stage: "r2",
    story,
    result: { publishedVoiceRows: story.content.filter(unit => String(unit.VoiceJp ?? "").trim()).length },
    inputRevision: current.name,
  });
}

function releaseValidate(workspace) {
  const current = getRevision(workspace.id);
  if (current.stage !== "r2") {
    throw new Error("The current revision must be the R2-published revision");
  }
  const requiredStages = ["review-1", "review-2", "r2"];
  const absent = requiredStages.filter(stage => !getLatestRevisionForStage(workspace.id, stage));
  if (absent.length) throw new Error(`Missing required reviewed revisions: ${absent.join(", ")}`);
  const review2 = getLatestRevisionForStage(workspace.id, "review-2");
  const review2Result = readJson(review2.resultPath, {});
  const skippedIndices = reviewedTtsSkippedIndices(workspace, current.story);
  const missing = missingPlannedVoiceIndices(
    current.story,
    review2Result.ttsPlan,
    skippedIndices,
  );
  if (missing.length) throw new Error(`VoiceJp is missing at rows: ${missing.slice(0, 30).join(", ")}`);
  return createRevision(workspace.id, {
    stage: "release-validate",
    story: current.story,
    result: {
      validatedAt: nowIso(),
      rows: current.story.content.length,
      plannedVoiceRows: review2Result.ttsPlan?.length ?? 0,
      skippedVoiceRows: skippedIndices.length,
      missingVoiceRows: [],
    },
    inputRevision: current.name,
  });
}

function publish(workspace) {
  const current = getRevision(workspace.id);
  if (current.stage !== "release-validate") {
    throw new Error("The current revision must pass release validation before publish");
  }
  const destination = publicStoryPath(workspace.identity);
  writeJsonAtomic(destination, current.story);
  return createRevision(workspace.id, {
    stage: "publish",
    story: current.story,
    result: { publishedAt: nowIso(), destination, digest: storyDigest(current.story) },
    inputRevision: current.name,
  });
}

async function main() {
  loadEnvFiles();
  const [workspaceId, action, paramsPath, jobDirectory] = process.argv.slice(2);
  if (!workspaceId || !action || !paramsPath || !jobDirectory) {
    throw new Error("Usage: stage-runner.mjs <workspace-id> <action> <params-json> <job-dir>");
  }
  const workspace = loadWorkspace(workspaceId);
  const params = readJson(paramsPath, {});
  let result;
  switch (action) {
    case "production-prepare": result = await productionPrepare(workspace, params, jobDirectory); break;
    case "production-cn-generate": result = await productionCnGenerate(workspace, params); break;
    case "production-speaker-scan": result = await productionSpeakerScan(workspace); break;
    case "production-voice-script-generate":
      result = productionVoiceScriptGenerate(workspace, params, jobDirectory);
      break;
    case "production-reference-prepare": result = productionReferencePrepare(workspace); break;
    case "production-tts": result = productionTts(workspace, params); break;
    case "production-record": result = productionRecord(workspace, params); break;
    case "production-cover-generate": result = productionCoverGenerate(workspace, params, jobDirectory); break;
    case "production-event-index": result = productionEventIndex(workspace, params); break;
    case "raw-import": result = await rawImport(workspace, params, jobDirectory); break;
    case "cn-normalize": result = await cnNormalize(workspace); break;
    case "cn-llm-1": result = await cnProofread(workspace, action, params); break;
    case "cn-llm-2": result = await cnProofread(workspace, action, params); break;
    case "voice-catalog": result = await voiceCatalog(workspace); break;
    case "voice-draft": result = await voiceDraft(workspace, params, jobDirectory); break;
    case "voice-regenerate": result = await voiceRegenerate(workspace, params, jobDirectory); break;
    case "tts": result = tts(workspace, params, jobDirectory); break;
    case "tts-line-revise": result = ttsLineRevise(workspace, params, jobDirectory); break;
    case "tts-line-skip": result = ttsLineSkip(workspace, params); break;
    case "download-character": result = downloadCharacter(params); break;
    case "download-missing-characters": result = downloadMissingCharacters(workspace); break;
    case "sync": result = syncTables(params); break;
    case "event-index": result = eventIndex(workspace, params); break;
    case "record": result = recordStory(workspace, params); break;
    case "r2": result = r2(workspace, params, jobDirectory); break;
    case "release-validate": result = releaseValidate(workspace); break;
    case "publish": result = publish(workspace); break;
    default: throw new Error(`Unsupported stage action: ${action}`);
  }
  writeJsonAtomic(path.join(jobDirectory, "stage-result.json"), {
    action,
    completedAt: nowIso(),
    revision: result?.name ?? result?.revision ?? null,
    stage: result?.stage ?? action,
    summary: result?.result ?? (result?.name ? {} : result),
  });
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
