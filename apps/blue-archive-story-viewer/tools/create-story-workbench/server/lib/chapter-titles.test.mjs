import assert from "node:assert/strict";
import test from "node:test";

import { applyContinuationTitles, extractStoryTitle, localizedTitleText } from "./chapter-titles.mjs";

test("inherits a missing chapter title and numbers consecutive continuations", () => {
  const chapters = applyContinuationTitles([
    { storyId: "1", title: { TextJp: "夏の海", TextCn: "夏日海边", fallback: "第 1 话" } },
    { storyId: "2", title: { fallback: "第 2 话" } },
    { storyId: "3", title: { fallback: "第 3 话" } },
    { storyId: "4", title: { TextJp: "帰り道", TextCn: "归途", fallback: "第 4 话" } },
    { storyId: "5", title: { fallback: "第 5 话" } },
  ]);
  assert.equal(chapters[0].titleInherited, false);
  assert.equal(chapters[1].title.TextCn, "夏日海边 (2)");
  assert.equal(chapters[2].title.TextJp, "夏の海 (3)");
  assert.equal(chapters[3].continuationIndex, 1);
  assert.equal(chapters[4].title.TextCn, "归途 (2)");
});

test("does not invent a continuation before the first explicit title", () => {
  const [chapter] = applyContinuationTitles([{ storyId: "1", title: { fallback: "第 1 话" } }]);
  assert.equal(chapter.titleInherited, false);
  assert.equal(localizedTitleText(chapter.title), "第 1 话");
});

test("extracts the actual chapter title from a story title row", () => {
  assert.deepEqual(extractStoryTitle({ content: [{
    ScriptKr: "#title;프롤로그;여름 바다의 소녀들",
    TextJp: "プロローグ;夏の海と少女たち",
    TextCn: "序幕;夏日海边的少女们",
    TextTw: "序幕;夏日海邊的少女們",
  }] }), {
    TextJp: "夏の海と少女たち",
    TextCn: "夏日海边的少女们",
    TextTw: "夏日海邊的少女們",
    TextKr: "여름 바다의 소녀들",
  });
});
