import assert from "node:assert/strict";
import test from "node:test";

import { productionTtsIndices } from "./stage-runner.mjs";

test("excludes preserved viewer voice and reviewed no-voice lines from TTS", () => {
  const story = {
    GroupId: 31010,
    content: [
      { ScriptKr: "1;아루;00;기존", TextJp: "既存", TextJpVoice: "既存", VoiceJp: "Main_31010_001" },
      { ScriptKr: "1;아루;00;생성", TextJp: "生成", TextJpVoice: "[calm]生成", VoiceJp: "" },
      { ScriptKr: "1;아루;00;생략", TextJp: "省略", TextJpVoice: "省略", VoiceJp: "" },
    ],
  };
  const production = {
    base: { baseline: { preservedVoiceIndices: [0] } },
    voice: { script: { effectiveSkippedIndices: [2] } },
  };
  assert.deepEqual(productionTtsIndices(production, story), [1]);
});
