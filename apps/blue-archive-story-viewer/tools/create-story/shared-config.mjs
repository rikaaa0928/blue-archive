export const anonymousNpcPresetVoice = Object.freeze({
  characterName: "NPC Neutral Raw Experiment v4",
  voiceId: 35,
  referenceId: "voice_193_8jCd8isNspPy",
  voiceStatus: "ACTIVE",
  providerSyncStatus: "SYNCED",
});

export function normalizeTextJpVoice(value) {
  let text = String(value ?? "");
  let previous;

  // TTS must never read parenthetical annotations, including abbreviations
  // such as "(SNP)" and full-width Japanese stage directions.
  do {
    previous = text;
    text = text.replace(/\([^()]*\)|（[^（）]*）/gu, "");
  } while (text !== previous);

  return text
    .replace(/[ \t]+(?=\n|$)/gu, "")
    .replace(/[ \t]{2,}/gu, " ")
    .trim();
}

export const textJpVoiceOverrides = new Map([
  [
    "1102:4",
    {
      expectedScriptKr:
        "5;이즈미;08;뭐어어? 트뤼플? 나도 먹고싶었는데에에에!\n#5;a\n#5;em;[반응]",
      expectedTextJp: "えええっ！？トリュフ？？私も食べたかったのにいいい！",
      textJpVoice:
        "[surprised]えええっ！？[hysterical]トリュフ？？[disappointed]私も食べたかったのに！",
    },
  ],
  [
    "1102:11",
    {
      expectedScriptKr:
        "5;이즈미;04;(쾅쾅쾅쾅-!!) 야 이 놈들아!! 니들만 맛있는 거 먹기냐!! #n우리도 나눠줘! 으애애애애-!!\n#5;shake",
      expectedTextJp:
        "（ドンドンドンドン！！！）鬼！悪魔！あなたたちだけ美味しいの食べて！\n食べ物の恨みは恐ろしいんだぞ！！\n私にもちょうだいよおおお！うああああん！！",
      textJpVoice:
        "[hysterical]鬼！悪魔！あなたたちだけ美味しいの食べて！\n[angry]食べ物の恨みは恐ろしいんだぞ！！\n[upset]私にもちょうだいよおお！うああああん！！",
    },
  ],
  [
    "1102:56",
    {
      expectedScriptKr:
        "5;히나;99;누가 학교 수영장에서 알몸으로 수영하고 있다는 신고만으로 선생님을 구금한 건…… #n확실히 내가 좀 성급했던 거 같긴 한데…….\n#5;m4",
      expectedTextJp:
        "学校のプールで裸で泳いでいるっていう通報を受けただけで先生を拘束したのは……\n実際私の早とちりだったみたい、だけど……。",
      textJpVoice:
        "[uncertain] 学校のプールで裸で泳いでいるっていう通報を受けただけで先生を拘束したのは……\n[regretful] 実際私の早とちりだったみたい、だけど……。",
    },
  ],
  [
    "1102:65",
    {
      expectedScriptKr:
        "3;히나;15;변명은 지옥에서 듣지.\n#fontsize;80\n#3;closeup",
      expectedTextJp: "言い訳は地獄で聞くから。",
      textJpVoice: "[angry]言い訳は地獄で聞くから。",
    },
  ],
]);

function validateTextJpVoiceOverride(key, override, unit) {
  if (unit.TextJp !== override.expectedTextJp) {
    throw new Error(
      `TextJpVoice override ${key} TextJp mismatch; ` +
        "update shared-config.mjs manually",
    );
  }
  if (unit.ScriptKr !== override.expectedScriptKr) {
    throw new Error(
      `TextJpVoice override ${key} ScriptKr mismatch; ` +
        "update shared-config.mjs manually",
    );
  }
}

export function applyStoryTextJpVoiceOverrides(storyId, content) {
  const lockedIndices = new Set();
  const prefix = `${storyId}:`;

  for (const [key, override] of textJpVoiceOverrides) {
    if (!key.startsWith(prefix)) {
      continue;
    }

    const matches = [];
    for (let index = 0; index < content.length; index++) {
      const unit = content[index];
      if (
        unit.TextJp === override.expectedTextJp &&
        unit.ScriptKr === override.expectedScriptKr
      ) {
        matches.push(index);
      }
    }
    if (matches.length !== 1) {
      throw new Error(
        `TextJpVoice override ${key} expected exactly one exact story match, ` +
          `found ${matches.length}; update shared-config.mjs manually`,
      );
    }

    const index = matches[0];
    const unit = content[index];
    validateTextJpVoiceOverride(key, override, unit);
    unit.TextJpVoice = normalizeTextJpVoice(override.textJpVoice);
    if (!unit.TextJpVoice) {
      unit.VoiceJp = "";
    }
    lockedIndices.add(index);
  }

  return lockedIndices;
}

// Fish Audio's official Basic + Advanced Emotion Reference. These are the
// preferred vocabulary, not a hard whitelist: S2 also accepts concise natural
// language cues. Tone controls, audio effects, and special effects remain a
// separate category and are not appropriate for this story workflow.
export const voiceEmotionTags = Object.freeze([
  "happy", "sad", "angry", "excited", "calm", "nervous", "confident",
  "surprised", "satisfied", "delighted", "scared", "worried", "upset",
  "frustrated", "depressed", "empathetic", "embarrassed", "disgusted",
  "moved", "proud", "relaxed", "grateful", "curious", "sarcastic",
  "disdainful", "unhappy", "anxious", "hysterical", "indifferent",
  "uncertain", "doubtful", "confused", "disappointed", "regretful",
  "guilty", "ashamed", "jealous", "envious", "hopeful", "optimistic",
  "pessimistic", "nostalgic", "lonely", "bored", "contemptuous",
  "sympathetic", "compassionate", "determined", "resigned",
]);

// Backward-compatible export name used by the voice-draft prompt.
export const voiceTagExamples = voiceEmotionTags;
