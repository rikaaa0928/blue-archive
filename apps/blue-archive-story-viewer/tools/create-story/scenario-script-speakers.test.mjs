import assert from "node:assert/strict";
import test from "node:test";

import {
  inferScenarioRole,
  isAnonymousScenarioSpeaker,
  isUnknownScenarioSpeaker,
  parseScenarioScriptSpeakers,
  replaceScenarioDialogueSpeaker,
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

test("replaces only the spoken character line in a multiline script", () => {
  assert.equal(
    replaceScenarioDialogueSpeaker(
      "#all;hide\n#na;히후미 수영복ND;영차…… 땅을 판 뒤에……",
      "히후미 수영복ND",
      "히후미 수영복ND",
    ),
    "#all;hide\n#na;히후미 수영복ND;영차…… 땅을 판 뒤에……",
  );
  assert.equal(
    replaceScenarioDialogueSpeaker(
      "3;테스트;00\n#na;???;저예요",
      "츠루기",
      "???",
    ),
    "3;테스트;00\n#na;츠루기;저예요",
  );
});

test("replaces a regular dialogue speaker without touching scene commands", () => {
  assert.equal(
    replaceScenarioDialogueSpeaker(
      "#all;hide\n3;???;00;대사\n#3;a",
      "츠루기",
      "???",
    ),
    "#all;hide\n3;츠루기;00;대사\n#3;a",
  );
});
