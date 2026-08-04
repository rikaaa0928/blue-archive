const flatStoryTypes = new Set(["main", "other"]);
const nestedStoryTypes = new Set(["favor", "event", "group", "mini", "ai"]);
const allStoryTypesPattern =
  "main|favor|event|group|mini|other|ai";

function buildResult(type, id, explicitDirectoryId = "") {
  const normalizedType = type.toLowerCase();
  if (flatStoryTypes.has(normalizedType)) {
    if (explicitDirectoryId) {
      throw new Error(`${normalizedType} stories do not use a directory id`);
    }
    return {
      storyPath: `${normalizedType}Story/${id}`,
      type: normalizedType,
      directoryId: "",
      id,
    };
  }
  if (!nestedStoryTypes.has(normalizedType)) {
    throw new Error(`Unsupported story type: ${type}`);
  }
  return {
    storyPath: `${normalizedType}Story/${id}`,
    type: normalizedType,
    directoryId: explicitDirectoryId || id.slice(0, 5),
    id,
  };
}

export function normalizeStoryPath(rawStoryPath) {
  const normalized = String(rawStoryPath ?? "")
    .replaceAll("\\", "/")
    .replace(/\/+$/u, "");

  const publicStoryMatch = normalized.match(
    new RegExp(
      `(?:^|/)public/story/(${allStoryTypesPattern})/` +
      `(?:(?:([^/]+)/)?([^/]+)\\.json)$`,
      "iu",
    ),
  );
  if (publicStoryMatch) {
    const [, type, directoryId = "", id] = publicStoryMatch;
    const isFlat = flatStoryTypes.has(type.toLowerCase());
    return buildResult(type, id, isFlat ? "" : directoryId);
  }

  const storyPathMatch = normalized.match(
    new RegExp(
      `^(${allStoryTypesPattern})(?:Story)?/` +
      `(?:([^/]+)/)?([^/]+)$`,
      "iu",
    ),
  );
  if (!storyPathMatch) {
    throw new Error(
      "Story must look like eventStory/10014005, " +
      "eventStory/10014/10014005, or " +
      "public/story/event/10014/10014005.json",
    );
  }

  const [, type, firstSegment = "", lastSegment] = storyPathMatch;
  const isFlat = flatStoryTypes.has(type.toLowerCase());
  if (isFlat && firstSegment) {
    throw new Error(`${type} stories do not use a directory id`);
  }
  return buildResult(type, lastSegment, firstSegment);
}
