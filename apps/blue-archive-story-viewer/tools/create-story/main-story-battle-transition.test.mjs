import assert from "node:assert/strict";
import test from "node:test";

import {
  MAIN_STORY_BATTLE_TRANSITION_SOUNDS,
  insertMainStoryBattleTransition,
} from "./main-story-battle-transition.mjs";

const row = (GroupId, ScriptKr) => ({ GroupId, ScriptKr });

test("inserts a black gunfire transition before downstream story indices are assigned", () => {
  const postBattleChoice = { GroupId: 11025, ScriptKr: "#select;1", SelectionGroup: 0 };
  const content = [row(11020, "front one"), row(11020, "front two"), row(11025, "back"), postBattleChoice];
  const result = insertMainStoryBattleTransition(content, {
    frontGroupIds: ["11020"],
    backGroupIds: ["11025"],
  });

  assert.equal(result.length, 10);
  assert.equal(result[2].GroupId, 11025);
  assert.deepEqual(
    result.slice(2, 8).map(item => item.Sound),
    MAIN_STORY_BATTLE_TRANSITION_SOUNDS.map(item => item.sound),
  );
  assert.equal(result[2].ScriptKr, `#all;hide\n#battle;${MAIN_STORY_BATTLE_TRANSITION_SOUNDS[0].durationMs}`);
  assert.deepEqual(
    result.slice(3, 8).map(item => item.ScriptKr),
    MAIN_STORY_BATTLE_TRANSITION_SOUNDS.slice(1).map(item => `#wait;${item.durationMs}`),
  );
  assert.equal(result[8].ScriptKr, "#battleend\nback");
  assert.equal(result.indexOf(postBattleChoice), 9);
  assert.deepEqual(content, [row(11020, "front one"), row(11020, "front two"), row(11025, "back"), postBattleChoice]);
});

test("does not add a transition when an episode has no post-battle story", () => {
  const content = [row(11000, "prologue")];
  assert.equal(insertMainStoryBattleTransition(content, {
    frontGroupIds: ["11000"],
    backGroupIds: [],
  }), content);
});

test("uses a recovered hidden prologue battle partition and hides the final actor", () => {
  const content = [
    row(11000, "3;유우카;01;좋아, 그럼 가 보자고!"),
    row(11001, "#wait;1500"),
    row(11001, "1;스즈미;02;전투가 쉬웠습니다"),
  ];
  const result = insertMainStoryBattleTransition(content, {
    frontGroupIds: ["11000"],
    backGroupIds: ["11001"],
  });

  assert.equal(result.length, 9);
  assert.equal(result[1].ScriptKr, "#all;hide\n#battle;2050");
  assert.doesNotMatch(result[1].ScriptKr, /#hidemenu/iu);
  assert.deepEqual(
    result.slice(1, 7).map(item => item.Sound),
    MAIN_STORY_BATTLE_TRANSITION_SOUNDS.map(item => item.sound),
  );
  assert.equal(result[7].ScriptKr, "#battleend\n#wait;1500");
});
