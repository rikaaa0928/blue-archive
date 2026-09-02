import fs from "fs";
import path from "path";
import url from "url";
import { pathToFileURL } from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..", "..");
const apiBase = "https://www.gamekee.com";
const playableEntryId = 49443;
const npcEntryId = 107619;
const maxRetries = 3;
const requestHeaders = {
  "game-alias": "ba",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  Referer: "https://www.gamekee.com/ba",
};

function printUsage() {
  console.log(`Usage:
  node ./tools/create-story/download-ba-character.mjs <character-name> [options]
  node ./tools/create-story/download-ba-character.mjs --list

Options:
  --output, -o <dir>  output directory, default: .local-files/ba-characters
  --list, -l          list available characters
  --references-only   download only images needed by cover generation
  --help, -h          show this help

Examples:
  pnpm download-ba-character 晴奈
  pnpm download-ba-character --list
`);
}

function parseArgs(argv) {
  const args = {
    name: "",
    output: path.join(appRoot, ".local-files", "ba-characters"),
    list: false,
    help: false,
    referencesOnly: false,
  };
  const positional = [];

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    switch (arg) {
      case "--output":
      case "-o":
        args.output = readOptionValue(argv, ++index, arg);
        break;
      case "--list":
      case "-l":
        args.list = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--references-only":
        args.referencesOnly = true;
        break;
      default:
        if (arg.startsWith("-")) {
          throw new Error(`Unknown option: ${arg}`);
        }
        positional.push(arg);
    }
  }

  args.name = positional[0] || "";
  if (positional.length > 1) {
    throw new Error(`Unexpected positional arguments: ${positional.slice(1).join(" ")}`);
  }
  return args;
}

function readOptionValue(argv, index, optionName) {
  const value = argv[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

async function requestJson(pathname, options = {}) {
  const requestUrl = new URL(pathname, apiBase);
  if (options.params) {
    for (const [key, value] of Object.entries(options.params)) {
      requestUrl.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(requestUrl, {
    method: options.method || "GET",
    headers: {
      ...requestHeaders,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(
      `${options.method || "GET"} ${requestUrl} failed: ` +
        `${response.status} ${response.statusText}`,
    );
  }
  return response.json();
}

export async function fetchCharacterList() {
  const characters = [];
  for (const pid of [playableEntryId, npcEntryId]) {
    const payload = await requestJson("/v1/entry/getListByPids", {
      method: "POST",
      body: { pids: [pid] },
    });
    if (payload?.code === 0 && Array.isArray(payload.data)) {
      characters.push(...payload.data);
    }
  }
  return characters;
}

function normalizeText(value) {
  return String(value || "").normalize("NFKC").trim().toLocaleLowerCase();
}

function characterAliases(character) {
  return String(character.name_alias || "")
    .split(",")
    .map(alias => alias.trim())
    .filter(Boolean);
}

export function searchCharacter(characters, keyword) {
  const normalizedKeyword = normalizeText(keyword);
  const canonicalMatches = characters.filter(
    character => normalizeText(character.name) === normalizedKeyword,
  );
  if (canonicalMatches.length === 1) return canonicalMatches[0];
  if (canonicalMatches.length > 1) {
    throw new Error(
      `GameKee canonical-name match is ambiguous for "${keyword}"`,
    );
  }

  let aliasMatches = characters.filter(character =>
    characterAliases(character).map(normalizeText).includes(normalizedKeyword),
  );
  if (aliasMatches.length > 1) {
    const baseCharacters = aliasMatches.filter(
      character => !/\(.*\)|（.*）/u.test(character.name),
    );
    if (baseCharacters.length === 1) aliasMatches = baseCharacters;
  }
  if (aliasMatches.length > 1) {
    throw new Error(
      `GameKee exact-alias match is ambiguous for "${keyword}": ` +
        aliasMatches.map(character => character.name).join(", "),
    );
  }
  return aliasMatches[0] ?? null;
}

async function downloadFile(sourceUrl, destination) {
  if (fs.existsSync(destination)) {
    console.log(`  [跳过] 已存在: ${path.basename(destination)}`);
    return true;
  }

  const normalizedUrl = sourceUrl.startsWith("//") ? `https:${sourceUrl}` : sourceUrl;
  const partialPath = `${destination}.part`;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(normalizedUrl, {
        headers: {
          Referer: requestHeaders.Referer,
          "User-Agent": requestHeaders["User-Agent"],
        },
        redirect: "follow",
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }

      const bytes = Buffer.from(await response.arrayBuffer());
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(partialPath, bytes);
      fs.renameSync(partialPath, destination);
      console.log(`  [下载] ${path.basename(destination)}`);
      return true;
    } catch (error) {
      if (fs.existsSync(partialPath)) {
        fs.rmSync(partialPath);
      }
      console.warn(
        `  [重试 ${attempt}/${maxRetries}] ${path.basename(destination)}: ${error.message}`,
      );
      if (attempt < maxRetries) {
        await sleep(1000);
      }
    }
  }

  console.error(`  [失败] ${path.basename(destination)}`);
  return false;
}

export async function fetchContentJson(contentId) {
  const logPayload = await requestJson("/v1/content/logList", {
    params: { content_id: contentId, page: 1, size: 1 },
  });
  if (logPayload?.code !== 0 || !Array.isArray(logPayload.data) || !logPayload.data[0]) {
    throw new Error(`无法获取版本列表 (content_id=${contentId})`);
  }

  const versionId = logPayload.data[0].id;
  const detailPayload = await requestJson("/v1/content/versionDetail", {
    params: { id: versionId },
  });
  if (detailPayload?.code !== 0 || !detailPayload.data) {
    throw new Error(`无法获取内容详情 (version_id=${versionId})`);
  }

  const contentJson = detailPayload.data.content_json;
  if (!contentJson) {
    throw new Error("content_json 为空");
  }

  const content = typeof contentJson === "string" ? JSON.parse(contentJson) : contentJson;
  if (Array.isArray(content)) {
    throw new Error("此角色使用新版 illustrated-book 格式，暂不支持");
  }
  return content;
}

function cellString(cell) {
  return cell && typeof cell === "object" && !Array.isArray(cell)
    ? String(cell.value || "").trim()
    : "";
}

function cellType(cell) {
  return cell && typeof cell === "object" && !Array.isArray(cell)
    ? String(cell.type || "")
    : "";
}

function extractPortraits(baseData) {
  const portraits = [];
  for (const row of baseData) {
    if (!Array.isArray(row) || row.length < 3) continue;
    const first = row[0];
    if (cellType(first) !== "text" || !first.isGlobal) continue;
    const label = cellString(first);
    if (!/^立绘\d*$/.test(label)) continue;

    const variant = cellString(row[1]);
    if (cellType(row[2]) === "image" && cellString(row[2])) {
      portraits.push({
        name: variant ? `${label}_${variant}` : label,
        sourceUrl: cellString(row[2]),
      });
    }
  }
  return portraits;
}

function extractLobbyImage(baseData) {
  for (const row of baseData) {
    if (!Array.isArray(row) || cellString(row[0]) !== "回忆大厅" || !row[0]?.isGlobal) {
      continue;
    }
    const image = row.slice(1).find(cell => cellType(cell) === "image" && cellString(cell));
    if (image) return cellString(image);
  }
  return "";
}

function extractFirstSettingImage(baseData) {
  for (const row of baseData) {
    if (
      !Array.isArray(row) ||
      !cellString(row[0]).startsWith("设定集") ||
      !row[0]?.isGlobal
    ) {
      continue;
    }
    const image = row.slice(1).find(cell => cellType(cell) === "image" && cellString(cell));
    if (image) return cellString(image);
  }
  return "";
}

export function extractVoiceLines(baseData) {
  let voiceStart = baseData.findIndex(
    row => Array.isArray(row) && cellString(row[0]) === "配音语言" && row[0]?.isGlobal,
  );
  if (voiceStart < 0) {
    const firstVoiceRow = baseData.findIndex(
      row =>
        Array.isArray(row) &&
        row.length >= 5 &&
        cellString(row[0]) === "通常" &&
        cellType(row[4]) === "audio",
    );
    if (firstVoiceRow >= 0) {
      voiceStart = firstVoiceRow - 2;
    }
  }
  if (voiceStart < 0) {
    console.warn("  [警告] 未找到语音数据区域");
    return [];
  }

  const allowedGlobalLabels = new Set([
    "",
    "通常",
    "大厅及咖啡馆",
    "好感度",
    "战斗",
    "成长",
    "事件",
    "活动",
    "配音语言",
    "配音大类",
  ]);
  const voiceLines = [];

  for (const row of baseData.slice(voiceStart + 2)) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const first = row[0] && typeof row[0] === "object" ? row[0] : {};
    if (first.isGlobal && !allowedGlobalLabels.has(cellString(first))) {
      break;
    }
    if (!row.slice(0, 5).every(cell => cell && typeof cell === "object")) {
      continue;
    }

    const name = cellString(row[1]);
    const textJp = cellString(row[2]);
    if (!name || !textJp) continue;
    voiceLines.push({
      category: cellString(row[0]) || voiceLines.at(-1)?.category || "未分类",
      name,
      textJp,
      textCn: cellString(row[3]),
      textCnDub: cellString(row[5]),
      audioJp: cellType(row[4]) === "audio" ? cellString(row[4]) : "",
      audioCn: cellType(row[6]) === "audio" ? cellString(row[6]) : "",
      audioKr: cellType(row[7]) === "audio" ? cellString(row[7]) : "",
    });
  }
  return voiceLines;
}

function sanitizeFilename(value) {
  const sanitized = String(value)
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/^[. ]+|[. ]+$/g, "")
    .slice(0, 200);
  return sanitized || "unnamed";
}

function extensionFromUrl(sourceUrl, fallback = ".png") {
  const normalizedUrl = sourceUrl.startsWith("//") ? `https:${sourceUrl}` : sourceUrl;
  const extension = path.extname(new URL(normalizedUrl).pathname);
  return extension || fallback;
}

export async function downloadCharacter(name, outputBase, { referencesOnly = false, outputName = "" } = {}) {
  console.log("═══ 蔚蓝档案角色资源下载器 ═══");
  console.log(`搜索角色: ${name}\n`);

  console.log("[1/6] 获取角色列表...");
  const characters = await fetchCharacterList();
  console.log(`  共加载 ${characters.length} 个角色`);
  const character = searchCharacter(characters, name);
  if (!character) {
    throw new Error(`未精确找到角色「${name}」（仅匹配正式名或完整别名）`);
  }

  const characterName = character.name;
  const contentId = character.content_id;
  const aliases = character.name_alias || "";
  const outputDir = path.resolve(outputBase, sanitizeFilename(outputName || characterName));
  fs.mkdirSync(outputDir, { recursive: true });
  console.log(`  找到角色: ${characterName} (content_id=${contentId})`);
  if (aliases) console.log(`  别名: ${aliases}`);
  console.log(`  输出目录: ${outputDir}\n`);

  console.log("[2/6] 获取角色页面数据...");
  const content = await fetchContentJson(contentId);
  const baseData = Array.isArray(content.baseData) ? content.baseData : [];
  console.log(`  共 ${baseData.length} 行数据\n`);

  console.log("[3/6] 下载立绘...");
  const portraits = extractPortraits(baseData);
  for (const portrait of portraits) {
    await downloadFile(
      portrait.sourceUrl,
      path.join(
        outputDir,
        "立绘",
        `${sanitizeFilename(portrait.name)}${extensionFromUrl(portrait.sourceUrl)}`,
      ),
    );
  }
  if (portraits.length === 0) console.warn("  [警告] 未找到立绘");
  console.log();

  console.log("[4/6] 下载回忆大厅图片...");
  const lobbyUrl = extractLobbyImage(baseData);
  if (lobbyUrl) {
    await downloadFile(lobbyUrl, path.join(outputDir, `回忆大厅${extensionFromUrl(lobbyUrl)}`));
  } else {
    console.warn("  [警告] 未找到回忆大厅图片");
  }
  console.log();

  console.log("[5/6] 下载设定集...");
  const settingUrl = extractFirstSettingImage(baseData);
  if (settingUrl) {
    await downloadFile(settingUrl, path.join(outputDir, `设定集${extensionFromUrl(settingUrl)}`));
  } else {
    console.warn("  [警告] 未找到设定集");
  }
  console.log();

  if (referencesOnly) {
    const summary = {
      角色名: characterName,
      别名: aliases,
      content_id: contentId,
      立绘数量: portraits.length,
      有回忆大厅图片: Boolean(lobbyUrl),
      有设定集: Boolean(settingUrl),
      仅封面参考图: true,
    };
    fs.writeFileSync(path.join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`\n═══ 封面参考图准备完成！输出目录: ${outputDir} ═══`);
    return summary;
  }

  console.log("[6/6] 下载语音和台词...");
  const voiceLines = extractVoiceLines(baseData);
  const voiceDir = path.join(outputDir, "语音");
  fs.mkdirSync(voiceDir, { recursive: true });
  const nameCounts = new Map();
  let downloadedVoiceCount = 0;
  let longestLine = null;

  for (const line of voiceLines) {
    const rawName = `${sanitizeFilename(line.category)}_${sanitizeFilename(line.name)}`;
    const count = (nameCounts.get(rawName) || 0) + 1;
    nameCounts.set(rawName, count);
    const baseName = count > 1 ? `${rawName}_${count}` : rawName;
    const textJp = line.textJp.replace(/\n/g, "");
    fs.writeFileSync(path.join(voiceDir, `${baseName}.txt`), textJp);

    let audioPath = "";
    if (line.audioJp) {
      audioPath = path.join(
        voiceDir,
        `${baseName}${extensionFromUrl(line.audioJp, ".ogg")}`,
      );
      if (await downloadFile(line.audioJp, audioPath)) {
        downloadedVoiceCount++;
      }
    }
    if (!longestLine || textJp.length > longestLine.text.length) {
      longestLine = { name: baseName, text: textJp, audioPath };
    }
  }

  console.log(`\n  共下载 ${downloadedVoiceCount} 个语音文件，${voiceLines.length} 条台词`);
  const summary = {
    角色名: characterName,
    别名: aliases,
    content_id: contentId,
    立绘数量: portraits.length,
    有回忆大厅图片: Boolean(lobbyUrl),
    有设定集: Boolean(settingUrl),
    语音台词数: voiceLines.length,
    最长台词: longestLine
      ? {
        名称: longestLine.name,
        文本: longestLine.text,
        文本长度: longestLine.text.length,
        音频文件:
          longestLine.audioPath && fs.existsSync(longestLine.audioPath)
            ? path.basename(longestLine.audioPath)
            : null,
      }
      : null,
  };
  fs.writeFileSync(
    path.join(outputDir, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  console.log(`\n═══ 全部完成！输出目录: ${outputDir} ═══`);
}

async function listCharacters() {
  console.log("═══ 蔚蓝档案角色列表 ═══\n");
  const characters = await fetchCharacterList();
  characters
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "zh-CN"))
    .forEach(character => {
      const aliases = character.name_alias ? `  (${character.name_alias})` : "";
      console.log(`  ${character.name || ""}${aliases}`);
    });
  console.log(`\n共 ${characters.length} 个角色`);
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  if (args.list) {
    await listCharacters();
    return;
  }
  if (!args.name) {
    printUsage();
    process.exitCode = 1;
    return;
  }
  await downloadCharacter(args.name, args.output, { referencesOnly: args.referencesOnly });
}

const isDirectRun = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
