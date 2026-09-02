import fs from "node:fs";
import path from "node:path";

import {
  findRecordingOptionPages,
  parseRecordingOptions,
} from "../../../create-story/recording-selections.mjs";
import { parseScenarioScriptSpeakers } from "../../../create-story/scenario-script-speakers.mjs";

import {
  applyTtsSkipDecision,
  jsonDigest,
  nowIso,
  publicStoryPath,
  readJson,
  resolveTtsSkippedIndices,
  storyDigest,
  writeJsonAtomic,
} from "./utils.mjs";
import { loadWorkspace } from "./workspaces.mjs";

const schemaVersion = 1;

function pathsFor(identityOrId) {
  const workspace = loadWorkspace(identityOrId);
  const root = path.join(
    workspace.paths.root,
    "versions",
    workspace.activeVersionId,
    "production",
  );
  return {
    workspace,
    root,
    state: path.join(root, "state.json"),
    baseStory: path.join(root, "base-story.json"),
    cn: path.join(root, "tracks", "cn", "current.json"),
    cnRuns: path.join(root, "tracks", "cn", "llm-runs"),
    cnEdits: path.join(root, "tracks", "cn", "edits"),
    speakers: path.join(root, "tracks", "voice", "speakers.json"),
    speakerEdits: path.join(root, "tracks", "voice", "speaker-edits"),
    references: path.join(root, "tracks", "voice", "references.json"),
    referenceEdits: path.join(root, "tracks", "voice", "reference-edits"),
    script: path.join(root, "tracks", "voice", "script.json"),
    scriptRuns: path.join(root, "tracks", "voice", "script-runs"),
    scriptEdits: path.join(root, "tracks", "voice", "script-edits"),
    ttsRoot: path.join(root, "tracks", "voice", "tts"),
    ttsInputStory: path.join(root, "tracks", "voice", "tts", "input-story.json"),
    ttsOutputStory: path.join(root, "tracks", "voice", "tts", "story-with-voice.json"),
    ttsManifest: path.join(root, "tracks", "voice", "tts", "manifest.json"),
    ttsState: path.join(root, "tracks", "voice", "tts", "state.json"),
    ttsSpeakerConfig: path.join(root, "tracks", "voice", "tts", "speaker-config.json"),
    ttsReferenceSelections: path.join(root, "tracks", "voice", "tts", "reference-selections.json"),
    assemblyRoot: path.join(root, "assembly"),
    assemblyStory: path.join(root, "assembly", "story.json"),
    assemblyManifest: path.join(root, "assembly", "manifest.json"),
    preview: path.join(root, "preview.json"),
    branchDecisions: path.join(root, "branch-decisions.json"),
    branchEdits: path.join(root, "branch-edits"),
    recording: path.join(root, "recording.json"),
    eventIndex: path.join(root, "event-index.json"),
  };
}

function ensureProduction(identityOrId) {
  const paths = pathsFor(identityOrId);
  if (!fs.existsSync(paths.state)) {
    throw new Error("The independent-track production has not been prepared");
  }
  return paths;
}

function textRows(story, field) {
  return story.content.map((unit, index) => ({ index, text: String(unit[field] ?? "") }));
}

function trackDigest(rows, extra = {}) {
  return jsonDigest({ rows: rows.map(row => [row.index, row.text]), ...extra });
}

function scriptDigest(rows, ttsSkippedIndices = [], ttsForcedIndices = []) {
  return trackDigest(rows, {
    ttsSkippedIndices: [...ttsSkippedIndices].map(Number).sort((left, right) => left - right),
    ttsForcedIndices: [...ttsForcedIndices].map(Number).sort((left, right) => left - right),
  });
}

function structuralDigest(story) {
  return jsonDigest(story.content.map((unit, index) => [
    index,
    Number(unit.GroupId ?? story.GroupId ?? 0),
    String(unit.ScriptKr ?? ""),
    String(unit.TextJp ?? ""),
    Number(unit.SelectionGroup ?? 0),
  ]));
}

function nextRecordPath(directory, prefix) {
  fs.mkdirSync(directory, { recursive: true });
  const next = fs.readdirSync(directory)
    .map(name => new RegExp(`^${prefix}(\\d{6})-`, "u").exec(name))
    .filter(Boolean)
    .reduce((max, match) => Math.max(max, Number(match[1])), 0) + 1;
  return path.join(
    directory,
    `${prefix}${String(next).padStart(6, "0")}-${Date.now()}.json`,
  );
}

function appendRecord(directory, prefix, value) {
  const recordPath = nextRecordPath(directory, prefix);
  writeJsonAtomic(recordPath, value);
  return path.basename(recordPath);
}

function listRecords(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter(name => name.endsWith(".json"))
    .sort()
    .map(name => ({ id: name.replace(/\.json$/u, ""), ...readJson(path.join(directory, name)) }));
}

function findRecord(directory, id, label) {
  const normalizedId = String(id ?? "").replace(/\.json$/u, "");
  const record = listRecords(directory).find(candidate => candidate.id === normalizedId);
  if (!record) throw new Error(`${label} does not exist: ${id}`);
  return record;
}

function rowsForGenerationRun(paths, run, field, label) {
  const baseStory = readJson(paths.baseStory);
  const rows = Array.isArray(run.rows) && run.rows.length === baseStory.content.length
    ? run.rows.map((row, index) => ({ index, text: String(row?.text ?? "") }))
    : textRows(baseStory, field).map(row => ({
      ...row,
      text: field === "TextJpVoice"
        ? row.text || String(baseStory.content[row.index]?.TextJp ?? "")
        : row.text,
    }));
  if (!Array.isArray(run.rows)) {
    const changes = Array.isArray(run.result?.netChanges)
      ? run.result.netChanges
      : Array.isArray(run.result?.changes) ? run.result.changes : [];
    for (const change of changes) {
      const index = Number(change.index);
      if (!Number.isSafeInteger(index) || !rows[index]) {
        throw new Error(`${label} ${run.id} contains an invalid story index: ${change.index}`);
      }
      rows[index] = { index, text: String(change.after ?? "") };
    }
  }
  const digests = new Set([trackDigest(rows), scriptDigest(rows)]);
  if (run.afterDigest && !digests.has(run.afterDigest)) {
    throw new Error(`${label} ${run.id} cannot be reconstructed from its saved changes`);
  }
  return rows;
}

function cnRowsForRun(paths, run) {
  return rowsForGenerationRun(paths, run, "TextCn", "CN run");
}

function voiceScriptRowsForRun(paths, run) {
  return rowsForGenerationRun(paths, run, "TextJpVoice", "Voice-script run");
}

function writeState(paths, state) {
  writeJsonAtomic(paths.state, { ...state, updatedAt: nowIso() });
}

function readState(paths) {
  return readJson(paths.state);
}

function validateRows(baseStory, changes, fieldName) {
  if (!Array.isArray(changes) || !changes.length) {
    throw new Error("At least one changed line is required");
  }
  const seen = new Set();
  return changes.map(change => {
    const index = Number(change.index);
    const text = String(change.text ?? "");
    if (!Number.isSafeInteger(index) || index < 0 || !baseStory.content[index]) {
      throw new Error(`Invalid ${fieldName} story index: ${change.index}`);
    }
    if (seen.has(index)) throw new Error(`Duplicate ${fieldName} story index: ${index}`);
    seen.add(index);
    return { index, text };
  });
}

function mergeRowsIntoStory(story, rows, field) {
  for (const row of rows) {
    if (story.content[row.index]) story.content[row.index][field] = row.text;
  }
}

export function inspectAssembly(story) {
  const errors = [];
  const choices = findRecordingOptionPages(story.content).map(page => {
    const unit = story.content[page.storyIndex];
    const jpByGroup = new Map(parseRecordingOptions(unit.TextJp)
      .map(option => [option.selectionGroup, option.text]));
    const options = page.options.map(option => {
      const responseIndex = option.selectionGroup > 0
        ? story.content.findIndex((candidate, candidateIndex) =>
          candidateIndex > page.storyIndex &&
          Number(candidate.SelectionGroup) === option.selectionGroup)
        : -1;
      if (option.selectionGroup > 0 && responseIndex < 0) {
        errors.push(
          `选择页 #${page.storyIndex} 的 SelectionGroup ${option.selectionGroup} 没有响应入口`,
        );
      }
      return {
        ...option,
        textJp: jpByGroup.get(option.selectionGroup) ?? "",
        responseIndex: responseIndex < 0 ? null : responseIndex,
        key: `${page.storyIndex}:${option.selectionGroup}`,
      };
    });
    return { index: page.storyIndex, options };
  });
  story.content.forEach((unit, index) => {
    if (!unit || typeof unit !== "object") errors.push(`第 ${index} 行不是剧情对象`);
  });
  return { errors, choices };
}

export function productionPaths(identityOrId) {
  return pathsFor(identityOrId);
}

export function initializeProduction(identityOrId, baseStory, metadata = {}, options = {}) {
  if (!baseStory || !Array.isArray(baseStory.content)) {
    throw new Error("A complete normalized base story is required");
  }
  const paths = pathsFor(identityOrId);
  if (fs.existsSync(paths.state)) {
    throw new Error(
      `Production ${paths.workspace.activeVersionId} already exists; create a new production version to restart`,
    );
  }
  fs.mkdirSync(paths.root, { recursive: true });
  const createdAt = nowIso();
  const approveCnBaseline = Boolean(options.approveCnBaseline);
  const approveVoiceScriptBaseline = Boolean(options.approveVoiceScriptBaseline);
  const cnRows = textRows(baseStory, "TextCn");
  const scriptRows = textRows(baseStory, "TextJpVoice").map(row => ({
    ...row,
    text: row.text || String(baseStory.content[row.index]?.TextJp ?? ""),
  }));
  const cn = {
    schemaVersion,
    sourceDigest: storyDigest(baseStory),
    rows: cnRows,
    digest: trackDigest(cnRows),
    approvedAt: approveCnBaseline ? createdAt : null,
    approvedDigest: approveCnBaseline ? trackDigest(cnRows) : null,
    approvalSource: approveCnBaseline ? "existing-viewer-baseline" : null,
    updatedAt: createdAt,
  };
  const script = {
    schemaVersion,
    sourceDigest: storyDigest(baseStory),
    rows: scriptRows,
    ttsSkippedIndices: [],
    ttsForcedIndices: [],
    digest: scriptDigest(scriptRows),
    approvedAt: approveVoiceScriptBaseline ? createdAt : null,
    approvedDigest: approveVoiceScriptBaseline ? scriptDigest(scriptRows) : null,
    approvalSource: approveVoiceScriptBaseline ? "existing-viewer-baseline" : null,
    updatedAt: createdAt,
  };
  writeJsonAtomic(paths.baseStory, baseStory);
  writeJsonAtomic(paths.cn, cn);
  writeJsonAtomic(paths.script, script);
  writeJsonAtomic(paths.speakers, {
    schemaVersion,
    sourceDigest: storyDigest(baseStory),
    scannedAt: null,
    items: [],
    digest: null,
  });
  writeJsonAtomic(paths.references, {
    schemaVersion,
    selections: {},
    preparedAt: null,
    digest: jsonDigest({}),
  });
  const state = {
    schemaVersion,
    createdAt,
    updatedAt: createdAt,
    base: {
      digest: storyDigest(baseStory),
      structuralDigest: structuralDigest(baseStory),
      rows: baseStory.content.length,
      ...metadata,
    },
    cn: { generation: 0 },
    voice: { speakerScan: 0, scriptGeneration: 0 },
  };
  writeState(paths, state);
  return getProduction(identityOrId, { includeStory: false });
}

export function hasProduction(identityOrId) {
  return fs.existsSync(pathsFor(identityOrId).state);
}

export function getProduction(identityOrId, { includeStory = true, includeHistory = true } = {}) {
  const paths = ensureProduction(identityOrId);
  const state = readState(paths);
  const baseStory = readJson(paths.baseStory);
  const cn = readJson(paths.cn);
  const script = readJson(paths.script);
  const speakers = readJson(paths.speakers);
  const speakerStoryIndices = new Map();
  baseStory.content.forEach((unit, index) => {
    const speaker = parseScenarioScriptSpeakers(unit).dialogueSpeaker;
    if (!speaker) return;
    const indices = speakerStoryIndices.get(speaker) ?? [];
    indices.push(index);
    speakerStoryIndices.set(speaker, indices);
  });
  const speakerItems = speakers.items.map(item => ({
    ...item,
    storyIndices: Number.isSafeInteger(item.storyIndex)
      ? [item.storyIndex]
      : [...(speakerStoryIndices.get(item.sourceSpeaker) ?? [])],
  }));
  const references = readJson(paths.references);
  const effectiveSkippedIndices = resolveTtsSkippedIndices(
    { ...baseStory, content: baseStory.content.map((unit, index) => ({
      ...unit,
      TextJpVoice: script.rows[index]?.text ?? unit.TextJpVoice,
    })) },
    script,
  );
  const unresolvedSpeakers = speakerItems.filter(item => item.requiresHuman && !item.resolution);
  const assemblyManifest = readJson(paths.assemblyManifest, null);
  const currentInputs = {
    base: state.base.digest,
    cn: cn.digest,
    speakers: speakers.digest,
    references: references.digest,
    script: script.digest,
    skipped: jsonDigest(effectiveSkippedIndices),
  };
  const preview = readJson(paths.preview, null);
  const branchDecisions = readJson(paths.branchDecisions, {
    defaultSelectionGroups: {}, checkedSelectionKeys: [], updatedAt: null,
  });
  const ttsManifest = readJson(paths.ttsManifest, null);
  const ttsState = readJson(paths.ttsState, null);
  const ttsOutputStory = readJson(paths.ttsOutputStory, null);
  const ttsTasks = Object.values(ttsManifest?.tasks ?? {});
  const ttsCompleted = ttsTasks.filter(task => String(task?.status).toUpperCase() === "COMPLETED").length;
  const ttsInputs = {
    speakers: speakers.digest,
    references: references.digest,
    script: script.digest,
    skipped: jsonDigest(effectiveSkippedIndices),
  };
  const ttsCurrent = Boolean(ttsState && Object.entries(ttsInputs)
    .every(([key, digest]) => ttsState.inputs?.[key] === digest));
  currentInputs.voice = ttsCurrent ? ttsState.storyDigest : null;
  const assemblyCurrent = Boolean(
    assemblyManifest &&
    Object.entries(currentInputs).every(([key, digest]) => assemblyManifest.inputs?.[key] === digest),
  );
  const assemblyStory = assemblyCurrent ? readJson(paths.assemblyStory) : null;
  const inspection = assemblyStory ? inspectAssembly(assemblyStory) : { errors: [], choices: [] };
  const publicPath = publicStoryPath(paths.workspace.identity);
  const publicStory = readJson(publicPath, null);
  const recording = readJson(paths.recording, null);
  const eventIndex = readJson(paths.eventIndex, null);
  const recordingCurrent = Boolean(
    recording?.assemblyDigest === assemblyManifest?.storyDigest &&
    recording?.branchDigest === jsonDigest(branchDecisions) &&
    recording?.validation?.ffprobe === true &&
    recording?.validation?.fullDecode === true &&
    recording?.output && fs.existsSync(recording.output),
  );
  const result = {
    state,
    paths: {
      root: paths.root,
      baseStory: paths.baseStory,
      assemblyStory: paths.assemblyStory,
    },
    base: state.base,
    cn: {
      ...cn,
      ready: Boolean(cn.approvedAt),
      generationCount: Number(state.cn?.generation ?? 0),
      editCount: listRecords(paths.cnEdits).length,
    },
    voice: {
      speakers: {
        ...speakers,
        items: speakerItems,
        ready: Boolean(speakers.scannedAt && unresolvedSpeakers.length === 0),
        unresolvedCount: unresolvedSpeakers.length,
      },
      references: {
        ...references,
        ready: Boolean(references.preparedAt),
        editCount: listRecords(paths.referenceEdits).length,
      },
      script: {
        ...script,
        ready: Boolean(script.approvedAt),
        generationCount: Number(state.voice?.scriptGeneration ?? 0),
        editCount: listRecords(paths.scriptEdits).length,
        effectiveSkippedIndices,
      },
      tts: {
        exists: Boolean(ttsManifest || ttsState),
        completed: ttsCompleted,
        total: ttsTasks.length,
        current: ttsCurrent,
        voiceStoryReady: Boolean(ttsOutputStory && ttsCurrent),
        manifestPath: paths.ttsManifest,
      },
    },
    assembly: {
      exists: Boolean(assemblyManifest && fs.existsSync(paths.assemblyStory)),
      current: assemblyCurrent,
      manifest: assemblyManifest,
      inspection,
    },
    preview: {
      complete: Boolean(preview?.completedAt && assemblyCurrent &&
        preview.assemblyDigest === assemblyManifest?.storyDigest &&
        preview.branchDigest === jsonDigest(branchDecisions)),
      ...preview,
      branches: branchDecisions,
    },
    publicArtifact: {
      path: publicPath,
      current: Boolean(publicStory && assemblyCurrent && storyDigest(publicStory) === assemblyManifest?.storyDigest),
    },
    recording: { ...recording, current: recordingCurrent },
    eventIndex: {
      ...eventIndex,
      current: Boolean(eventIndex?.assemblyDigest === assemblyManifest?.storyDigest &&
        publicStory && storyDigest(publicStory) === assemblyManifest?.storyDigest),
    },
  };
  if (includeHistory) {
    result.cn.llmRuns = listRecords(paths.cnRuns).map(({ rows, ...run }) => ({
      ...run,
      rowCount: Array.isArray(rows) ? rows.length : state.base.rows,
    }));
    result.cn.edits = listRecords(paths.cnEdits);
    result.voice.speakers.edits = listRecords(paths.speakerEdits);
    result.voice.references.edits = listRecords(paths.referenceEdits);
    result.voice.script.llmRuns = listRecords(paths.scriptRuns).map(({ rows, ...run }) => ({
      ...run,
      rowCount: Array.isArray(rows) ? rows.length : state.base.rows,
    }));
    result.voice.script.edits = listRecords(paths.scriptEdits);
  }
  if (includeStory) {
    result.story = baseStory.content.map((unit, index) => ({
      index,
      ScriptKr: String(unit.ScriptKr ?? ""),
      TextJp: String(unit.TextJp ?? ""),
      TextTw: String(unit.TextTw ?? ""),
      TextCn: cn.rows[index]?.text ?? "",
      TextJpVoice: script.rows[index]?.text ?? "",
      VoiceJp: String(unit.VoiceJp ?? ""),
    }));
  }
  return result;
}

export function recordCnGeneration(identityOrId, story, result, options = {}) {
  const paths = ensureProduction(identityOrId);
  const state = readState(paths);
  const baseStory = readJson(paths.baseStory);
  if (structuralDigest(story) !== state.base.structuralDigest) {
    throw new Error("CN generation changed the base story structure");
  }
  const previous = readJson(paths.cn);
  const rows = textRows(story, "TextCn");
  const generatedAt = nowIso();
  const run = {
    schemaVersion,
    generatedAt,
    model: options.model ?? result.model ?? "",
    guidance: String(options.guidance ?? ""),
    beforeDigest: previous.digest,
    afterDigest: scriptDigest(rows),
    rows,
    result,
  };
  const runId = appendRecord(paths.cnRuns, "run-", run);
  writeJsonAtomic(paths.cn, {
    ...previous,
    rows,
    digest: run.afterDigest,
    approvedAt: null,
    approvedDigest: null,
    approvalSource: null,
    lastRunId: runId,
    updatedAt: generatedAt,
  });
  writeState(paths, {
    ...state,
    cn: { ...state.cn, generation: Number(state.cn?.generation ?? 0) + 1 },
  });
  return getProduction(identityOrId, { includeStory: false });
}

export function getCnRun(identityOrId, runId) {
  const paths = ensureProduction(identityOrId);
  const run = findRecord(paths.cnRuns, runId, "CN generation run");
  return { ...run, rows: cnRowsForRun(paths, run) };
}

export function approveCn(identityOrId, runId = "", note = "") {
  const paths = ensureProduction(identityOrId);
  const current = readJson(paths.cn);
  if (!current.lastRunId) throw new Error("Run the two-pass CN generation before approval");
  const selected = getCnRun(identityOrId, runId || current.lastRunId);
  const approvedAt = nowIso();
  writeJsonAtomic(paths.cn, {
    ...current,
    rows: selected.rows,
    digest: selected.afterDigest,
    lastRunId: selected.id,
    selectedRunId: selected.id,
    approvedRunId: selected.id,
    approvedAt,
    approvedDigest: selected.afterDigest,
    approvalSource: "llm-run",
    approvalNote: String(note ?? "").trim(),
    updatedAt: approvedAt,
  });
  return getProduction(identityOrId, { includeStory: false });
}

export function revokeCnApproval(identityOrId) {
  const paths = ensureProduction(identityOrId);
  const current = readJson(paths.cn);
  if (!current.approvedAt) throw new Error("The CN candidate has not been approved");
  const selected = getCnRun(
    identityOrId,
    current.approvedRunId || current.selectedRunId || current.lastRunId,
  );
  const editFiles = fs.existsSync(paths.cnEdits)
    ? fs.readdirSync(paths.cnEdits).filter(name => name.endsWith(".json"))
    : [];
  for (const name of editFiles) fs.unlinkSync(path.join(paths.cnEdits, name));
  const revokedAt = nowIso();
  writeJsonAtomic(paths.cn, {
    ...current,
    rows: selected.rows,
    digest: selected.afterDigest,
    lastRunId: selected.id,
    selectedRunId: selected.id,
    approvedRunId: null,
    approvedAt: null,
    approvedDigest: null,
    approvalSource: null,
    approvalNote: "",
    lastEditId: null,
    approvalRevokedAt: revokedAt,
    revokedApprovedRunId: selected.id,
    clearedEditCount: editFiles.length,
    updatedAt: revokedAt,
  });
  return getProduction(identityOrId, { includeStory: false });
}

export function editCn(identityOrId, changes, note) {
  const paths = ensureProduction(identityOrId);
  const baseStory = readJson(paths.baseStory);
  const normalized = validateRows(baseStory, changes, "CN edit");
  const reason = String(note ?? "").trim();
  if (!reason) throw new Error("A CN edit note is required");
  const current = readJson(paths.cn);
  if (!current.approvedAt) throw new Error("Approve the overall CN result before fine-tuning");
  const rows = structuredClone(current.rows);
  const edits = [];
  for (const change of normalized) {
    const before = String(rows[change.index]?.text ?? "");
    if (before === change.text) continue;
    rows[change.index] = { index: change.index, text: change.text };
    edits.push({ index: change.index, before, after: change.text });
  }
  if (!edits.length) throw new Error("The CN edit does not change any text");
  const editedAt = nowIso();
  const editId = appendRecord(paths.cnEdits, "edit-", {
    schemaVersion,
    editedAt,
    note: reason,
    beforeDigest: current.digest,
    afterDigest: trackDigest(rows),
    changes: edits,
  });
  writeJsonAtomic(paths.cn, {
    ...current,
    rows,
    digest: trackDigest(rows),
    lastEditId: editId,
    updatedAt: editedAt,
  });
  return getProduction(identityOrId, { includeStory: false });
}

export function recordVoiceScriptGeneration(identityOrId, story, result, options = {}) {
  const paths = ensureProduction(identityOrId);
  const state = readState(paths);
  const baseStory = readJson(paths.baseStory);
  if (structuralDigest(story) !== state.base.structuralDigest) {
    throw new Error("Voice-script generation changed the base story structure");
  }
  const previous = readJson(paths.script);
  const rows = textRows(story, "TextJpVoice");
  const generatedAt = nowIso();
  const run = {
    schemaVersion,
    generatedAt,
    model: String(options.model ?? ""),
    guidance: String(options.guidance ?? ""),
    beforeDigest: previous.digest,
    afterDigest: trackDigest(rows),
    rows,
    result,
  };
  const runId = appendRecord(paths.scriptRuns, "run-", run);
  writeJsonAtomic(paths.script, {
    ...previous,
    rows,
    ttsSkippedIndices: [],
    ttsForcedIndices: [],
    digest: run.afterDigest,
    approvedAt: null,
    approvedDigest: null,
    approvalSource: null,
    lastRunId: runId,
    updatedAt: generatedAt,
  });
  writeState(paths, {
    ...state,
    voice: {
      ...state.voice,
      scriptGeneration: Number(state.voice?.scriptGeneration ?? 0) + 1,
    },
  });
  return getProduction(identityOrId, { includeStory: false });
}

export function approveVoiceScript(identityOrId, runId = "", note = "") {
  const paths = ensureProduction(identityOrId);
  const current = readJson(paths.script);
  if (!current.lastRunId) throw new Error("Generate the voice script before approval");
  const selected = getVoiceScriptRun(identityOrId, runId || current.lastRunId);
  const approvedAt = nowIso();
  writeJsonAtomic(paths.script, {
    ...current,
    rows: selected.rows,
    ttsSkippedIndices: [],
    ttsForcedIndices: [],
    digest: selected.afterDigest,
    lastRunId: selected.id,
    selectedRunId: selected.id,
    approvedRunId: selected.id,
    approvedAt,
    approvedDigest: selected.afterDigest,
    approvalSource: "llm-run",
    approvalNote: String(note ?? "").trim(),
    updatedAt: approvedAt,
  });
  return getProduction(identityOrId, { includeStory: false });
}

export function getVoiceScriptRun(identityOrId, runId) {
  const paths = ensureProduction(identityOrId);
  const run = findRecord(paths.scriptRuns, runId, "Voice-script generation run");
  return { ...run, rows: voiceScriptRowsForRun(paths, run) };
}

export function revokeVoiceScriptApproval(identityOrId) {
  const paths = ensureProduction(identityOrId);
  const current = readJson(paths.script);
  if (!current.approvedAt) throw new Error("The voice-script candidate has not been approved");
  const selected = getVoiceScriptRun(
    identityOrId,
    current.approvedRunId || current.selectedRunId || current.lastRunId,
  );
  const editFiles = fs.existsSync(paths.scriptEdits)
    ? fs.readdirSync(paths.scriptEdits).filter(name => name.endsWith(".json"))
    : [];
  for (const name of editFiles) fs.unlinkSync(path.join(paths.scriptEdits, name));
  const revokedAt = nowIso();
  writeJsonAtomic(paths.script, {
    ...current,
    rows: selected.rows,
    ttsSkippedIndices: [],
    ttsForcedIndices: [],
    digest: selected.afterDigest,
    lastRunId: selected.id,
    selectedRunId: selected.id,
    approvedRunId: null,
    approvedAt: null,
    approvedDigest: null,
    approvalSource: null,
    approvalNote: "",
    lastEditId: null,
    approvalRevokedAt: revokedAt,
    revokedApprovedRunId: selected.id,
    clearedEditCount: editFiles.length,
    updatedAt: revokedAt,
  });
  return getProduction(identityOrId, { includeStory: false });
}

export function editVoiceScript(identityOrId, changes, note) {
  const paths = ensureProduction(identityOrId);
  const baseStory = readJson(paths.baseStory);
  const normalized = validateRows(baseStory, changes, "voice-script edit");
  const reason = String(note ?? "").trim();
  if (!reason) throw new Error("A voice-script edit note is required");
  const current = readJson(paths.script);
  if (!current.approvedAt) throw new Error("Approve the overall voice script before fine-tuning");
  const rows = structuredClone(current.rows);
  const edits = [];
  for (const change of normalized) {
    const before = String(rows[change.index]?.text ?? "");
    if (before === change.text) continue;
    rows[change.index] = { index: change.index, text: change.text };
    edits.push({ index: change.index, before, after: change.text });
  }
  if (!edits.length) throw new Error("The voice-script edit does not change any text");
  const editedAt = nowIso();
  const digest = scriptDigest(
    rows,
    current.ttsSkippedIndices,
    current.ttsForcedIndices,
  );
  const editId = appendRecord(paths.scriptEdits, "edit-", {
    schemaVersion,
    editedAt,
    note: reason,
    beforeDigest: current.digest,
    afterDigest: digest,
    changes: edits,
  });
  writeJsonAtomic(paths.script, {
    ...current,
    rows,
    digest,
    lastEditId: editId,
    updatedAt: editedAt,
  });
  return getProduction(identityOrId, { includeStory: false });
}

export function setVoiceScriptSkip(identityOrId, indexValue, skipped, note = "") {
  const paths = ensureProduction(identityOrId);
  const baseStory = readJson(paths.baseStory);
  const current = readJson(paths.script);
  if (!current.approvedAt) throw new Error("Approve the overall voice script before fine-tuning");
  const index = Number(indexValue);
  if (!Number.isSafeInteger(index) || index < 0 || !baseStory.content[index]) {
    throw new Error("A valid voice-script index is required");
  }
  const story = {
    ...baseStory,
    content: baseStory.content.map((unit, rowIndex) => ({
      ...unit,
      TextJpVoice: current.rows[rowIndex]?.text ?? unit.TextJpVoice,
    })),
  };
  const decision = applyTtsSkipDecision(story, current, index, Boolean(skipped));
  const next = {
    ...current,
    ttsSkippedIndices: decision.ttsSkippedIndices,
    ttsForcedIndices: decision.ttsForcedIndices,
  };
  next.digest = scriptDigest(
    next.rows,
    next.ttsSkippedIndices,
    next.ttsForcedIndices,
  );
  const editedAt = nowIso();
  const editId = appendRecord(paths.scriptEdits, "edit-", {
    schemaVersion,
    editedAt,
    note: String(note ?? "").trim() || (skipped ? "标记为无语音" : "恢复 TTS"),
    beforeDigest: current.digest,
    afterDigest: next.digest,
    skipDecision: { index, skipped: Boolean(skipped) },
  });
  writeJsonAtomic(paths.script, { ...next, lastEditId: editId, updatedAt: editedAt });
  return getProduction(identityOrId, { includeStory: false });
}

export function recordSpeakerScan(identityOrId, items, metadata = {}) {
  const paths = ensureProduction(identityOrId);
  const state = readState(paths);
  const scannedAt = nowIso();
  const normalizedItems = (items ?? []).map(item => ({ ...item }));
  const artifact = {
    schemaVersion,
    sourceDigest: state.base.digest,
    scannedAt,
    items: normalizedItems,
    digest: jsonDigest(normalizedItems),
    ...metadata,
  };
  writeJsonAtomic(paths.speakers, artifact);
  writeState(paths, {
    ...state,
    voice: { ...state.voice, speakerScan: Number(state.voice?.speakerScan ?? 0) + 1 },
  });
  return getProduction(identityOrId, { includeStory: false });
}

export function updateSpeakerResolution(identityOrId, stableKey, resolution, note = "") {
  const paths = ensureProduction(identityOrId);
  const current = readJson(paths.speakers);
  const index = current.items.findIndex(item => item.stableKey === stableKey);
  if (index < 0) throw new Error(`Unknown speaker key: ${stableKey}`);
  const item = current.items[index];
  const type = String(resolution?.type ?? "");
  let normalizedResolution;
  if (type === "npc") {
    normalizedResolution = { type: "npc", preset: "anonymous-npc-v4" };
  } else if (item.reason === "collective-speaker") {
    const members = [...new Set((resolution?.members ?? []).map(String)
      .map(value => value.trim()).filter(Boolean))];
    if (type !== "collective" || members.length < 2) {
      throw new Error("A collective speaker requires at least two stable Korean member keys");
    }
    normalizedResolution = { type, members };
  } else if (type === "character") {
    const resolvedKey = String(resolution?.stableKey ?? "").trim();
    const characterName = String(resolution?.characterName ?? "").trim();
    if (!resolvedKey || !characterName) {
      throw new Error("A character resolution requires both the Korean stable key and Chinese name");
    }
    normalizedResolution = { type, stableKey: resolvedKey, characterName };
  } else {
    throw new Error("Speaker resolution must be character, npc, or collective");
  }
  const before = item.resolution ?? null;
  const items = structuredClone(current.items);
  items[index].resolution = normalizedResolution;
  items[index].resolvedAt = nowIso();
  const digest = jsonDigest(items);
  appendRecord(paths.speakerEdits, "edit-", {
    schemaVersion,
    editedAt: nowIso(),
    stableKey,
    before,
    after: normalizedResolution,
    note: String(note ?? "").trim(),
    beforeDigest: current.digest,
    afterDigest: digest,
  });
  writeJsonAtomic(paths.speakers, { ...current, items, digest, updatedAt: nowIso() });
  return getProduction(identityOrId, { includeStory: false });
}

export function writeReferenceArtifact(identityOrId, selections, metadata = {}) {
  const paths = ensureProduction(identityOrId);
  const current = readJson(paths.references);
  const normalized = Object.fromEntries(Object.entries(selections ?? {})
    .map(([speaker, clips]) => [speaker, [...new Set((clips ?? []).map(String))].sort()])
    .sort(([left], [right]) => left.localeCompare(right)));
  const digest = jsonDigest(normalized);
  const preparedAt = nowIso();
  if (current.digest !== digest) {
    appendRecord(paths.referenceEdits, "edit-", {
      schemaVersion,
      editedAt: preparedAt,
      before: current.selections,
      after: normalized,
      beforeDigest: current.digest,
      afterDigest: digest,
      note: String(metadata.note ?? "").trim() || "更新参考音选择",
    });
  }
  writeJsonAtomic(paths.references, {
    schemaVersion,
    selections: normalized,
    preparedAt,
    digest,
    ...metadata,
  });
  return getProduction(identityOrId, { includeStory: false });
}

export function buildProductionStory(identityOrId) {
  const paths = ensureProduction(identityOrId);
  const production = getProduction(identityOrId, { includeStory: false, includeHistory: false });
  if (!production.cn.ready) throw new Error("Approve the overall CN result first");
  if (!production.voice.script.ready) throw new Error("Approve the overall voice script first");
  if (!production.voice.tts.voiceStoryReady) throw new Error("Generate and upload the current voice track first");
  const story = structuredClone(readJson(paths.baseStory));
  const cn = readJson(paths.cn);
  const script = readJson(paths.script);
  mergeRowsIntoStory(story, cn.rows, "TextCn");
  mergeRowsIntoStory(story, script.rows, "TextJpVoice");
  const voiceStory = readJson(paths.ttsOutputStory);
  story.content.forEach((unit, index) => {
    unit.VoiceJp = String(voiceStory.content?.[index]?.VoiceJp ?? "");
  });
  const skipped = new Set(production.voice.script.effectiveSkippedIndices);
  story.content.forEach((unit, index) => {
    if (skipped.has(index)) unit.VoiceJp = "";
  });
  const inputs = {
    base: production.base.digest,
    cn: production.cn.digest,
    speakers: production.voice.speakers.digest,
    references: production.voice.references.digest,
    script: production.voice.script.digest,
    skipped: jsonDigest(production.voice.script.effectiveSkippedIndices),
    voice: readJson(paths.ttsState).storyDigest,
  };
  fs.mkdirSync(paths.assemblyRoot, { recursive: true });
  writeJsonAtomic(paths.assemblyStory, story);
  writeJsonAtomic(paths.assemblyManifest, {
    schemaVersion,
    assembledAt: nowIso(),
    inputs,
    storyDigest: storyDigest(story),
    rows: story.content.length,
  });
  return getProduction(identityOrId, { includeStory: false });
}

export function productionInputStory(identityOrId, { includeCn = true, includeScript = true } = {}) {
  const paths = ensureProduction(identityOrId);
  const story = structuredClone(readJson(paths.baseStory));
  if (includeCn) mergeRowsIntoStory(story, readJson(paths.cn).rows, "TextCn");
  if (includeScript) mergeRowsIntoStory(story, readJson(paths.script).rows, "TextJpVoice");
  return story;
}

export function updateProductionBranches(identityOrId, patch = {}) {
  const paths = ensureProduction(identityOrId);
  const production = getProduction(identityOrId, { includeStory: false, includeHistory: false });
  if (!production.assembly.current) throw new Error("Assemble the latest production tracks first");
  const existing = readJson(paths.branchDecisions, {
    defaultSelectionGroups: {}, checkedSelectionKeys: [],
  });
  const next = {
    schemaVersion,
    defaultSelectionGroups: {
      ...existing.defaultSelectionGroups,
      ...(patch.defaultSelectionGroups ?? {}),
    },
    checkedSelectionKeys: patch.checkedSelectionKeys === undefined
      ? existing.checkedSelectionKeys
      : [...new Set(patch.checkedSelectionKeys.map(String))].sort(),
    updatedAt: nowIso(),
  };
  writeJsonAtomic(paths.branchDecisions, next);
  appendRecord(paths.branchEdits, "branch-edit-", {
    editedAt: nowIso(),
    note: String(patch.note || "最终预览中调整分支确认或录制默认选项"),
    before: existing,
    after: next,
  });
  return getProduction(identityOrId, { includeStory: false });
}

export function validateProductionPreviewBranches(identityOrId) {
  const production = getProduction(identityOrId, { includeStory: false, includeHistory: false });
  if (!production.assembly.current) throw new Error("Assemble the latest production tracks first");
  if (production.assembly.inspection.errors.length) {
    throw new Error(`Story structure errors: ${production.assembly.inspection.errors.join("; ")}`);
  }
  const branches = production.preview.branches;
  const requiredKeys = production.assembly.inspection.choices.flatMap(choice =>
    choice.options.filter(option => option.selectionGroup > 0).map(option => option.key));
  const missingChecks = requiredKeys.filter(key => !branches.checkedSelectionKeys.includes(key));
  if (missingChecks.length) throw new Error(`Unchecked choice branches: ${missingChecks.join(", ")}`);
  const missingDefaults = production.assembly.inspection.choices.filter(choice =>
    choice.options.some(option => option.selectionGroup > 0) &&
    !choice.options.some(option => option.selectionGroup > 0 &&
      option.selectionGroup === Number(branches.defaultSelectionGroups[choice.index])));
  if (missingDefaults.length) {
    throw new Error(`Choice pages without a recording default: ${missingDefaults.map(item => item.index).join(", ")}`);
  }
  return production;
}

export function completeProductionPreview(identityOrId) {
  const paths = ensureProduction(identityOrId);
  const production = validateProductionPreviewBranches(identityOrId);
  if (!production.recording.current) {
    throw new Error("Generate and validate the current preview video first");
  }
  const branches = production.preview.branches;
  writeJsonAtomic(paths.preview, {
    schemaVersion,
    completedAt: nowIso(),
    assemblyDigest: production.assembly.manifest.storyDigest,
    branchDigest: jsonDigest(branches),
    checkedSelectionKeys: branches.checkedSelectionKeys,
    defaultSelectionGroups: branches.defaultSelectionGroups,
  });
  return getProduction(identityOrId, { includeStory: false });
}

export function materializeProductionStory(identityOrId) {
  const paths = ensureProduction(identityOrId);
  const production = getProduction(identityOrId, { includeStory: false, includeHistory: false });
  if (!production.preview.complete) throw new Error("Confirm the current preview video and branch checks first");
  const story = readJson(paths.assemblyStory);
  const destination = publicStoryPath(paths.workspace.identity);
  writeJsonAtomic(destination, story);
  return getProduction(identityOrId, { includeStory: false });
}
