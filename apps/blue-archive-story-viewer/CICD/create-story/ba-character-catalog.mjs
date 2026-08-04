import fs from "fs";
import path from "path";
import url from "url";

import xxhash from "xxhashjs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..", "..");
const repoRoot = path.resolve(appRoot, "..", "..");

loadEnvFile(path.join(appRoot, ".env"));
loadEnvFile(path.join(repoRoot, ".env"));

const defaultScenarioSchemaPath =
  process.env.BA_SCENARIO_SCHEMA_PATH ||
  "/Volumes/storage/ba-asset-data-global/extracted/Table/ExcelDB/ScenarioScriptDBSchema.json";
const defaultCharacterTablePath =
  process.env.BA_CHARACTER_NAME_SCHEMA_PATH ||
  path.join(
    path.dirname(defaultScenarioSchemaPath),
    "ScenarioCharacterNameDBSchema.json",
  );
const playerDataBaseUrl =
  process.env.BA_PLAYER_DATA_URL ||
  "https://yuuka.cdn.diyigemt.com/image/ba-all-data";
const playerCharacterTableUrl =
  process.env.BA_PLAYER_CHARACTER_NAME_TABLE_URL ||
  `${playerDataBaseUrl.replace(/\/+$/u, "")}` +
    "/data/ScenarioCharacterNameExcelTable.json";
const playerCharacterTableOverridePath =
  process.env.BA_PLAYER_CHARACTER_NAME_TABLE_PATH || "";
const playerCharacterTableCachePath = path.join(
  appRoot,
  ".local-files",
  "player-data",
  "ScenarioCharacterNameExcelTable.json",
);
const playerCharacterTableCacheTtlMs = 60 * 60 * 1000;

let playerCharacterTablePromise;
let traditionalToSimplifiedCharacterNameMapPromise;

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) {
    return;
  }

  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(trimmed);
    if (!match) {
      continue;
    }
    let value = match[2].trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(match[1] in process.env)) {
      process.env[match[1]] = value;
    }
  }
}

export function getPlayerCharacterId(koreanName) {
  return xxhash.h32(String(koreanName), 0).toNumber();
}

function readLocalCharacterTable() {
  if (!fs.existsSync(defaultCharacterTablePath)) {
    throw new Error(
      "Local character name table does not exist: " +
      `${defaultCharacterTablePath}. Run pnpm sync-ba-story-data or set ` +
      "BA_CHARACTER_NAME_SCHEMA_PATH.",
    );
  }
  const payload = JSON.parse(
    fs.readFileSync(defaultCharacterTablePath, "utf8"),
  );
  const records = Array.isArray(payload)
    ? payload
    : payload.content ?? payload.DataList;
  if (!Array.isArray(records)) {
    throw new Error(
      `${defaultCharacterTablePath} must be an array or contain content[]`,
    );
  }
  return records.map(record => record?.Bytes ?? record);
}

function readCharacterTableFile(tablePath) {
  const payload = JSON.parse(
    fs.readFileSync(tablePath, "utf8"),
  );
  const records = Array.isArray(payload)
    ? payload
    : payload.content ?? payload.DataList;
  if (!Array.isArray(records)) {
    throw new Error(
      `${tablePath} must be an array or ` +
      "contain content[]/DataList[]",
    );
  }
  return records.map(record => record?.Bytes ?? record);
}

async function refreshPlayerCharacterTableCache() {
  const cacheKey = Math.floor(Date.now() / playerCharacterTableCacheTtlMs);
  const sourceUrl = new URL(playerCharacterTableUrl);
  sourceUrl.searchParams.set("t", String(cacheKey));
  const response = await fetch(sourceUrl, {
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(
      `GET ${sourceUrl} failed: ${response.status} ${response.statusText}`,
    );
  }
  const payload = await response.json();
  fs.mkdirSync(path.dirname(playerCharacterTableCachePath), {
    recursive: true,
  });
  const temporaryPath = `${playerCharacterTableCachePath}.tmp`;
  try {
    fs.writeFileSync(
      temporaryPath,
      `${JSON.stringify(payload, null, 2)}\n`,
    );
    fs.renameSync(temporaryPath, playerCharacterTableCachePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

export function buildTraditionalToSimplifiedCharacterNameMap(
  traditionalRows,
  playerRows,
) {
  const candidates = new Map();
  const playerById = new Map(
    (playerRows ?? []).map(row => [Number(row.CharacterName), row]),
  );
  const addCandidate = (traditional, simplified) => {
    const source = String(traditional ?? "").trim();
    const target = String(simplified ?? "").trim();
    if (!source || !target) return;
    const targets = candidates.get(source) ?? new Set();
    targets.add(target);
    candidates.set(source, targets);
  };

  for (const row of traditionalRows ?? []) {
    if (
      !row.SpinePrefabName &&
      (!row.SmallPortrait || /NPC_Portrait_Null$/u.test(row.SmallPortrait))
    ) {
      continue;
    }
    const playerRow = playerById.get(Number(row.CharacterName));
    if (!playerRow) {
      continue;
    }
    addCandidate(row.NameTW, playerRow.NameCN);
    addCandidate(row.NicknameTW, playerRow.NicknameCN);
  }

  for (const row of playerRows ?? []) {
    if (
      !row.SpinePrefabName &&
      (!row.SmallPortrait || /NPC_Portrait_Null$/u.test(row.SmallPortrait))
    ) {
      continue;
    }
    addCandidate(row.NameTW, row.NameCN);
    addCandidate(row.NicknameTW, row.NicknameCN);
  }

  return new Map(
    [...candidates]
      .filter(([, targets]) => targets.size === 1)
      .map(([traditional, targets]) => [traditional, [...targets][0]]),
  );
}

export async function loadTraditionalToSimplifiedCharacterNameMap() {
  if (!traditionalToSimplifiedCharacterNameMapPromise) {
    traditionalToSimplifiedCharacterNameMapPromise = Promise.all([
      Promise.resolve(readLocalCharacterTable()),
      loadPlayerCharacterNameTable(),
    ]).then(([traditionalRows, playerRows]) =>
      buildTraditionalToSimplifiedCharacterNameMap(
        traditionalRows,
        playerRows,
      ),
    );
  }
  return traditionalToSimplifiedCharacterNameMapPromise;
}

export async function loadPlayerCharacterNameTable() {
  if (!playerCharacterTablePromise) {
    playerCharacterTablePromise = (async () => {
      if (playerCharacterTableOverridePath) {
        if (!fs.existsSync(playerCharacterTableOverridePath)) {
          throw new Error(
            "Player character name table does not exist: " +
              playerCharacterTableOverridePath,
          );
        }
        return readCharacterTableFile(playerCharacterTableOverridePath);
      }

      const cacheIsFresh = fs.existsSync(playerCharacterTableCachePath) &&
        Date.now() - fs.statSync(playerCharacterTableCachePath).mtimeMs <
          playerCharacterTableCacheTtlMs;
      if (!cacheIsFresh) {
        await refreshPlayerCharacterTableCache();
      }
      return readCharacterTableFile(playerCharacterTableCachePath);
    })();
  }
  return playerCharacterTablePromise;
}

export async function resolveStoryCharacterRoster(characterRefs) {
  const uniqueRefs = new Map();
  for (const reference of characterRefs) {
    if (!reference?.speaker) continue;
    const speaker = String(reference.speaker).trim();
    const characterId = Number(reference.characterId) || 0;
    const existing = uniqueRefs.get(speaker);
    if (
      existing?.characterId &&
      characterId &&
      existing.characterId !== characterId
    ) {
      throw new Error(
        `Player speaker "${speaker}" has conflicting CharacterIds: ` +
          `${existing.characterId}, ${characterId}`,
      );
    }
    uniqueRefs.set(speaker, {
      speaker,
      characterId: existing?.characterId || characterId,
    });
  }
  if (uniqueRefs.size === 0) {
    return new Map();
  }

  const table = await loadPlayerCharacterNameTable();
  const rowsById = new Map(table.map(row => [Number(row.CharacterName), row]));
  const roster = new Map();
  for (const reference of uniqueRefs.values()) {
    const characterId = getPlayerCharacterId(reference.speaker);
    if (reference.characterId && reference.characterId !== characterId) {
      throw new Error(
        `Speaker mismatch: player hashes "${reference.speaker}" to ` +
          `${characterId}, but story CharacterId is ${reference.characterId}`,
      );
    }
    const row = rowsById.get(characterId);
    if (!row) {
      throw new Error(
        `Player cannot resolve "${reference.speaker}": hash ${characterId} ` +
          `is absent from ${playerCharacterTableUrl}`,
      );
    }
    // CharacterName is the hash of the scenario script identifier, while
    // NameKR is a display name. Alternate outfits, masks, injuries and signal
    // portraits intentionally use identifiers such as "통신카즈사" whose
    // table row still displays the canonical name "카즈사". An exact hash
    // lookup is authoritative; treating the differing display name as a hash
    // collision rejects valid game data.
    roster.set(reference.speaker, {
      speaker: reference.speaker,
      characterId,
      characterIds: [characterId],
      characterName: row.NameCN || row.NameJP,
      translationName: row.NameCN || row.NameJP,
      jaAliases: [row.NameJP].filter(Boolean),
      koAliases: [...new Set(
        [row.NameKR, reference.speaker].filter(Boolean),
      )],
      playerCharacter: row,
      matchedBy:
        row.NameKR === reference.speaker
          ? "player-character-name-table"
          : "player-character-name-table-script-alias",
    });
  }
  return roster;
}

export function attachLocalCharacterResources(
  roster,
  characterRoot,
  overrides = {},
) {
  const result = new Map();
  for (const [speaker, resolved] of roster) {
    const characterName = String(
      overrides[speaker] || resolved.translationName || "",
    ).trim();
    const characterDirectory = path.join(characterRoot, characterName);
    if (!characterName || !fs.existsSync(characterDirectory)) {
      throw new Error(
        `Missing local character resources for player speaker "${speaker}" ` +
          `(${resolved.characterId}) -> ${characterName || "(empty NameCN)"}: ` +
          characterDirectory,
      );
    }
    result.set(speaker, {
      ...resolved,
      characterName,
      characterDirectory,
      resourceMatchedBy: overrides[speaker]
        ? "local-directory-override"
        : "player-name-cn-directory",
    });
  }
  return result;
}
