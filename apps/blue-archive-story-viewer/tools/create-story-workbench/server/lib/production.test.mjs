import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  approveCn,
  approveVoiceScript,
  completeProductionPreview,
  editCn,
  editVoiceScript,
  getCnRun,
  getVoiceScriptRun,
  getProduction,
  initializeProduction,
  inspectAssembly,
  recordCnGeneration,
  recordSpeakerScan,
  recordVoiceScriptGeneration,
  revokeCnApproval,
  revokeVoiceScriptApproval,
  setVoiceScriptSkip,
  updateSpeakerResolution,
  writeReferenceArtifact,
} from "./production.mjs";
import { jsonDigest, storyDigest, workspaceDirectory } from "./utils.mjs";
import { ensureWorkspace } from "./workspaces.mjs";

const identity = { type: "other", storyId: "999999999902" };
const candidateIdentity = { type: "other", storyId: "999999999903" };
const voiceCandidateIdentity = { type: "other", storyId: "999999999904" };
const videoPreviewIdentity = { type: "other", storyId: "999999999905" };
const baselineIdentity = { type: "other", storyId: "999999999906" };
const npcIdentity = { type: "other", storyId: "999999999907" };

function story() {
  return {
    GroupId: 999999999902,
    content: [
      { GroupId: 999999999902, ScriptKr: "1;테스트;00;대사", TextJp: "台詞。", TextTw: "台詞。", TextCn: "台词。", TextJpVoice: "台詞。", VoiceJp: "" },
      { GroupId: 999999999902, ScriptKr: "1;테스트;00;침묵", TextJp: "……", TextTw: "……", TextCn: "……", TextJpVoice: "……", VoiceJp: "" },
    ],
  };
}

test("assembly inspection recognizes ns-tagged recording choices", () => {
  const inspection = inspectAssembly({
    content: [
      {
        ScriptKr: '[ns3] "첫 번째"\n[ns4] "두 번째"',
        TextJp: '[ns3] "一つ目"\n[ns4] "二つ目"',
        TextCn: '[ns3]「第一个」\n[ns4]「第二个」',
      },
      { ScriptKr: "1;test;00;response", SelectionGroup: 3 },
      { ScriptKr: "1;test;00;response", SelectionGroup: 4 },
    ],
  });
  assert.deepEqual(inspection.errors, []);
  assert.deepEqual(inspection.choices[0], {
    index: 0,
    options: [
      {
        selectionGroup: 3,
        text: '"첫 번째"',
        textCn: "「第一个」",
        textJp: '"一つ目"',
        responseIndex: 1,
        key: "0:3",
      },
      {
        selectionGroup: 4,
        text: '"두 번째"',
        textCn: "「第二个」",
        textJp: '"二つ目"',
        responseIndex: 2,
        key: "0:4",
      },
    ],
  });
});

test("keeps CN, speaker/reference, and voice-script artifacts independently editable", () => {
  const root = workspaceDirectory(identity);
  fs.rmSync(root, { recursive: true, force: true });
  try {
    const workspace = ensureWorkspace(identity);
    const base = story();
    initializeProduction(workspace.id, base, { source: "test" });

    const cnStory = structuredClone(base);
    cnStory.content[0].TextCn = "人工智能候选字幕。";
    recordCnGeneration(workspace.id, cnStory, { model: "test", changes: [] });
    approveCn(workspace.id);

    const voiceStory = structuredClone(base);
    voiceStory.content[0].TextJpVoice = "[gentle]台詞。";
    recordVoiceScriptGeneration(workspace.id, voiceStory, { changes: [] });
    approveVoiceScript(workspace.id);
    recordSpeakerScan(workspace.id, [{
      stableKey: "테스트",
      sourceSpeaker: "테스트",
      available: true,
      requiresHuman: false,
      resolution: { type: "character", stableKey: "테스트", characterName: "测试" },
    }]);
    writeReferenceArtifact(workspace.id, { 테스트: ["clip-1"] });

    const before = getProduction(workspace.id);
    assert.deepEqual(before.voice.speakers.items[0].storyIndices, [0, 1]);
    editCn(workspace.id, [{ index: 0, text: "人工最终字幕。" }], "录制微调");
    const afterCn = getProduction(workspace.id);
    assert.notEqual(afterCn.cn.digest, before.cn.digest);
    assert.equal(afterCn.voice.script.digest, before.voice.script.digest);

    editVoiceScript(workspace.id, [{ index: 0, text: "[calm]台詞。" }], "表演微调");
    const afterScript = getProduction(workspace.id);
    assert.equal(afterScript.cn.digest, afterCn.cn.digest);
    assert.notEqual(afterScript.voice.script.digest, afterCn.voice.script.digest);
    assert.deepEqual(afterScript.voice.script.effectiveSkippedIndices, [1]);

    setVoiceScriptSkip(workspace.id, 1, false, "保留停顿语气");
    assert.deepEqual(getProduction(workspace.id).voice.script.effectiveSkippedIndices, []);
    assert.equal(getProduction(workspace.id).voice.speakers.ready, true);
    assert.equal(getProduction(workspace.id).voice.references.ready, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("allows every unresolved speaker exception to use the default NPC preset", () => {
  const root = workspaceDirectory(npcIdentity);
  fs.rmSync(root, { recursive: true, force: true });
  try {
    const workspace = ensureWorkspace(npcIdentity);
    initializeProduction(workspace.id, story(), { source: "test" });
    recordSpeakerScan(workspace.id, [{
      stableKey: "여럿",
      sourceSpeaker: "众人",
      requiresHuman: true,
      reason: "collective-speaker",
      resolution: null,
    }]);
    updateSpeakerResolution(workspace.id, "여럿", { type: "npc" }, "默认 NPC");
    const speaker = getProduction(workspace.id).voice.speakers.items[0];
    assert.deepEqual(speaker.resolution, { type: "npc", preset: "anonymous-npc-v4" });
    assert.equal(getProduction(workspace.id).voice.speakers.ready, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("keeps complete CN candidates switchable and approves the selected run", () => {
  const root = workspaceDirectory(candidateIdentity);
  fs.rmSync(root, { recursive: true, force: true });
  try {
    const workspace = ensureWorkspace(candidateIdentity);
    const base = story();
    initializeProduction(workspace.id, base, { source: "test" });

    const first = structuredClone(base);
    first.content[0].TextCn = "候选方案甲。";
    recordCnGeneration(workspace.id, first, {
      model: "model-a",
      netChanges: [{ index: 0, before: "台词。", after: "候选方案甲。" }],
      changes: [],
    });
    const firstRunId = getProduction(workspace.id).cn.llmRuns[0].id;

    // Legacy runs did not contain full rows; they remain exactly reconstructable from netChanges.
    const firstRunPath = path.join(
      getProduction(workspace.id).paths.root,
      "tracks", "cn", "llm-runs", `${firstRunId}.json`,
    );
    const legacyRun = JSON.parse(fs.readFileSync(firstRunPath, "utf8"));
    delete legacyRun.rows;
    fs.writeFileSync(firstRunPath, `${JSON.stringify(legacyRun, null, 2)}\n`);
    assert.equal(getCnRun(workspace.id, firstRunId).rows[0].text, "候选方案甲。");

    const second = structuredClone(base);
    second.content[0].TextCn = "候选方案乙。";
    recordCnGeneration(workspace.id, second, {
      model: "model-b",
      netChanges: [{ index: 0, before: "台词。", after: "候选方案乙。" }],
      changes: [],
    });
    assert.equal(getProduction(workspace.id).cn.llmRuns.length, 2);

    approveCn(workspace.id, firstRunId);
    const approved = getProduction(workspace.id);
    assert.equal(approved.cn.approvedRunId, firstRunId);
    assert.equal(approved.cn.lastRunId, firstRunId);
    assert.equal(approved.story[0].TextCn, "候选方案甲。");

    editCn(workspace.id, [{ index: 1, text: "人工微调内容。" }], "测试微调");
    assert.equal(getProduction(workspace.id).cn.editCount, 1);
    revokeCnApproval(workspace.id);
    const revoked = getProduction(workspace.id);
    assert.equal(revoked.cn.ready, false);
    assert.equal(revoked.cn.editCount, 0);
    assert.equal(revoked.story[0].TextCn, "候选方案甲。");
    assert.equal(revoked.story[1].TextCn, "……");

    const secondRunId = revoked.cn.llmRuns[1].id;
    approveCn(workspace.id, secondRunId);
    const reapproved = getProduction(workspace.id);
    assert.equal(reapproved.cn.approvedRunId, secondRunId);
    assert.equal(reapproved.story[0].TextCn, "候选方案乙。");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("keeps complete voice-script candidates switchable and clears fine-tuning when approval is revoked", () => {
  const root = workspaceDirectory(voiceCandidateIdentity);
  fs.rmSync(root, { recursive: true, force: true });
  try {
    const workspace = ensureWorkspace(voiceCandidateIdentity);
    const base = story();
    initializeProduction(workspace.id, base, { source: "test" });

    const first = structuredClone(base);
    first.content[0].TextJpVoice = "[gentle]台詞。";
    recordVoiceScriptGeneration(workspace.id, first, {
      changes: [{ index: 0, before: "台詞。", after: "[gentle]台詞。" }],
    }, { model: "voice-model-a" });
    const firstRunId = getProduction(workspace.id).voice.script.llmRuns[0].id;

    // Older voice runs only stored their changes; keep them selectable as well.
    const firstRunPath = path.join(
      getProduction(workspace.id).paths.root,
      "tracks", "voice", "script-runs", `${firstRunId}.json`,
    );
    const legacyRun = JSON.parse(fs.readFileSync(firstRunPath, "utf8"));
    delete legacyRun.rows;
    fs.writeFileSync(firstRunPath, `${JSON.stringify(legacyRun, null, 2)}\n`);
    assert.equal(getVoiceScriptRun(workspace.id, firstRunId).rows[0].text, "[gentle]台詞。");

    const second = structuredClone(base);
    second.content[0].TextJpVoice = "[excited]台詞！";
    recordVoiceScriptGeneration(workspace.id, second, {
      changes: [{ index: 0, before: "台詞。", after: "[excited]台詞！" }],
    }, { model: "voice-model-b" });
    const generated = getProduction(workspace.id);
    const secondRunId = generated.voice.script.llmRuns[1].id;
    assert.equal(generated.voice.script.llmRuns.length, 2);

    approveVoiceScript(workspace.id, firstRunId);
    assert.equal(getProduction(workspace.id).story[0].TextJpVoice, "[gentle]台詞。");
    editVoiceScript(workspace.id, [{ index: 0, text: "[calm]台詞。" }], "manual tune");
    setVoiceScriptSkip(workspace.id, 1, false, "keep the pause");
    assert.equal(getProduction(workspace.id).voice.script.editCount, 2);

    revokeVoiceScriptApproval(workspace.id);
    const revoked = getProduction(workspace.id);
    assert.equal(revoked.voice.script.ready, false);
    assert.equal(revoked.voice.script.editCount, 0);
    assert.deepEqual(revoked.voice.script.ttsForcedIndices, []);
    assert.equal(revoked.story[0].TextJpVoice, "[gentle]台詞。");

    approveVoiceScript(workspace.id, secondRunId);
    const reapproved = getProduction(workspace.id);
    assert.equal(reapproved.voice.script.approvedRunId, secondRunId);
    assert.equal(reapproved.story[0].TextJpVoice, "[excited]台詞！");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("requires a current validated recording before final preview approval", () => {
  const root = workspaceDirectory(videoPreviewIdentity);
  fs.rmSync(root, { recursive: true, force: true });
  try {
    const workspace = ensureWorkspace(videoPreviewIdentity);
    const base = story();
    initializeProduction(workspace.id, base, { source: "test" });
    const current = getProduction(workspace.id);
    const productionRoot = current.paths.root;
    const assemblyStoryPath = path.join(productionRoot, "assembly", "story.json");
    const assemblyManifestPath = path.join(productionRoot, "assembly", "manifest.json");
    fs.mkdirSync(path.dirname(assemblyStoryPath), { recursive: true });
    fs.writeFileSync(assemblyStoryPath, `${JSON.stringify(base, null, 2)}\n`);
    const assemblyDigest = storyDigest(base);
    fs.writeFileSync(assemblyManifestPath, `${JSON.stringify({
      schemaVersion: 1,
      inputs: {
        base: current.base.digest,
        cn: current.cn.digest,
        speakers: current.voice.speakers.digest,
        references: current.voice.references.digest,
        script: current.voice.script.digest,
        skipped: jsonDigest(current.voice.script.effectiveSkippedIndices),
        voice: null,
      },
      storyDigest: assemblyDigest,
    }, null, 2)}\n`);

    assert.throws(
      () => completeProductionPreview(workspace.id),
      /preview video first/u,
    );

    const videoPath = path.join(productionRoot, "preview.mp4");
    fs.writeFileSync(videoPath, "validated-video-placeholder");
    fs.writeFileSync(path.join(productionRoot, "recording.json"), `${JSON.stringify({
      schemaVersion: 1,
      completedAt: new Date().toISOString(),
      assemblyDigest,
      branchDigest: jsonDigest({
        defaultSelectionGroups: {}, checkedSelectionKeys: [], updatedAt: null,
      }),
      output: videoPath,
      validation: { ffprobe: true, fullDecode: true },
    }, null, 2)}\n`);
    assert.equal(getProduction(workspace.id).recording.current, true);
    assert.equal(completeProductionPreview(workspace.id).preview.complete, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("marks complete existing viewer tracks ready without inventing LLM runs", () => {
  const root = workspaceDirectory(baselineIdentity);
  fs.rmSync(root, { recursive: true, force: true });
  try {
    const workspace = ensureWorkspace(baselineIdentity);
    const base = story();
    initializeProduction(workspace.id, base, {
      source: "test",
      baseline: { adopted: true, preservedVoiceIndices: [1] },
    }, {
      approveCnBaseline: true,
      approveVoiceScriptBaseline: true,
    });
    const production = getProduction(workspace.id);
    assert.equal(production.cn.ready, true);
    assert.equal(production.cn.approvalSource, "existing-viewer-baseline");
    assert.equal(production.cn.generationCount, 0);
    assert.equal(production.voice.script.ready, true);
    assert.equal(production.voice.script.approvalSource, "existing-viewer-baseline");
    assert.equal(production.voice.script.generationCount, 0);
    assert.deepEqual(production.base.baseline.preservedVoiceIndices, [1]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
