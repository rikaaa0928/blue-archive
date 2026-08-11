import assert from "node:assert/strict";
import test from "node:test";
import {
  assertNoAmbiguousUnannotatedRuby,
  collectRubyMappings,
  replaceRubySurfaceTextWithReading,
  replaceRubySurfaceTextWithReadings,
  replaceRubyWithReading,
  scanRubyMappings,
} from "./tts-text-normalization.mjs";

test("replaces ruby surface text with its reading before TTS enrichment", () => {
  assert.equal(
    replaceRubyWithReading(
      "ついに見つけた！もう逃げられませんよ、[ruby=きょうやま]杏山[/ruby]カズサ！！！",
    ),
    "ついに見つけた！もう逃げられませんよ、きょうやまカズサ！！！",
  );
});

test("replaces every ruby annotation and preserves surrounding text", () => {
  assert.equal(
    replaceRubyWithReading(
      "[ruby=うざわ]宇沢[/ruby]レイサと[ruby=きょうやま]杏山[/ruby]カズサ",
    ),
    "うざわレイサときょうやまカズサ",
  );
});

test("preserves text without ruby annotations", () => {
  assert.equal(
    replaceRubyWithReading("今日はいい天気ですね。"),
    "今日はいい天気ですね。",
  );
});

test("preserves malformed ruby annotations instead of dropping text", () => {
  assert.equal(
    replaceRubyWithReading("[ruby=きょうやま]杏山カズサ"),
    "[ruby=きょうやま]杏山カズサ",
  );
});

test("uses source ruby mappings when the voice text contains bare kanji", () => {
  assert.equal(
    replaceRubySurfaceTextWithReading(
      "[excited]ついに見つけた！杏山カズサ！",
      "ついに見つけた！[ruby=きょうやま]杏山[/ruby]カズサ！",
    ),
    "[excited]ついに見つけた！きょうやまカズサ！",
  );
});

test("leaves an already normalized voice line unchanged", () => {
  assert.equal(
    replaceRubySurfaceTextWithReading(
      "きょうやまカズサです。",
      "[ruby=きょうやま]杏山[/ruby]カズサです。",
    ),
    "きょうやまカズサです。",
  );
});

test("applies ruby mappings collected from other lines in the same story", () => {
  const mappings = collectRubyMappings([
    "悪党、[ruby=きょうやま]杏山[/ruby]カズサに捕まっていた方ですね？",
    "どうも、杏山カズサさんに関して、少し誤解があるようで……",
  ]);
  assert.deepEqual(mappings, [
    { surfaceText: "杏山", reading: "きょうやま" },
  ]);
  assert.equal(
    replaceRubySurfaceTextWithReadings(
      "[hesitant]どうも、杏山カズサさんに関して、少し誤解があるようで……",
      mappings,
    ),
    "[hesitant]どうも、きょうやまカズサさんに関して、少し誤解があるようで……",
  );
});

test("allows conflicting readings when every occurrence is explicitly tagged", () => {
  assert.deepEqual(
    scanRubyMappings([
      "[ruby=こうざん]杏山[/ruby]",
      "[ruby=きょうやま]杏山[/ruby]",
    ]),
    {
      annotationCount: 2,
      mappings: [],
      conflicts: [
        {
          surfaceText: "杏山",
          readings: ["きょうやま", "こうざん"],
          unannotatedIndices: [],
        },
      ],
    },
  );
});

test("rejects a bare occurrence when the same surface has conflicting readings", () => {
  const scan = scanRubyMappings([
    "[ruby=りくわかく]六和閣[/ruby]",
    "[ruby=ここ]六和閣[/ruby]",
    "六和閣へようこそ",
  ]);
  assert.deepEqual(scan.conflicts, [
    {
      surfaceText: "六和閣",
      readings: ["ここ", "りくわかく"],
      unannotatedIndices: [2],
    },
  ]);
  assert.throws(
    () => assertNoAmbiguousUnannotatedRuby(scan, "event/10014/example.json"),
    /manual resolution required:[\s\S]*六和閣[\s\S]*content indices 2/,
  );
});
