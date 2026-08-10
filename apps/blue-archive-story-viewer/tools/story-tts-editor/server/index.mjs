import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import OpenAI from 'openai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const editorRoot = path.resolve(__dirname, '..');
const appRoot = path.resolve(editorRoot, '..', '..');
const storyDir = path.resolve(appRoot, 'public', 'story');
const storyDirReal = fs.realpathSync(storyDir);
const ttsDir = path.resolve(appRoot, '.local-files', 'tts');
const ttsTempDir = path.resolve(editorRoot, 'temp-audio');

if (!fs.existsSync(ttsTempDir)) {
  fs.mkdirSync(ttsTempDir, { recursive: true });
}

const app = express();
app.use(cors({
  origin: ['http://localhost:5173', 'http://127.0.0.1:5173']
}));
app.use(express.json());

// Serve static audio files
app.use('/audio/tts', express.static(ttsDir));
app.use('/audio/temp', express.static(ttsTempDir));

function isInsideDirectory(baseDir, candidatePath) {
  const relative = path.relative(baseDir, candidatePath);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function resolveExistingStoryPath(requestPath) {
  if (typeof requestPath !== 'string' || !requestPath.endsWith('.json')) {
    return null;
  }

  const candidatePath = path.resolve(storyDir, requestPath);
  if (!isInsideDirectory(storyDir, candidatePath) || !fs.existsSync(candidatePath)) {
    return null;
  }

  const realPath = fs.realpathSync(candidatePath);
  return isInsideDirectory(storyDirReal, realPath) ? realPath : null;
}

function collectStories(type, directory, stories) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectStories(type, entryPath, stories);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }

    const relativePath = path.relative(storyDir, entryPath);
    const parent = path.dirname(path.relative(path.join(storyDir, type), entryPath));
    stories.push({
      type,
      id: path.basename(entry.name, '.json'),
      path: relativePath.split(path.sep).join('/'),
      parent: parent === '.' ? '' : parent.split(path.sep).join('/')
    });
  }
}

app.get('/api/stories', (req, res) => {
  const stories = [];
  try {
    const typeEntries = fs.readdirSync(storyDir, { withFileTypes: true });
    for (const typeEntry of typeEntries) {
      if (!typeEntry.isDirectory()) {
        continue;
      }
      const type = typeEntry.name;
      collectStories(type, path.join(storyDir, type), stories);
    }

    stories.sort((a, b) => a.path.localeCompare(b.path));
    res.json(stories);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/story', (req, res) => {
  const { path: p } = req.query;
  const fullPath = resolveExistingStoryPath(p);

  if (fullPath) {
    try {
      const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      res.json({ data, path: p });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  } else {
    res.status(400).json({ error: 'Invalid story path' });
  }
});

app.post('/api/story', (req, res) => {
  const { path: p } = req.query;
  const { data } = req.body;
  const fullPath = resolveExistingStoryPath(p);

  if (fullPath) {
    try {
      fs.writeFileSync(fullPath, JSON.stringify(data, null, 2), 'utf8');
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  } else {
    res.status(400).json({ error: 'Invalid story path' });
  }
});

// A simplified trigger for TTS. In a real scenario you would call zero-tts logic here
app.post('/api/tts/generate', async (req, res) => {
  const { text, character, storyId, index, ttsUrl, ttsKey, openAiTtsUrl, openAiTtsKey } = req.body;
  try {
    if (!ttsUrl || !ttsKey || !openAiTtsUrl || !openAiTtsKey) {
      throw new Error("Both ZeroTTS credentials and OpenAI TTS credentials are required");
    }

    // List voices
    const listResponse = await fetch(`${ttsUrl.replace(/\/+$/, "")}/voices`, {
      headers: { "X-API-Key": ttsKey }
    });
    if (!listResponse.ok) throw new Error("Failed to list voices");
    const listPayload = await listResponse.json();
    const voices = Array.isArray(listPayload.data) ? listPayload.data : listPayload.data?.items || [];

    // Resolve Character Name from KR if missing
    let resolvedCharacter = character;
    if (resolvedCharacter && /[가-힣]/.test(resolvedCharacter)) {
       // It's a Korean name, we need to map it to Chinese name used for 'BA XX'
       // Read player-data to map KR -> CN
       const dataPath = path.resolve(appRoot, '.local-files', 'player-data', 'ScenarioCharacterNameExcelTable.json');
       if (fs.existsSync(dataPath)) {
         const charData = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
         const list = Array.isArray(charData) ? charData : (charData.DataList || []);
         const match = list.find(c => c.NameKR === resolvedCharacter || c.PersonalNameKR === resolvedCharacter);
         if (match && match.NameCN) {
           resolvedCharacter = match.NameCN;
         }
       }
    }

    // Find voice ID (which translates to the referenceId we pass as voice)
    const voice = voices.find(v => v.name === `BA ${resolvedCharacter}`);
    if (!voice) {
      throw new Error(`Voice for 'BA ${resolvedCharacter}' (resolved from ${character}) not found on server. Try creating it via publish-voice-r2 or check ZeroTTS backend.`);
    }

    const referenceId = voice.referenceId || voice.id || voice.voice_id;
    if (!referenceId) {
      throw new Error(`Could not determine reference ID for voice 'BA ${resolvedCharacter}'`);
    }

    // Call OpenAI-compatible TTS endpoint
    const client = new OpenAI({
      apiKey: openAiTtsKey,
      baseURL: openAiTtsUrl.replace(/\/+$/, ""),
      defaultHeaders: { "x-fish-priority": "v2" }
    });

    const response = await client.audio.speech.create({
      model: "utf-8-tts",
      voice: referenceId,
      input: text,
      speed: 1.0
    });

    const audioBuffer = await response.arrayBuffer();

    const hash = crypto.createHash('md5').update(`${character}-${text}`).digest('hex');
    const safeStoryId = String(storyId).replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeIndex = String(index).replace(/[^a-zA-Z0-9_-]/g, '_');
    const tempFileName = `${safeStoryId}_${safeIndex}_${hash}.mp3`;
    const tempFile = path.join(ttsTempDir, tempFileName);
    fs.writeFileSync(tempFile, Buffer.from(audioBuffer));

    res.json({
      success: true,
      tempUrl: `/audio/temp/${tempFileName}`,
      message: "TTS generation successful"
    });
  } catch (err) {
    res.status(500).json({ error: err.message, success: false });
  }
});

const PORT = 3000;
const HOST = '127.0.0.1';
app.listen(PORT, HOST, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
