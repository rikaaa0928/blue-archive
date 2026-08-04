export function parseScenarioScriptSpeakers(unitOrScript) {
  const script = typeof unitOrScript === "string"
    ? unitOrScript
    : String(unitOrScript?.ScriptKr ?? "");
  const speakers = [];
  let dialogueSpeaker = "";

  for (const rawLine of script.split("\n")) {
    const line = rawLine.trim();
    const characterMatch =
      /^(?!#)([1-5]);([^;\n]+);([^;\n]+);?([^;\n]+)?/u.exec(line);
    if (characterMatch) {
      const speaker = characterMatch[2];
      if (!speakers.includes(speaker)) {
        speakers.push(speaker);
      }
      if (characterMatch[4]?.trim()) {
        dialogueSpeaker = speaker;
      }
      continue;
    }

    const narrationMatch = /^#na;([^;\n]+);?([^;\n]+)?;?/iu.exec(line);
    if (narrationMatch) {
      const speaker = narrationMatch[1];
      if (!speakers.includes(speaker)) {
        speakers.push(speaker);
      }
      if (narrationMatch[2]?.trim()) {
        dialogueSpeaker = speaker;
      }
    }
  }

  return { speakers, dialogueSpeaker };
}

export function inferScenarioRole(unitOrScript) {
  const script = typeof unitOrScript === "string"
    ? unitOrScript
    : String(unitOrScript?.ScriptKr ?? "");
  if (/(?:^|\n)\[n?s\d{0,2}\]/iu.test(script)) return "option";
  if (/#title/iu.test(script)) return "title";
  if (/#place/iu.test(script)) return "place";
  if (/#na/iu.test(script)) return "narration";
  if (/^(?!#)[1-5];/mu.test(script)) return "dialogue";
  return "text";
}

export function isUnknownScenarioSpeaker(speaker) {
  const normalized = String(speaker ?? "")
    .normalize("NFKC")
    .replace(/\s+/gu, "");
  return /^\?{2,}$/u.test(normalized);
}

export function isAnonymousScenarioSpeaker(speaker) {
  const normalized = String(speaker ?? "")
    .normalize("NFKC")
    .replace(/\s+/gu, "");
  return isUnknownScenarioSpeaker(normalized) ||
    /스케반/u.test(normalized) ||
    /학생/u.test(normalized) ||
    /부원/u.test(normalized) ||
    /모브/u.test(normalized) ||
    /시민/u.test(normalized) ||
    /불량배/u.test(normalized);
}
