import assert from "node:assert/strict";
import test from "node:test";

import {
  findMainStoryEpisode,
  mainStorySeriesKey,
  parseMainStoryEpisodes,
} from "./main-story-modes.mjs";

const payload = [
  { Bytes: {
    ModeId: 11020, ModeType: "Main", VolumeId: 1, ChapterId: 1, EpisodeId: 2,
    Open: true, Hide: false, FrontScenarioGroupId: [11020], BackScenarioGroupId: [11025],
  } },
  { Bytes: {
    ModeId: 10000, ModeType: "Prologue", VolumeId: 1, ChapterId: 1, EpisodeId: 1,
    Open: true, Hide: false, FrontScenarioGroupId: [11000, 11001], BackScenarioGroupId: [],
  } },
  { Bytes: {
    ModeId: 99999, ModeType: "Event", VolumeId: 0, ChapterId: 0, EpisodeId: 1,
    Open: true, Hide: false, FrontScenarioGroupId: [99999], BackScenarioGroupId: [],
  } },
];

test("maps main and prologue modes to canonical player stories", () => {
  const episodes = parseMainStoryEpisodes(payload);
  assert.deepEqual(episodes.map(item => item.storyId), ["11000", "11020"]);
  assert.deepEqual(episodes[0].groupIds, ["11000", "11001"]);
  assert.deepEqual(episodes[1].groupIds, ["11020", "11025"]);
  assert.equal(mainStorySeriesKey(episodes[0]), "prologue");
  assert.equal(mainStorySeriesKey(episodes[1]), "1:1");
});

test("rejects importing a battle-tail group as its own main story", () => {
  const episodes = parseMainStoryEpisodes(payload);
  assert.throws(() => findMainStoryEpisode(episodes, "11025"), /import 11020 instead/u);
  assert.equal(findMainStoryEpisode(episodes, "11020")?.storyId, "11020");
  assert.equal(findMainStoryEpisode(episodes, "77777"), null);
});
