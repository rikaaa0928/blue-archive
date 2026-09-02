import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildStoryOutline,
  collectCoverRoster,
  coverAttemptResolution,
  generateStoryCover,
  imageDimensions,
  makeImagePrompt,
  parseCoverArguments,
  validateCoverPlan,
} from "./generate-story-cover.mjs";

function fakeJpeg(width = 1600, height = 900) {
  const buffer = Buffer.alloc(14);
  buffer.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x08, 0x08], 0);
  buffer.writeUInt16BE(height, 7);
  buffer.writeUInt16BE(width, 9);
  buffer.set([0x03, 0x01, 0x11], 11);
  return buffer;
}

test("parses bounded cover generation arguments", () => {
  const parsed = parseCoverArguments([
    "story.json", "--resolution", "4k", "--max-attempts", "3",
    "--character", "鹤城", "--character", "日富美", "--include-lobby",
  ]);
  assert.equal(parsed.storyPath, "story.json");
  assert.equal(parsed.resolution, "4K");
  assert.equal(parsed.maxAttempts, 3);
  assert.deepEqual(parsed.characters, ["鹤城", "日富美"]);
  assert.equal(parsed.includeLobby, true);
  assert.throws(() => parseCoverArguments(["story.json", "--max-attempts", "9"]), /1 to 4/u);
});

test("extracts the complete multilingual story outline", () => {
  const outline = buildStoryOutline({ content: [{
    GroupId: 10002005, ScriptKr: "3;히후미;00;바다예요!", TextJp: "海ですよ！",
    TextTw: "是大海唷！", TextCn: "是大海！",
  }] });
  assert.deepEqual(outline[0], {
    index: 0, speakerKr: "히후미", scriptKr: "3;히후미;00;바다예요!",
    textJp: "海ですよ！", textTw: "是大海唷！", textCn: "是大海！",
    selectionGroup: 0, bgName: 0,
  });
});

test("uses the selected character version for cover references", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "story-cover-version-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "日富美"), { recursive: true });
  fs.mkdirSync(path.join(root, "日富美(泳装)"), { recursive: true });
  fs.writeFileSync(path.join(root, "日富美", "设定集.png"), "default");
  fs.writeFileSync(path.join(root, "日富美(泳装)", "设定集.png"), "swimsuit");
  const roster = await collectCoverRoster({
    outline: [{ speakerKr: "히후미 수영복ND" }],
    speakerConfig: { items: [{
      sourceSpeaker: "히후미 수영복ND",
      resolution: { type: "character", stableKey: "히후미 수영복ND", characterName: "日富美" },
    }] },
    characters: [],
    characterRoot: root,
    characterVersions: { 日富美: "日富美(泳装)" },
  });
  assert.equal(roster[0].characterName, "日富美");
  assert.equal(roster[0].resourceName, "日富美(泳装)");
  assert.equal(roster[0].settingPath, path.join(root, "日富美(泳装)", "设定集.png"));
});

test("rejects hallucinated character references", () => {
  const roster = [{ id: "character-1", referenceReady: true }];
  const base = { coverDirection: "lyrical", imagePrompt: "A quiet beach", selectedCharacterIds: ["character-1"] };
  assert.deepEqual(validateCoverPlan(base, roster, 2).selectedCharacterIds, ["character-1"]);
  assert.throws(() => validateCoverPlan({ ...base, selectedCharacterIds: ["made-up"] }, roster, 2), /unavailable reference/u);
  assert.throws(() => validateCoverPlan(base, roster, 2, "dramatic"), /series direction dramatic/u);
  assert.equal(validateCoverPlan(base, roster, 2, "lyrical").coverDirection, "lyrical");
});

test("adds immutable image safety requirements to the Gemini art brief", () => {
  const prompt = makeImagePrompt({
    imagePrompt: "Cinematic beach scene.", negativePrompt: "no bad anatomy",
    titleSafeArea: "open sky on the right",
  }, [{ id: "character-1", characterName: "日富美", kind: "setting-sheet" }], ["remove pseudo text"]);
  assert.match(prompt, /no text/u);
  assert.match(prompt, /no black rectangle/u);
  assert.match(prompt, /appears exactly once/u);
  assert.match(prompt, /remove pseudo text/u);
});

test("reads JPEG dimensions without an image-processing dependency", () => {
  assert.deepEqual(imageDimensions(fakeJpeg(), "image/jpeg"), { width: 1600, height: 900 });
});

test("uses a cheaper draft before the requested final resolution", () => {
  assert.equal(coverAttemptResolution("2K", 2, 1), "1K");
  assert.equal(coverAttemptResolution("4K", 3, 1), "2K");
  assert.equal(coverAttemptResolution("4K", 3, 2, true), "4K");
  assert.equal(coverAttemptResolution("2K", 1, 1), "2K");
});

test("runs planning, image generation, and QA with an injected Gemini client", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "story-cover-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storyPath = path.join(root, "10002005.json");
  fs.writeFileSync(storyPath, JSON.stringify({ GroupId: 10002005, content: [{
    GroupId: 10002005, ScriptKr: "3;히후미;00;바다예요!", TextJp: "海ですよ！",
    TextTw: "是大海唷！", TextCn: "是大海！",
  }] }));
  const characterRoot = path.join(root, "characters");
  fs.mkdirSync(path.join(characterRoot, "日富美"), { recursive: true });
  fs.writeFileSync(path.join(characterRoot, "日富美", "设定集.png"), Buffer.from("reference"));
  const speakerConfig = path.join(root, "speakers.json");
  fs.writeFileSync(speakerConfig, JSON.stringify({ items: [{
    stableKey: "히후미", sourceSpeaker: "히후미",
    resolution: { type: "character", stableKey: "히후미", characterName: "日富美" },
  }] }));
  const plan = {
    title: "海边初体验", synopsis: "日富美带朋友看海", relationshipChange: "距离拉近",
    emotionalAftertaste: "明亮温柔", coverDirection: "lyrical", chapterHook: "第一次看海",
    selectedCharacterIds: ["character-1"], characterRoles: ["日富美是视觉中心"],
    sceneConcept: "海风中的期待", focalPoint: "日富美", camera: "medium wide",
    foreground: "shells", middleground: "日富美", background: "sea and sky",
    titleSafeArea: "open sky on the right", moodLightingPalette: "summer cyan and warm white",
    identityConstraints: ["preserve halo"], imagePrompt: "Cinematic anime beach key visual",
    negativePrompt: "no text, no duplicate person",
  };
  let call = 0;
  const ai = { models: { async generateContent() {
    call += 1;
    if (call === 1) return { text: JSON.stringify(plan) };
    if (call === 2) return { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/jpeg", data: fakeJpeg().toString("base64") } }] } }] };
    return { text: JSON.stringify({
      passed: true, score: 90, thumbnailReadable: true, identityPreserved: true,
      characterCountCorrect: true, anatomyAcceptable: true, safeCropAndTitleSpace: true,
      unwantedTextAbsent: true, chapterConceptReadable: true, strengths: ["clear focal point"],
      issues: [], summary: "Ready for human review.",
    }) };
  } } };
  const output = path.join(root, "cover.jpg");
  const result = await generateStoryCover({
    storyPath, speakerConfig, characterRoot, characters: [], output,
    runRoot: path.join(root, "runs"), analysisModel: "analysis-test", imageModel: "image-test",
    qaModel: "qa-test", resolution: "1K", maxAttempts: 2, minQaScore: 82,
    maxCharacters: 2, includeLobby: false, guidance: "", force: false,
  }, { ai, now: () => new Date("2026-08-26T01:02:03Z") });
  assert.equal(call, 3);
  assert.equal(result.qaPassed, true);
  assert.equal(result.qaScore, 90);
  assert.equal(fs.existsSync(output), true);
  assert.equal(JSON.parse(fs.readFileSync(result.manifestPath, "utf8")).status, "completed");
});

test("retries when the image model returns no image", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "story-cover-retry-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storyPath = path.join(root, "10002010.json");
  fs.writeFileSync(storyPath, JSON.stringify({ GroupId: 10002010, content: [{
    GroupId: 10002010, ScriptKr: "3;히후미;00;괜찮아요!", TextJp: "大丈夫です！",
  }] }));
  const characterRoot = path.join(root, "characters");
  fs.mkdirSync(path.join(characterRoot, "日富美"), { recursive: true });
  fs.writeFileSync(path.join(characterRoot, "日富美", "设定集.png"), Buffer.from("reference"));
  const speakerConfig = path.join(root, "speakers.json");
  fs.writeFileSync(speakerConfig, JSON.stringify({ items: [{
    stableKey: "히후미", sourceSpeaker: "히후미",
    resolution: { type: "character", stableKey: "히후미", characterName: "日富美" },
  }] }));
  const plan = {
    title: "砂城", synopsis: "砂の城を守る", relationshipChange: "共に立ち向かう",
    emotionalAftertaste: "熱い", coverDirection: "dramatic", chapterHook: "突撃の瞬間",
    selectedCharacterIds: ["character-1"], characterRoles: ["日富美が中心"],
    sceneConcept: "砂浜の対決", focalPoint: "日富美", camera: "medium wide",
    foreground: "sand", middleground: "日富美", background: "sea",
    titleSafeArea: "open sky", moodLightingPalette: "summer blue",
    identityConstraints: ["preserve halo"], imagePrompt: "Cinematic anime beach action",
    negativePrompt: "no text, no duplicate person",
  };
  let call = 0;
  const ai = { models: { async generateContent() {
    call += 1;
    if (call === 1) return { text: JSON.stringify(plan) };
    if (call === 2) return { candidates: [{ content: { parts: [{ text: "" }] } }] };
    if (call === 3) return { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/jpeg", data: fakeJpeg().toString("base64") } }] } }] };
    return { text: JSON.stringify({
      passed: true, score: 90, thumbnailReadable: true, identityPreserved: true,
      characterCountCorrect: true, anatomyAcceptable: true, safeCropAndTitleSpace: true,
      unwantedTextAbsent: true, chapterConceptReadable: true, strengths: ["clear focal point"],
      issues: [], summary: "Ready.",
    }) };
  } } };
  const output = path.join(root, "cover.jpg");
  const result = await generateStoryCover({
    storyPath, speakerConfig, characterRoot, characters: [], output,
    runRoot: path.join(root, "runs"), analysisModel: "analysis-test", imageModel: "image-test",
    qaModel: "qa-test", resolution: "1K", maxAttempts: 2, minQaScore: 82,
    maxCharacters: 2, includeLobby: false, guidance: "", force: false,
  }, { ai, now: () => new Date("2026-09-01T01:02:03Z") });
  assert.equal(call, 4);
  assert.equal(result.qaPassed, true);
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, "utf8"));
  assert.equal(manifest.attempts[0].status, "generation-failed");
  assert.match(manifest.attempts[0].error, /returned no image/u);
  assert.equal(manifest.bestAttempt, 2);
});
