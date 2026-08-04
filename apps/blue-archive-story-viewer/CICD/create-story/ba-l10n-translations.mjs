import fs from "fs";
import path from "path";

const missingTranslationPattern = /^\[[a-z0-9_ -]+not found\]$/iu;
const selectionLinePattern = /^\s*(\[(?:n?s\d{0,2})\])\s*(.*)$/iu;
// Keeping this as one expression makes the supported ba-l10n ruby shape clear.
const htmlRubyPattern =
  // eslint-disable-next-line max-len
  /<ruby\b[^>]*>([\s\S]*?)<rp\b[^>]*>[\s\S]*?<\/rp>\s*<rt\b[^>]*>([\s\S]*?)<\/rt>\s*<rp\b[^>]*>[\s\S]*?<\/rp>\s*<\/ruby>/giu;

const targetMessageFields = {
  TextJp: ["g_ja", "j_ja"],
  TextCn: ["g_tw_cn", "c_cn"],
  TextTw: ["g_tw", "c_cn_tw"],
  TextEn: ["g_en"],
  TextTh: ["g_th"],
};

function decodeHtmlEntities(value) {
  return String(value ?? "")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, "\"")
    .replace(/&#(?:39|x27);|&apos;/giu, "'");
}

function stripTags(value) {
  return value
    .replace(/<rt\b[^>]*>[\s\S]*?<\/rt>/giu, "")
    .replace(/<rp\b[^>]*>[\s\S]*?<\/rp>/giu, "")
    .replace(/<[^>]+>/gu, "");
}

function convertRubyTags(value) {
  return value.replace(
    htmlRubyPattern,
    (_match, base, reading) =>
      `[ruby=${stripTags(reading).trim()}]${stripTags(base)}[/ruby]`,
  );
}

export function convertBaL10nText(value) {
  const decoded = decodeHtmlEntities(value).trim();
  if (!decoded || missingTranslationPattern.test(decoded)) {
    return "";
  }

  return convertRubyTags(decoded)
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<\/?span\b[^>]*>/giu, "")
    .replace(/<\/?p\b[^>]*>/giu, "\n")
    .replace(/<[^>]+>/gu, "")
    .replace(/#n/gu, "\n")
    .replace(/\r\n?/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function normalizeAlignmentText(value) {
  return stripTags(
    decodeHtmlEntities(value)
      .replace(
        /\[ruby=[^\n]*?\]([\s\S]*?)\[\/ruby\]/giu,
        "$1",
      )
      .replace(/<br\s*\/?>/giu, "\n")
      .replace(/#n/gu, "\n"),
  )
    .replace(selectionLinePattern, "$2")
    .replace(/\s+/gu, "")
    .trim();
}

function getMessageText(message, fieldNames) {
  for (const fieldName of fieldNames) {
    const value = convertBaL10nText(message?.[fieldName]);
    if (value) {
      return value;
    }
  }
  return "";
}

function buildSourceIndex(sourceRows) {
  if (!Array.isArray(sourceRows)) {
    throw new Error("ba-l10n story JSON must be an array");
  }

  const index = new Map();
  sourceRows.forEach((row, sourceIndex) => {
    if (!row || typeof row !== "object" || !row.Message) {
      return;
    }
    const keys = new Set(
      targetMessageFields.TextJp
        .map(field => normalizeAlignmentText(row.Message[field]))
        .filter(Boolean),
    );
    for (const key of keys) {
      const candidates = index.get(key) ?? [];
      candidates.push({
        row,
        sourceIndex,
        actualPos: Number(row.ActualPos ?? sourceIndex),
      });
      index.set(key, candidates);
    }
  });
  return index;
}

function createSourceMatcher(sourceRows) {
  const sourceIndex = buildSourceIndex(sourceRows);
  const usedSourceIndexes = new Set();
  let lastActualPos = -1;

  const match = text => {
    const key = normalizeAlignmentText(text);
    if (!key) {
      return undefined;
    }
    const candidates = sourceIndex.get(key) ?? [];
    const unused = candidates.filter(
      candidate => !usedSourceIndexes.has(candidate.sourceIndex),
    );
    const candidate =
      unused.find(item => item.actualPos >= lastActualPos) ??
      unused[0];
    if (!candidate) {
      return undefined;
    }
    usedSourceIndexes.add(candidate.sourceIndex);
    lastActualPos = Math.max(lastActualPos, candidate.actualPos);
    return candidate.row;
  };
  match.checkpoint = () => ({
    usedSourceIndexes: new Set(usedSourceIndexes),
    lastActualPos,
  });
  match.restore = checkpoint => {
    usedSourceIndexes.clear();
    for (const sourceIndex of checkpoint.usedSourceIndexes) {
      usedSourceIndexes.add(sourceIndex);
    }
    lastActualPos = checkpoint.lastActualPos;
  };
  return match;
}

function parseSelectionLines(text) {
  const lines = String(text ?? "").split("\n");
  if (lines.length === 0) {
    return [];
  }
  const parsed = lines.map(line => selectionLinePattern.exec(line));
  if (parsed.some(match => !match)) {
    return [];
  }
  return parsed.map(match => ({
    marker: match[1],
    text: match[2],
  }));
}

function buildTranslation(row, targetField) {
  return getMessageText(row?.Message, targetMessageFields[targetField]);
}

function fillNormalRow(viewerRow, sourceRow, stats) {
  for (const targetField of Object.keys(targetMessageFields)) {
    if (viewerRow[targetField]) {
      continue;
    }
    const translation = buildTranslation(sourceRow, targetField);
    if (!translation) {
      continue;
    }
    viewerRow[targetField] = translation;
    stats.filled[targetField]++;
  }
}

function fillSelectionRow(viewerRow, selections, matchedRows, stats) {
  for (const targetField of Object.keys(targetMessageFields)) {
    if (viewerRow[targetField]) {
      continue;
    }
    const translations = matchedRows.map((sourceRow, index) => {
      const translation = buildTranslation(sourceRow, targetField);
      return translation
        ? `${selections[index].marker}${translation}`
        : "";
    });
    if (translations.some(value => !value)) {
      continue;
    }
    viewerRow[targetField] = translations.join("\n");
    stats.filled[targetField]++;
  }
}

export function supplementMissingTranslations(content, sourceRows) {
  const matchSourceRow = createSourceMatcher(sourceRows);
  const stats = {
    sourceRows: sourceRows.length,
    viewerRows: content.length,
    textRows: 0,
    matchedRows: 0,
    unmatchedRows: [],
    filled: Object.fromEntries(
      Object.keys(targetMessageFields).map(field => [field, 0]),
    ),
  };

  content.forEach((viewerRow, viewerIndex) => {
    if (!viewerRow?.TextJp) {
      return;
    }
    stats.textRows++;

    const selections = parseSelectionLines(viewerRow.TextJp);
    if (selections.length > 0) {
      const checkpoint = matchSourceRow.checkpoint();
      const matchedRows = selections.map(selection =>
        matchSourceRow(selection.text),
      );
      if (matchedRows.every(Boolean)) {
        stats.matchedRows++;
        fillSelectionRow(viewerRow, selections, matchedRows, stats);
        return;
      }
      matchSourceRow.restore(checkpoint);
    }

    const sourceRow = matchSourceRow(viewerRow.TextJp);
    if (sourceRow) {
      stats.matchedRows++;
      fillNormalRow(viewerRow, sourceRow, stats);
      return;
    }

    stats.unmatchedRows.push({
      viewerIndex,
      TextJp: viewerRow.TextJp,
    });
  });

  return stats;
}

export async function loadBaL10nStory({
  storyId,
  sourceKind,
  baseUrl,
  cachePath,
  inputPath,
  refresh,
}) {
  if (inputPath) {
    return {
      rows: JSON.parse(fs.readFileSync(inputPath, "utf8")),
      source: inputPath,
      fromCache: false,
    };
  }

  if (!refresh && fs.existsSync(cachePath)) {
    return {
      rows: JSON.parse(fs.readFileSync(cachePath, "utf8")),
      source: cachePath,
      fromCache: true,
    };
  }

  const sourceUrl =
    `${baseUrl.replace(/\/+$/u, "")}/data/story/` +
    `${encodeURIComponent(sourceKind)}/${encodeURIComponent(storyId)}.json`;
  const response = await fetch(sourceUrl, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(
      `GET ${sourceUrl} failed: ${response.status} ${response.statusText}`,
    );
  }
  const text = await response.text();
  const rows = JSON.parse(text);
  if (!Array.isArray(rows)) {
    throw new Error(`ba-l10n response from ${sourceUrl} is not an array`);
  }

  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const temporaryPath = `${cachePath}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(rows, null, 2)}\n`);
    fs.renameSync(temporaryPath, cachePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
  return {
    rows,
    source: sourceUrl,
    fromCache: false,
  };
}
