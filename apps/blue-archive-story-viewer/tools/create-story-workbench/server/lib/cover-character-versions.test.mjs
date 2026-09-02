import assert from "node:assert/strict";
import test from "node:test";

import { characterVersionOptions, coverCharactersFromSpeakerConfigs } from "./cover-character-versions.mjs";

test("recommends a swimsuit resource version from the scenario speaker key", () => {
  const character = characterVersionOptions("日富美", ["히후미 수영복ND"]);
  assert.equal(character.selectedResourceName, "日富美(泳装)");
  assert.ok(character.options.some(option => option.resourceName === "日富美"));
  assert.ok(character.options.some(option => option.resourceName === "日富美(泳装)"));
});

test("deduplicates characters across chapter speaker configs", () => {
  const characters = coverCharactersFromSpeakerConfigs([{ items: [{
    sourceSpeaker: "히후미 수영복ND",
    resolution: { type: "character", stableKey: "히후미 수영복ND", characterName: "日富美" },
  }] }, { items: [{
    sourceSpeaker: "히후미",
    resolution: { type: "character", stableKey: "히후미", characterName: "日富美" },
  }] }]);
  assert.equal(characters.length, 1);
  assert.equal(characters[0].selectedResourceName, "日富美(泳装)");
});
