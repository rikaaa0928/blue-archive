import assert from "node:assert/strict";
import test from "node:test";

import {
  inferScenarioRole,
  isAnonymousScenarioSpeaker,
  isUnknownScenarioSpeaker,
  parseScenarioScriptSpeakers,
} from "./scenario-script-speakers.mjs";

test("uses the same character-line fields as the player", () => {
  assert.deepEqual(
    parseScenarioScriptSpeakers(
      "1;카즈사;0;첫 줄\n2;레이사;0;둘째 줄\n#wait;1000",
    ),
    {
      speakers: ["카즈사", "레이사"],
      dialogueSpeaker: "레이사",
    },
  );
});

test("recognizes player narration speakers", () => {
  assert.deepEqual(parseScenarioScriptSpeakers("#na;???;……여보세요?"), {
    speakers: ["???"],
    dialogueSpeaker: "???",
  });
  assert.equal(inferScenarioRole("#na;???;……여보세요?"), "narration");
});

test("does not treat a silent character placement as dialogue", () => {
  assert.deepEqual(parseScenarioScriptSpeakers("3;카즈사;0;"), {
    speakers: ["카즈사"],
    dialogueSpeaker: "",
  });
});

test("shares unknown and anonymous classification", () => {
  assert.equal(isUnknownScenarioSpeaker("？？？"), true);
  assert.equal(isAnonymousScenarioSpeaker("스케반 A"), true);
  assert.equal(isAnonymousScenarioSpeaker("카즈사"), false);
});
