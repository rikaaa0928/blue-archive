import fs from "node:fs";
import path from "node:path";

import yaml from "js-yaml";

import { resolveCharacterImageReferences } from "../../../create-story/character-image-resources.mjs";
import { appRoot, localFilesRoot } from "./utils.mjs";

const studentsPath = path.join(appRoot, "public", "config", "yaml", "students.yaml");
const characterRoot = path.join(localFilesRoot, "ba-characters");

let catalog;

function clean(value) {
  return String(value ?? "").trim();
}

function loadCatalog() {
  if (catalog) return catalog;
  const students = yaml.load(fs.readFileSync(studentsPath, "utf8"));
  const byId = new Map(students.map(student => [Number(student.id), student]));
  const baseId = student => Number(student.nicknameFrom || student.id);
  const variantsByBaseId = new Map();
  for (const student of students) {
    const variants = variantsByBaseId.get(baseId(student)) ?? [];
    variants.push(student);
    variantsByBaseId.set(baseId(student), variants);
  }
  catalog = { students, byId, variantsByBaseId };
  return catalog;
}

function variantTokens(student) {
  return [...new Set([
    ...clean(student?.name?.cn).matchAll(/[（(]([^）)]+)[）)]/gu),
    ...clean(student?.name?.kr).matchAll(/[（(]([^）)]+)[）)]/gu),
  ].map(match => clean(match[1])).filter(Boolean))];
}

export function characterVersionOptions(characterName, stableKeys = []) {
  const name = clean(characterName);
  const { students, variantsByBaseId } = loadCatalog();
  const base = students.find(student => clean(student?.name?.cn) === name && !student.nicknameFrom) ??
    students.find(student => clean(student?.name?.cn) === name);
  const variants = base ? variantsByBaseId.get(Number(base.nicknameFrom || base.id)) ?? [base] : [];
  const keys = stableKeys.map(clean).filter(Boolean);
  const options = variants.map(student => {
    const resourceName = clean(student?.name?.cn);
    const tokens = variantTokens(student);
    return {
      id: String(student.id),
      resourceName,
      label: resourceName,
      installed: Boolean(resolveCharacterImageReferences(characterRoot, resourceName).primaryPath),
      recommended: tokens.length > 0 && keys.some(key => tokens.some(token => key.includes(token))),
    };
  });
  if (!options.some(option => option.resourceName === name)) {
    options.unshift({
      id: `local-${name}`,
      resourceName: name,
      label: name,
      installed: Boolean(resolveCharacterImageReferences(characterRoot, name).primaryPath),
      recommended: false,
    });
  }
  const recommended = options.find(option => option.recommended) ??
    options.find(option => option.resourceName === name) ?? options[0];
  return { characterName: name, selectedResourceName: recommended?.resourceName ?? name, options };
}

export function coverCharactersFromSpeakerConfigs(speakerConfigs) {
  const byName = new Map();
  for (const config of speakerConfigs) {
    for (const item of config?.items ?? []) {
      if (item.resolution?.type !== "character") continue;
      const characterName = clean(item.resolution.characterName || item.characterName);
      if (!characterName) continue;
      const current = byName.get(characterName) ?? new Set();
      for (const value of [item.sourceSpeaker, item.stableKey, item.resolution.stableKey]) {
        if (clean(value)) current.add(clean(value));
      }
      byName.set(characterName, current);
    }
  }
  return [...byName].map(([characterName, stableKeys]) =>
    characterVersionOptions(characterName, [...stableKeys]));
}
