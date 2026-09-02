import fs from "node:fs";
import path from "node:path";

const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp"]);

function imageFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter(name => imageExtensions.has(path.extname(name).toLowerCase()))
    .sort((left, right) => left.localeCompare(right, "zh-CN"));
}

export function resolveCharacterImageReferences(characterRoot, resourceName) {
  const directory = path.join(characterRoot, String(resourceName));
  const settingName = imageFiles(directory).find(name => path.basename(name, path.extname(name)) === "设定集");
  const portraitDirectory = path.join(directory, "立绘");
  const portraits = imageFiles(portraitDirectory);
  const defaultPortrait = portraits.find(name => path.basename(name, path.extname(name)) === "立绘") ?? portraits[0];
  const settingPath = settingName ? path.join(directory, settingName) : null;
  const portraitPath = defaultPortrait ? path.join(portraitDirectory, defaultPortrait) : null;
  const lobbyName = imageFiles(directory).find(name => path.basename(name, path.extname(name)) === "回忆大厅");
  return {
    settingPath,
    portraitPath,
    primaryPath: settingPath || portraitPath,
    primaryKind: settingPath ? "setting-sheet" : portraitPath ? "default-portrait" : null,
    lobbyPath: lobbyName ? path.join(directory, lobbyName) : null,
  };
}
