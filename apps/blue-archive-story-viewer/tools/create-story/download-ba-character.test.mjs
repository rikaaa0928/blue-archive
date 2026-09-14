import assert from "node:assert/strict";
import test from "node:test";

import {
  extractIllustratedBookVoiceLines,
  extractVoiceLines,
} from "./download-ba-character.mjs";

function editor(...paragraphs) {
  return {
    type: "simpleEditor",
    data: paragraphs.map(text => ({
      type: "paragraph",
      children: [{ text }],
    })),
  };
}

function audioSection() {
  return {
    type: "audio-info",
    data: {
      title: "角色台词及语音",
      tabs: [
        { key: "jp", label: "日配" },
        { key: "old-jp", label: "旧版日配" },
        { key: "cn", label: "国配" },
      ],
      list: [
        {
          filterTabKey: "jp",
          title: "通常",
          content: [
            {
              key: "current",
              audio: "//example.test/current.ogg",
              name: editor("日程进入1"),
              desc: editor(
                "ここでは先生がスケジュールを決められます！",
                "老师能在这里决定日程！",
              ),
            },
          ],
        },
        {
          filterTabKey: "old-jp",
          title: "通常",
          content: [{
            key: "old",
            audio: "//example.test/old.ogg",
            name: editor("旧版"),
            desc: editor("古い音声です。"),
          }],
        },
      ],
    },
  };
}

test("extracts current Japanese illustrated-book audio and separates translations", () => {
  const lines = extractIllustratedBookVoiceLines([{
    type: "illustrated-book",
    data: [audioSection()],
  }]);

  assert.deepEqual(lines, [{
    category: "通常",
    name: "日程进入1",
    textJp: "ここでは先生がスケジュールを決められます！",
    textCn: "老师能在这里决定日程！",
    textCnDub: "",
    audioJp: "//example.test/current.ogg",
    audioCn: "",
    audioKr: "",
  }]);
});

test("deduplicates repeated illustrated-book audio sections by audio URL", () => {
  const section = audioSection();
  const outerSection = structuredClone(section);
  outerSection.data.list[0].content[0].desc = "";
  const content = [
    {
      type: "illustrated-book",
      data: [{
        ...outerSection,
        nested: structuredClone(section),
      }],
    },
  ];

  assert.equal(extractVoiceLines(content).length, 1);
});

test("keeps the legacy baseData voice parser", () => {
  const cell = (value, type = "text", extra = {}) => ({ value, type, ...extra });
  const baseData = [
    [cell("配音语言", "text", { isGlobal: true })],
    [],
    [
      cell("通常", "text", { isGlobal: true }),
      cell("登录"),
      cell("こんにちは"),
      cell("你好"),
      cell("//example.test/legacy.ogg", "audio"),
    ],
  ];

  assert.equal(
    extractVoiceLines({ baseData })[0].audioJp,
    "//example.test/legacy.ogg",
  );
});
