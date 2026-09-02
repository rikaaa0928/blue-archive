import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveCharacterImageReferences } from "./character-image-resources.mjs";

test("falls back to the default portrait when a setting sheet is absent", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "character-images-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const portraits = path.join(root, "日富美(泳装)", "立绘");
  fs.mkdirSync(portraits, { recursive: true });
  fs.writeFileSync(path.join(portraits, "立绘.png"), "portrait");
  const result = resolveCharacterImageReferences(root, "日富美(泳装)");
  assert.equal(result.settingPath, null);
  assert.equal(result.primaryPath, path.join(portraits, "立绘.png"));
  assert.equal(result.primaryKind, "default-portrait");
});

test("prefers a setting sheet over portraits and supports non-PNG images", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "character-images-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "日富美");
  fs.mkdirSync(path.join(directory, "立绘"), { recursive: true });
  fs.writeFileSync(path.join(directory, "立绘", "立绘.webp"), "portrait");
  fs.writeFileSync(path.join(directory, "设定集.jpg"), "setting");
  const result = resolveCharacterImageReferences(root, "日富美");
  assert.equal(result.primaryPath, path.join(directory, "设定集.jpg"));
  assert.equal(result.primaryKind, "setting-sheet");
});
