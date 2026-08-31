import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { approveReview, openReview, reviewSummary, updateReview } from "./reviews.mjs";
import {
  applyTtsSkipDecision,
  isPunctuationOnlyTtsText,
  missingPlannedVoiceIndices,
  readJson,
  resolveTtsSkippedIndices,
  storyDigest,
  workspaceDirectory,
  writeJsonAtomic,
} from "./utils.mjs";
import {
  activateVersion,
  createRevision,
  createReworkVersion,
  ensureWorkspace,
  listRevisionLineage,
  listRevisions,
  loadWorkspace,
} from "./workspaces.mjs";

const identity = { type: "other", storyId: "999999999901" };

test("detects punctuation-only TTS lines without skipping spoken text", () => {
  assert.equal(isPunctuationOnlyTtsText("……。"), true);
  assert.equal(isPunctuationOnlyTtsText("[speechless]…………"), true);
  assert.equal(isPunctuationOnlyTtsText("[sad]あ……"), false);
});

test("resolves automatic, explicit, and forced TTS skip decisions in one place", () => {
  const skipStory = {
    content: [
      { TextJpVoice: "[speechless]……" },
      { TextJpVoice: "せりふ" },
      { TextJpVoice: "！？" },
    ],
  };
  assert.deepEqual(resolveTtsSkippedIndices(skipStory), [0, 2]);
  assert.deepEqual(resolveTtsSkippedIndices(skipStory, {
    ttsSkippedIndices: [1],
    ttsForcedIndices: [0],
  }), [1, 2]);

  const restored = applyTtsSkipDecision(skipStory, {}, 0, false);
  assert.equal(restored.wasSkipped, true);
  assert.deepEqual(restored.ttsSkippedIndices, []);
  assert.deepEqual(restored.ttsForcedIndices, [0]);
  assert.deepEqual(resolveTtsSkippedIndices(skipStory, restored), [2]);

  const manuallySkipped = applyTtsSkipDecision(skipStory, restored, 1, true);
  assert.equal(manuallySkipped.wasSkipped, false);
  assert.deepEqual(resolveTtsSkippedIndices(skipStory, manuallySkipped), [1, 2]);
});

test("release voice validation follows the approved TTS plan instead of every TextJpVoice row", () => {
  const releaseStory = {
    content: [
      { ScriptKr: "#title;test", TextJpVoice: "タイトル", VoiceJp: "" },
      { ScriptKr: "1;speaker;00;line", TextJpVoice: "せりふ", VoiceJp: "r2://voice-1" },
      { ScriptKr: "1;speaker;00;pause", TextJpVoice: "……", VoiceJp: "" },
      { ScriptKr: "1;speaker;00;missing", TextJpVoice: "未生成", VoiceJp: "" },
    ],
  };
  const ttsPlan = [{ index: 1 }, { index: 2 }, { index: 3 }];
  assert.deepEqual(missingPlannedVoiceIndices(releaseStory, ttsPlan, [2]), [3]);
  assert.deepEqual(missingPlannedVoiceIndices(releaseStory, ttsPlan, [2, 3]), []);
});

function story() {
  return {
    GroupId: 999999999901,
    translator: "test",
    proofreader: "test",
    content: [
      {
        GroupId: 999999999901,
        ScriptKr: "1;테스트;00;안녕하세요",
        TextJp: "こんにちは。",
        TextCn: "你好。",
        TextTw: "你好。",
        TextJpVoice: "[gentle]こんにちは。",
        VoiceJp: "",
      },
      {
        GroupId: 999999999901,
        ScriptKr: "1;관광객 A;00;좋은 날씨네요",
        TextJp: "いい天気ですね。",
        TextCn: "天气真好。",
        TextTw: "天氣真好。",
        TextJpVoice: "いい天気ですね。",
        VoiceJp: "",
      },
      {
        GroupId: 999999999901,
        ScriptKr: "#na;테스트부;다 같이",
        TextJp: "みんなで。",
        TextCn: "大家一起。",
        TextTw: "大家一起。",
        TextJpVoice: "みんなで。",
        VoiceJp: "",
      },
      {
        GroupId: 999999999901,
        ScriptKr: "3;테스트;00\n#na;???;저예요",
        TextJp: "私です。",
        TextCn: "是我。",
        TextTw: "是我。",
        TextJpVoice: "私です。",
        VoiceJp: "",
      },
      {
        GroupId: 999999999901,
        ScriptKr: "3;테스트;00\n#3;a\n#wait;1200",
        TextJp: "",
        TextCn: "",
        TextTw: "",
        TextJpVoice: "",
        VoiceJp: "",
      },
    ],
  };
}

test("creates immutable revisions and both human review artifacts", async () => {
  const root = workspaceDirectory(identity);
  fs.rmSync(root, { recursive: true, force: true });
  try {
    const workspace = ensureWorkspace(identity);
    const normalizedStory = story();
    normalizedStory.content[0].TextCn = "旧译。";
    createRevision(workspace.id, { stage: "cn-normalize", story: normalizedStory });
    createRevision(workspace.id, {
      stage: "cn-llm-1",
      story: story(),
      result: {
        changes: [{
          pass: 1,
          index: 0,
          before: "旧译。",
          after: "你好。",
          issueTypes: ["meaning"],
          rationale: "依据日文修正原译含义。",
          TextJp: "こんにちは。",
          TextTw: "你好。",
        }],
      },
    });
    createRevision(workspace.id, { stage: "cn-llm-2", story: story() });
    writeJsonAtomic(path.join(workspace.paths.resources, "voice-availability.json"), {
      schemaVersion: 1,
      storyDigest: storyDigest(story()),
      items: [
        { stableKey: "테스트", characterName: "测试", available: true, reason: "japanese-voice-found" },
        { stableKey: "관광객 A", characterName: "观光客A", available: false, reason: "download-source-missing" },
      ],
    });

    let tool1 = openReview(workspace.id, "tool1");
    assert.equal(tool1.issues.length, 4);
    assert.equal(tool1.issues.some(issue => issue.index === 4), false);
    const cnIssue = tool1.issues.find(issue => issue.kind === "cn-change");
    assert.deepEqual(cnIssue.llmHistory[0].issueTypes, ["meaning"]);
    assert.equal(cnIssue.llmHistory[0].rationale, "依据日文修正原译含义。");
    tool1 = updateReview(workspace.id, "tool1", {
      decision: { issueId: cnIssue.id, value: "approved" },
    });
    tool1 = updateReview(workspace.id, "tool1", {
      lineEdit: { index: cnIssue.index, field: "TextCn", value: "人工修订文本。" },
    });
    assert.equal(tool1.story.content[cnIssue.index].TextCn, "人工修订文本。");
    assert.equal(tool1.decisions[cnIssue.id], "pending");
    assert.deepEqual(
      { ...tool1.manualEdits.at(-1), editedAt: "<time>" },
      {
        index: cnIssue.index,
        field: "TextCn",
        before: "你好。",
        after: "人工修订文本。",
        editedAt: "<time>",
      },
    );
    const unknownIssue = tool1.issues.find(issue => issue.id.startsWith("unknown:"));
    assert.equal(unknownIssue.speakerCandidates[0].stableKey, "테스트");
    const unavailableIssue = tool1.issues.find(issue => issue.id.startsWith("unavailable:"));
    assert.equal(unavailableIssue.sourceSpeaker, "관광객 A");
    assert.equal(unavailableIssue.voiceAvailability.reason, "download-source-missing");
    assert.deepEqual(tool1.characterRoster, []);
    for (const issue of tool1.issues) {
      tool1 = updateReview(workspace.id, "tool1", {
        decision: { issueId: issue.id, value: "approved" },
      });
      if (issue.kind === "collective-speaker") {
        tool1 = updateReview(workspace.id, "tool1", {
          resolution: { issueId: issue.id, members: ["테스트", "테스트2"], evidence: "test scene" },
        });
      } else if (issue.kind === "unknown-speaker") {
        tool1 = updateReview(workspace.id, "tool1", {
          resolution: {
            issueId: issue.id,
            resolution: "character",
            resolvedSpeaker: "테스트",
            evidence: "revealed on the next line",
          },
        });
      }
    }
    tool1 = updateReview(workspace.id, "tool1", {
      playback: { defaultComplete: true, checkedBranchIndices: [] },
    });
    assert.equal(tool1.playback.defaultComplete, true);
    const review1 = approveReview(workspace.id, "tool1");
    assert.equal(review1.stage, "review-1");
    assert.equal(review1.result.manualEdits.length, 1);

    createRevision(workspace.id, {
      stage: "voice-draft",
      story: review1.story,
      inputRevision: review1.name,
    });
    let tool2 = openReview(workspace.id, "tool2");
    assert.equal(tool2.issues.length, 4);
    tool2 = updateReview(workspace.id, "tool2", {
      ttsSkip: { index: 1, skipped: true },
    });
    for (const issue of tool2.issues) {
      tool2 = updateReview(workspace.id, "tool2", {
        decision: { issueId: issue.id, value: "approved" },
      });
    }
    assert.equal(reviewSummary(tool2).playbackRequired, false);
    assert.equal(reviewSummary(tool2).playbackComplete, true);
    const review2 = approveReview(workspace.id, "tool2");
    assert.equal(review2.stage, "review-2");
    assert.equal(review2.result.ttsPlan[0].expected.ttsText, "[gentle]こんにちは。");
    assert.deepEqual(review2.result.ttsSkippedIndices, [1]);
    assert.equal(review2.result.ttsPlan.some(item => item.index === 1), false);

    const config = readJson(path.join(review2.root, "collective-voice-config.json"));
    assert.equal(config.source.contentLength, 5);
    assert.equal(config.lines.length, 3);
    assert.equal(config.lines[0].resolvedSpeaker, "테스트");
    assert.deepEqual(config.lines[1].members, ["테스트", "테스트2"]);
    assert.equal(config.lines[2].resolvedSpeaker, "테스트");
    assert.equal(listRevisions(workspace.id).length, 6);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("creates a rework version without overwriting either revision lineage", () => {
  const versionIdentity = { type: "other", storyId: "999999999903" };
  const root = workspaceDirectory(versionIdentity);
  fs.rmSync(root, { recursive: true, force: true });
  try {
    const workspace = ensureWorkspace(versionIdentity);
    const first = createRevision(workspace.id, { stage: "raw-import", story: story() });
    assert.equal(path.basename(path.dirname(first.root)), "v001");
    const normalized = createRevision(workspace.id, { stage: "cn-normalize", story: story() });
    const llm = createRevision(workspace.id, { stage: "cn-llm-1", story: story() });
    createRevision(workspace.id, { stage: "cn-llm-2", story: story() });

    const fork = createReworkVersion(workspace.id, {
      restartStage: "cn-llm-2",
      label: "重做第二轮中文",
      inheritedCompletedStages: ["sync", "locate", "raw-import", "cn-normalize", "cn-llm-1"],
    });
    assert.equal(fork.version.id, "v002");
    assert.equal(fork.workspace.currentRevision, llm.name);
    assert.deepEqual(listRevisionLineage(workspace.id).map(item => item.name), [
      first.name, normalized.name, llm.name,
    ]);

    const changedStory = story();
    changedStory.content[0].TextCn = "第二个版本。";
    const replacement = createRevision(workspace.id, { stage: "cn-llm-2", story: changedStory });
    assert.equal(replacement.versionId, "v002");
    assert.equal(path.basename(path.dirname(replacement.root)), "v002");
    assert.equal(loadWorkspace(workspace.id).versions[0].currentRevision.endsWith("cn-llm-2"), true);

    activateVersion(workspace.id, "v001");
    assert.notEqual(loadWorkspace(workspace.id).currentRevision, replacement.name);
    assert.equal(listRevisionLineage(workspace.id).at(-1).versionId, "v001");
    activateVersion(workspace.id, "v002");
    assert.equal(loadWorkspace(workspace.id).currentRevision, replacement.name);
    assert.equal(listRevisions(workspace.id).length, 5);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("distinguishes real SelectionGroup branches from a single continue option", () => {
  const choiceIdentity = { type: "other", storyId: "999999999902" };
  const root = workspaceDirectory(choiceIdentity);
  fs.rmSync(root, { recursive: true, force: true });
  try {
    const workspace = ensureWorkspace(choiceIdentity);
    const choiceStory = {
      GroupId: 999999999902,
      content: [
        {
          ScriptKr: "[s1] \"첫 번째\"\n[s2] \"두 번째\"",
          TextJp: "[s1] \"一つ目\"\n[s2] \"二つ目\"",
          TextCn: "[s1]「第一个」\n[s2]「第二个」",
          TextTw: "[s1]「第一個」\n[s2]「第二個」",
          SelectionGroup: 0,
        },
        { ScriptKr: "1;테스트;00;첫 응답", TextCn: "响应一", SelectionGroup: 1 },
        { ScriptKr: "1;테스트;00;둘째 응답", TextCn: "响应二", SelectionGroup: 2 },
        {
          ScriptKr: "[s] \"계속\"",
          TextJp: "[s] \"続ける\"",
          TextCn: "[s]「继续」",
          TextTw: "[s]「繼續」",
          SelectionGroup: 0,
        },
      ],
    };
    createRevision(workspace.id, { stage: "cn-normalize", story: choiceStory });
    createRevision(workspace.id, { stage: "cn-llm-2", story: choiceStory });
    const draft = openReview(workspace.id, "tool1");
    const choices = draft.issues.filter(issue => issue.kind === "choice");
    assert.equal(choices.length, 2);
    assert.deepEqual(choices[0].options.map(option => option.selectionGroup), [1, 2]);
    assert.deepEqual(choices[0].options.map(option => option.responseIndex), [1, 2]);
    assert.equal(choices[1].options[0].isBranch, false);
    assert.deepEqual(reviewSummary(draft).missingBranches, ["0:1", "0:2"]);
    assert.deepEqual(reviewSummary(draft).missingDefaultSelections, [0]);
    let updated = updateReview(workspace.id, "tool1", {
      playback: {
        checkedSelectionKeys: ["0:1"],
        defaultSelectionGroups: { 0: 2 },
      },
    });
    assert.deepEqual(reviewSummary(updated).missingBranches, ["0:2"]);
    assert.deepEqual(reviewSummary(updated).missingDefaultSelections, []);
    assert.deepEqual(updated.playback.defaultSelectionGroups, { 0: 2 });
    assert.throws(
      () => updateReview(workspace.id, "tool1", {
        decision: { issueId: choices[0].id, value: "approved" },
      }),
      /every response branch must be checked first/u,
    );
    updated = updateReview(workspace.id, "tool1", {
      playback: {
        defaultComplete: true,
        checkedSelectionKeys: ["0:1", "0:2"],
      },
    });
    for (const issue of updated.issues) {
      updated = updateReview(workspace.id, "tool1", {
        decision: { issueId: issue.id, value: "approved" },
      });
    }
    updated = updateReview(workspace.id, "tool1", {
      playback: { checkedSelectionKeys: ["0:1"] },
    });
    assert.equal(updated.decisions[choices[0].id], "pending");
    updated = updateReview(workspace.id, "tool1", {
      playback: { checkedSelectionKeys: ["0:1", "0:2"] },
    });
    updated = updateReview(workspace.id, "tool1", {
      decision: { issueId: choices[0].id, value: "approved" },
    });
    const review = approveReview(workspace.id, "tool1");
    assert.deepEqual(review.result.recordingPreSelections, [
      { storyIndex: 0, selectionGroup: 2 },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
