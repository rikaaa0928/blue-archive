export function parseRecordingOptions(value) {
  return String(value ?? "").split("\n").flatMap(line => {
    const match = /^\s*\[n?s(\d{0,2})?\]\s*(.+?)\s*$/u.exec(line);
    return match ? [{
      selectionGroup: Number(match[1] || "0"),
      text: match[2],
    }] : [];
  });
}

export function findRecordingOptionPages(content) {
  return content.flatMap((unit, storyIndex) => {
    const sourceOptions = parseRecordingOptions(unit.ScriptKr);
    if (!sourceOptions.length) return [];
    const translatedOptions = new Map(
      parseRecordingOptions(unit.TextCn).map(option => [option.selectionGroup, option.text]),
    );
    return [{
      storyIndex,
      options: sourceOptions.map(option => ({
        ...option,
        textCn: translatedOptions.get(option.selectionGroup) || option.text,
      })),
    }];
  });
}

export function resolveRecordingSelections(content, requestedSelections) {
  const requested = new Map();
  for (const selection of requestedSelections) {
    const storyIndex = Number(selection.storyIndex);
    const selectionGroup = Number(selection.selectionGroup);
    if (!Number.isInteger(storyIndex) || !Number.isInteger(selectionGroup)) {
      throw new Error("Recording selections require integer storyIndex and selectionGroup values");
    }
    if (requested.has(storyIndex)) {
      throw new Error(`Duplicate recording selection for story index ${storyIndex}`);
    }
    requested.set(storyIndex, selectionGroup);
  }

  const pages = findRecordingOptionPages(content);
  const pageIndices = new Set(pages.map(page => page.storyIndex));
  const unexpected = [...requested.keys()].filter(index => !pageIndices.has(index));
  if (unexpected.length) {
    throw new Error(`Recording selections reference non-choice rows: ${unexpected.join(", ")}`);
  }

  return pages.map(page => {
    const selectionGroup = page.options.length === 1
      ? page.options[0].selectionGroup
      : requested.get(page.storyIndex);
    if (selectionGroup === undefined) {
      const groups = page.options.map(option => option.selectionGroup).join(", ");
      throw new Error(
        `Missing recording default at story index ${page.storyIndex}; ` +
        `choose one SelectionGroup from: ${groups}`,
      );
    }
    if (!page.options.some(option => option.selectionGroup === selectionGroup)) {
      const groups = page.options.map(option => option.selectionGroup).join(", ");
      throw new Error(
        `Invalid recording default ${selectionGroup} at story index ${page.storyIndex}; ` +
        `expected one of: ${groups}`,
      );
    }
    return { storyIndex: page.storyIndex, selectionGroup };
  });
}

export function validateRecordingSelections(content, selections) {
  const resolved = resolveRecordingSelections(content, selections);
  if (JSON.stringify(resolved) !== JSON.stringify(selections)) {
    throw new Error(
      "Recording defaults are incomplete or not normalized; " +
      "run preselect-options.mjs with every multi-choice default first",
    );
  }
  return resolved;
}
