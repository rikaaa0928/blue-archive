import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildPrompt,
  proofreadStoryTextCnWithLlm,
  validateProofreadBatch,
} from "./proofread-text-cn-with-llm.mjs";

const batch = [
  {
    index: 12,
    textCn: "千，和纱酱！？\n我们只是想要……！",
  },
  {
    index: 18,
    textCn: "[s1]第一项[/s]\n[ruby=きょうやま]杏山[/ruby]和纱",
  },
];

test("accepts a contextual name-fragment correction with structure intact", () => {
  const items = validateProofreadBatch({
    items: [
      {
        index: 12,
        TextCn: "和，和纱酱！？\n我们只是想要……！",
        issueTypes: ["character-name consistency"],
        rationale: "The repeated fragment belongs to the same character name.",
      },
      {
        index: 18,
        TextCn: batch[1].textCn,
        issueTypes: [],
        rationale: "",
      },
    ],
  }, batch);

  assert.equal(items[0].TextCn, "和，和纱酱！？\n我们只是想要……！");
});

test("rejects a response that omits a target row", () => {
  assert.throws(
    () => validateProofreadBatch({ items: [] }, batch),
    /Expected 2 items/u,
  );
});

test("rejects changed line breaks", () => {
  assert.throws(
    () => validateProofreadBatch({
      items: [
        {
          index: 12,
          TextCn: "和，和纱酱！？我们只是想要……！",
          issueTypes: ["character-name consistency"],
          rationale: "",
        },
        {
          index: 18,
          TextCn: batch[1].textCn,
          issueTypes: [],
          rationale: "",
        },
      ],
    }, batch),
    /Line-break count changed/u,
  );
});

test("rejects changed player markup", () => {
  assert.throws(
    () => validateProofreadBatch({
      items: [
        {
          index: 12,
          TextCn: batch[0].textCn,
          issueTypes: [],
          rationale: "",
        },
        {
          index: 18,
          TextCn: "第一项\n杏山和纱",
          issueTypes: ["formatting"],
          rationale: "",
        },
      ],
    }, batch),
    /Player markup changed/u,
  );
});

test("exposes current TextCn only on target rows, not story context", () => {
  const prompt = JSON.parse(buildPrompt({
    story: { GroupId: 1, translator: "source" },
    textUnits: [{
      index: 12,
      role: "dialogue",
      speaker: "speaker",
      textJp: "日本語",
      textTw: "繁中",
      textCn: "可能有误的简中",
      scriptKr: "speaker;dialogue",
    }],
    glossary: {},
    batch: [{
      index: 12,
      role: "dialogue",
      speaker: "speaker",
      textJp: "日本語",
      textTw: "繁中",
      textCn: "可能有误的简中",
      scriptKr: "speaker;dialogue",
    }],
    context: [{
      index: 12,
      role: "dialogue",
      speaker: "speaker",
      TextJp: "日本語",
      TextTw: "繁中",
      isTarget: true,
    }],
  }));
  assert.equal("currentTextCn" in prompt.globalStoryOutline[0], false);
  assert.equal("currentTextCn" in prompt.localContext[0], false);
  assert.equal(prompt.targetLines[0].currentTextCn, "可能有误的简中");
});

test("rejects punctuation style normalization", () => {
  assert.throws(
    () => validateProofreadBatch({
      items: [
        {
          index: 12,
          TextCn: "凯茜·帕鲁格！？\n我们只是想要……！",
          issueTypes: ["punctuation"],
          rationale: "",
        },
        {
          index: 18,
          TextCn: "[s1]第一项[/s]\n[ruby=きょうやま]杏山[/ruby]和纱",
          issueTypes: [],
          rationale: "",
        },
      ],
    }, [
      { index: 12, textCn: "凯茜．帕鲁格！？\n我们只是想要……！" },
      {
        index: 18,
        textCn: "[s1]第一项[/s]\n[ruby=きょうやま]杏山[/ruby]和纱",
      },
    ]),
    /Punctuation style changed/u,
  );
});

test("runs two independent proofreading passes by default", async () => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cn-proofread-test-"));
  const seenPrompts = [];
  const ai = {
    models: {
      async generateContent(request) {
        seenPrompts.push(request.contents);
        const currentTextCn = JSON.parse(request.contents)
          .targetLines[0].currentTextCn;
        return {
          text: JSON.stringify({
            items: [{
              index: 0,
              TextCn: currentTextCn === "他来了。" ? "她来了。" : currentTextCn,
              issueTypes: currentTextCn === "他来了。" ? ["wrong pronoun"] : [],
              rationale: currentTextCn === "他来了。" ? "指代女性学生。" : "",
            }],
          }),
        };
      },
    },
  };
  const Type = {
    OBJECT: "OBJECT",
    ARRAY: "ARRAY",
    INTEGER: "INTEGER",
    STRING: "STRING",
  };
  const story = {
    GroupId: 1,
    proofreader: "",
    content: [{
      TextJp: "彼女が来た。",
      TextTw: "他來了。",
      TextCn: "他来了。",
      ScriptKr: "",
    }],
  };
  try {
    const result = await proofreadStoryTextCnWithLlm(story, {
      ai,
      Type,
      characterNameMappings: new Map(),
      cacheRoot,
      refreshCache: true,
      logger: { log() {}, warn() {} },
    });
    assert.equal(seenPrompts.length, 2);
    assert.match(seenPrompts[0], /"currentTextCn": "他来了。"/u);
    assert.match(seenPrompts[1], /"currentTextCn": "她来了。"/u);
    assert.equal(story.content[0].TextCn, "她来了。");
    assert.equal(result.passes, 2);
    assert.equal(result.netChanges.length, 1);
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
});
