import assert from "node:assert/strict";
import test from "node:test";

import { resolveLocalL2dSpineFallback } from "./localL2dResources.ts";

test("provides a local fallback for the SC11000 dynamic background", () => {
  assert.deepEqual(
    resolveLocalL2dSpineFallback(
      "UIs/03_Scenario/01_Background/SpineBG_SC11000_01",
      "https://story.example/resources/"
    ),
    {
      url: "https://story.example/resources/spine/spinebg/SC11000_01.skel",
      name: "SC11000_01",
    }
  );
});

test("leaves backgrounds without a local asset on the existing CDN route", () => {
  assert.equal(
    resolveLocalL2dSpineFallback(
      "UIs/03_Scenario/01_Background/SpineBG_LobbyHoshino",
      "https://story.example/resources"
    ),
    undefined
  );
});
