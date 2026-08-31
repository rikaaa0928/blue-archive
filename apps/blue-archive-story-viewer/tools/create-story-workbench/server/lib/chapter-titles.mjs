const languageFields = ["TextJp", "TextCn", "TextTw", "TextKr", "TextEn", "TextTh"];

function clean(value) {
  return String(value ?? "").trim();
}

export function hasLocalizedTitle(title) {
  return languageFields.some(field => clean(title?.[field]));
}

function chapterPart(value) {
  const parts = clean(value).split(";").map(clean).filter(Boolean);
  return parts.at(-1) ?? "";
}

export function extractStoryTitle(story) {
  const titleRow = story?.content?.find(unit => /(?:^|\n)#title(?:;|$)/u.test(String(unit?.ScriptKr ?? "")));
  if (!titleRow) return {};
  const scriptTitle = String(titleRow.ScriptKr ?? "").split("\n")
    .find(line => line.startsWith("#title"));
  return Object.fromEntries(languageFields
    .map(field => [field, field === "TextKr"
      ? chapterPart(String(scriptTitle ?? "").replace(/^#title;?/u, ""))
      : chapterPart(titleRow[field])])
    .filter(([, value]) => value));
}

function appendPart(title, part) {
  return Object.fromEntries([
    ...Object.entries(title ?? {}).filter(([key]) => key !== "fallback"),
    ...languageFields
      .filter(field => clean(title?.[field]))
      .map(field => [field, `${clean(title[field])} (${part})`]),
  ]);
}

export function applyContinuationTitles(chapters) {
  let anchor = null;
  let continuationIndex = 0;
  return chapters.map(chapter => {
    const rawTitle = { ...(chapter.title ?? {}) };
    if (hasLocalizedTitle(rawTitle)) {
      anchor = rawTitle;
      continuationIndex = 1;
      return {
        ...chapter,
        title: rawTitle,
        rawTitle,
        titleInherited: false,
        continuationIndex: 1,
      };
    }
    if (!anchor) {
      return {
        ...chapter,
        title: rawTitle,
        rawTitle,
        titleInherited: false,
        continuationIndex: null,
      };
    }
    continuationIndex += 1;
    return {
      ...chapter,
      title: {
        ...appendPart(anchor, continuationIndex),
        fallback: `${anchor.fallback || chapter.title?.fallback || "未命名章节"} (${continuationIndex})`,
      },
      rawTitle,
      titleInherited: true,
      continuationIndex,
    };
  });
}

export function localizedTitleText(title, preferred = ["TextCn", "TextJp", "TextTw", "TextKr", "TextEn"]) {
  for (const field of preferred) {
    const value = clean(title?.[field]);
    if (value) return value;
  }
  return clean(title?.fallback) || "（未命名）";
}
