export const MAIN_STORY_BATTLE_TRANSITION_SOUNDS = Object.freeze([
  { sound: "SE_Shot_01", durationMs: 2050 },
  { sound: "SE_Shot_02", durationMs: 1700 },
  { sound: "SE_Shot_02a", durationMs: 2050 },
  { sound: "SE_SMG_01a", durationMs: 1300 },
  { sound: "SE_ShotShothgun_01", durationMs: 1450 },
  { sound: "SE_ShotShothgun_02", durationMs: 1300 },
]);

function battleTransitionRows(groupId) {
  return MAIN_STORY_BATTLE_TRANSITION_SOUNDS.map(({ sound, durationMs }, index) => ({
    GroupId: Number(groupId),
    SelectionGroup: 0,
    BGMId: 0,
    Sound: sound,
    Transition: 0,
    BGName: 0,
    BGEffect: 0,
    PopupFileName: "",
    // The first frame clears actors, stops inherited BGM in the player, and
    // opens the black cover. Later frames retain that cover while each sound
    // gets enough time to finish before the next frame starts.
    ScriptKr: index === 0
      ? `#all;hide\n#battle;${durationMs}`
      : `#wait;${durationMs}`,
    TextJp: "",
    TextCn: "",
    TextTh: "",
    TextTw: "",
    TextEn: "",
    VoiceJp: "",
  }));
}

export function insertMainStoryBattleTransition(content, episode) {
  const backGroupIds = episode?.backGroupIds ?? [];
  if (!backGroupIds.length) return content;

  const firstBackIndex = content.findIndex(row =>
    backGroupIds.includes(String(row?.GroupId)),
  );
  if (firstBackIndex === -1) return content;

  // This runs during raw import, before Workbench creates any review, TTS, or
  // recording storyIndex values. All downstream indices therefore refer to
  // the assembled JSON and never need an after-the-fact offset adjustment.
  const result = [...content];
  const firstBackRow = {
    ...result[firstBackIndex],
    ScriptKr: `#battleend\n${result[firstBackIndex].ScriptKr || ""}`,
  };
  result.splice(
    firstBackIndex,
    1,
    ...battleTransitionRows(backGroupIds[0]),
    firstBackRow,
  );
  return result;
}
