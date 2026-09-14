import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildGeneratedMainStoryIndex } from "./generate-main-story-index.mjs";

test("indexes only materialized main stories and links playable neighbors", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "main-story-index-"));
  try {
    fs.writeFileSync(path.join(root, "11010.json"), JSON.stringify({ content: [{
      ScriptKr: "#title;제1화;대책위원회의 기묘한 하루",
      TextJp: "第1話;対策委員会の奇妙な一日",
      TextCn: "第1话;对策委员会奇妙的一天",
    }] }));
    fs.writeFileSync(path.join(root, "11030.json"), JSON.stringify({ content: [] }));
    const episodes = [
      { storyId: "11010", modeType: "Main", volumeId: 1, chapterId: 1, episodeId: 1 },
      { storyId: "11020", modeType: "Main", volumeId: 1, chapterId: 1, episodeId: 2 },
      { storyId: "11030", modeType: "Main", volumeId: 1, chapterId: 1, episodeId: 3 },
    ];
    const generated = buildGeneratedMainStoryIndex({ episodes, storyRoot: root });
    assert.equal(generated.length, 1);
    assert.deepEqual(generated[0].sections.map(section => section.story_id), [11010, 11030]);
    assert.equal(generated[0].sections[0].title.TextCn, "对策委员会奇妙的一天");
    assert.equal(generated[0].sections[0].next, 11030);
    assert.equal(generated[0].sections[1].previous, 11010);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
