import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPlayerFamilyNameMap,
  buildTraditionalToSimplifiedCharacterNameMap,
} from "./ba-character-catalog.mjs";
import {
  convertTextTwToTextCnWithMappedNames,
  fillMissingTextCnFromTextTw,
  normalizeExistingTextCnCharacterNames,
  normalizeTextCnCharacterNames,
} from "./fill-text-cn-from-tw.mjs";

test("protects mapped names while OpenCC converts surrounding text", () => {
  const mappings = new Map([
    ["名稱", "专名甲"],
    ["千紗", "千纱"],
  ]);

  assert.equal(
    convertTextTwToTextCnWithMappedNames(
      "名稱和千紗在學園裡等待。",
      mappings,
    ),
    "专名甲和千纱在学园里等待。",
  );
});

test("matches longer mapped names before their shorter prefixes", () => {
  const mappings = new Map([
    ["千紗", "千纱"],
    ["千紗&夏", "千纱&夏"],
  ]);

  assert.equal(
    convertTextTwToTextCnWithMappedNames(
      "千紗&夏找到了千紗。",
      mappings,
    ),
    "千纱&夏找到了千纱。",
  );
});

test("builds mappings from GL names and canonical simplified names", () => {
  const mappings = buildTraditionalToSimplifiedCharacterNameMap(
    [{
      CharacterName: 1,
      NameTW: "日步美",
      NicknameTW: "補課部",
      SmallPortrait: "Student_Portrait_Hihumi",
    }],
    [{
      CharacterName: 1,
      NameCN: "日富美",
      NicknameCN: "补习部",
    }],
  );

  assert.deepEqual(
    [...mappings],
    [["日步美", "日富美"], ["補課部", "补习部"]],
  );
});

test("skips ambiguous names instead of guessing from text alone", () => {
  const mappings = buildTraditionalToSimplifiedCharacterNameMap(
    [
      {
        CharacterName: 1,
        NameTW: "同名",
        SmallPortrait: "NPC_Portrait_A",
      },
      {
        CharacterName: 2,
        NameTW: "同名",
        SmallPortrait: "NPC_Portrait_B",
      },
    ],
    [
      { CharacterName: 1, NameCN: "名字甲" },
      { CharacterName: 2, NameCN: "名字乙" },
    ],
  );

  assert.equal(mappings.has("同名"), false);
});

test("skips one-character names that collide with ordinary prose", () => {
  const mappings = buildTraditionalToSimplifiedCharacterNameMap(
    [{
      CharacterName: 1,
      NameTW: "步",
      SmallPortrait: "Student_Portrait_Ayumu",
    }],
    [{ CharacterName: 1, NameCN: "步梦" }],
  );
  assert.equal(mappings.has("步"), false);
});

test("excludes stage labels without a visual character identity", () => {
  const mappings = buildTraditionalToSimplifiedCharacterNameMap(
    [{
      CharacterName: 1,
      NameTW: "老師",
      SmallPortrait: "NPC_Portrait_Null",
      SpinePrefabName: "",
    }],
    [{ CharacterName: 1, NameCN: "先生" }],
  );

  assert.equal(mappings.has("老師"), false);
});

test("normalizes names in an existing curated simplified translation", () => {
  assert.equal(
    normalizeTextCnCharacterNames(
      "终于找到杏山千纱了！",
      "終於找到杏山千紗了！",
      new Map([["千紗", "和纱"]]),
    ),
    "终于找到杏山和纱了！",
  );
});

test("builds deterministic player family-name mappings", () => {
  const mappings = buildPlayerFamilyNameMap([
    {
      familyName: { jp: "宇沢", tw: "宇沢", cn: "宇泽" },
    },
    {
      familyName: { jp: "杏山", tw: "杏山", cn: "杏山" },
    },
  ]);
  assert.equal(mappings.get("宇沢"), "宇泽");
  assert.equal(mappings.get("杏山"), "杏山");
});

test("normalizes family and personal names before LLM proofreading", () => {
  const content = [{
    TextJp: "宇沢レイサです。",
    TextTw: "宇沢澪紗。",
    TextCn: "宇沢玲纱。",
  }];
  const result = normalizeExistingTextCnCharacterNames(
    content,
    new Map([["宇沢", "宇泽"], ["澪紗", "玲纱"]]),
  );
  assert.equal(content[0].TextCn, "宇泽玲纱。");
  assert.equal(result.changedRows, 1);
});

test("explicit refresh mode rebuilds existing OpenCC text", () => {
  const content = [{
    TextTw: "宇沢澪紗發出了挑戰。",
    TextCn: "宇沢澪纱发出了挑战。",
  }];
  const stats = fillMissingTextCnFromTextTw(
    content,
    new Map([["澪紗", "玲纱"]]),
    { refreshExisting: true },
  );

  assert.equal(content[0].TextCn, "宇沢玲纱发出了挑战。");
  assert.equal(stats.refreshedExisting, 1);
});
