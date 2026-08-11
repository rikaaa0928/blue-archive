import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeStoryPath } from '../../CICD/create-story/story-path.mjs';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultAppRoot = path.resolve(moduleDirectory, '..', '..');

function compareStoryIds(left, right) {
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    const leftNumber = BigInt(left);
    const rightNumber = BigInt(right);
    if (leftNumber < rightNumber) return -1;
    if (leftNumber > rightNumber) return 1;
    return 0;
  }
  return left.localeCompare(right, undefined, { numeric: true });
}

function titleFromStory(story) {
  const titleUnit = story?.content?.find(unit =>
    String(unit.ScriptKr ?? '')
      .split(/\r?\n/)
      .some(line => line.trimStart().startsWith('#title;')),
  );
  if (!titleUnit) return '';

  const textCn = String(titleUnit.TextCn ?? '').trim();
  if (!textCn) return '';
  const separatorIndex = textCn.indexOf(';');
  return (separatorIndex >= 0 ? textCn.slice(separatorIndex + 1) : textCn).trim();
}

function readOwnTitle(filePath) {
  const story = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return titleFromStory(story);
}

function sanitizeFileName(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 120);
}

function resolveStoryFile(appRoot, normalizedStory) {
  const segments = [appRoot, 'public', 'story', normalizedStory.type];
  if (normalizedStory.directoryId) segments.push(normalizedStory.directoryId);
  segments.push(`${normalizedStory.id}.json`);
  return path.join(...segments);
}

function resolveDisplayTitle(storyFile, storyId) {
  const ownTitle = readOwnTitle(storyFile);
  if (ownTitle) return ownTitle;

  const storyDirectory = path.dirname(storyFile);
  const siblings = fs.readdirSync(storyDirectory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => ({
      id: entry.name.slice(0, -'.json'.length),
      filePath: path.join(storyDirectory, entry.name),
    }))
    .sort((left, right) => compareStoryIds(left.id, right.id));
  const currentIndex = siblings.findIndex(entry => entry.id === storyId);
  if (currentIndex < 0) return '';

  for (let index = currentIndex - 1; index >= 0; index--) {
    const inheritedTitle = readOwnTitle(siblings[index].filePath);
    if (!inheritedTitle) continue;
    const partNumber = currentIndex - index + 1;
    return `${inheritedTitle}(${partNumber})`;
  }
  return '';
}

export function resolveRecordOutputPath(
  rawStoryPath,
  { subtitleLanguage = 'cn', appRoot = defaultAppRoot } = {},
) {
  const normalizedStory = normalizeStoryPath(rawStoryPath);
  const storyFile = resolveStoryFile(appRoot, normalizedStory);
  if (!fs.existsSync(storyFile)) {
    throw new Error(`Story file not found: ${storyFile}`);
  }

  const title = sanitizeFileName(
    resolveDisplayTitle(storyFile, normalizedStory.id),
  );
  const subtitleSuffix = subtitleLanguage === 'cn'
    ? ''
    : `_${sanitizeFileName(subtitleLanguage)}`;
  const fileStem = `${normalizedStory.id}${title ? `-${title}` : ''}${subtitleSuffix}`;
  const directorySegments = [normalizedStory.type];
  if (normalizedStory.directoryId) {
    directorySegments.push(normalizedStory.directoryId);
  }

  return {
    ...normalizedStory,
    storyFile,
    title,
    fileStem,
    relativeBasePath: path.join(...directorySegments, fileStem),
  };
}

function main() {
  const argv = process.argv.slice(2);
  const rawStoryPath = argv.find(argument => !argument.startsWith('-'));
  if (!rawStoryPath) {
    throw new Error(
      'Usage: node record-output-path.mjs <story-path> [--subtitle=cn|en]',
    );
  }
  const subtitleArgument = argv.find(argument => argument.startsWith('--subtitle='));
  const subtitleLanguage = subtitleArgument
    ? subtitleArgument.slice('--subtitle='.length)
    : 'cn';
  process.stdout.write(
    resolveRecordOutputPath(rawStoryPath, { subtitleLanguage }).relativeBasePath,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
