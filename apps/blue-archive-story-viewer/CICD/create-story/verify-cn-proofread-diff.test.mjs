import assert from "node:assert/strict";
import test from "node:test";

import { verifyCnProofreadDiff } from "./verify-cn-proofread-diff.mjs";

const original = {
  GroupId: 10014005,
  translator: "source",
  proofreader: "old",
  content: [
    { TextJp: "原文", TextCn: "旧译", VoiceJp: "voice.mp3" },
  ],
};

test("allows only TextCn and proofreader changes", () => {
  const changed = structuredClone(original);
  changed.proofreader = "old + Gemini review";
  changed.content[0].TextCn = "新译";
  const result = verifyCnProofreadDiff(original, changed);
  assert.equal(result.textCnChanges.length, 1);
  assert.equal(result.proofreaderChanged, true);
});

test("rejects any other content field change", () => {
  const changed = structuredClone(original);
  changed.content[0].VoiceJp = "wrong.mp3";
  assert.throws(
    () => verifyCnProofreadDiff(original, changed),
    /content\[0\]\.VoiceJp changed/u,
  );
});

test("rejects row insertion even when existing rows are unchanged", () => {
  const changed = structuredClone(original);
  changed.content.push({ TextCn: "extra" });
  assert.throws(
    () => verifyCnProofreadDiff(original, changed),
    /content length changed/u,
  );
});

test("rejects any other top-level field change", () => {
  const changed = structuredClone(original);
  changed.translator = "different";
  assert.throws(
    () => verifyCnProofreadDiff(original, changed),
    /top-level field changed: translator/u,
  );
});
