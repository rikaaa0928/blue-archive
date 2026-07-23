import fs from "fs";
import path from "path";
import url from "url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..", "..");

const defaultModel = "gemini-3.5-flash-lite";
const defaultBatchSize = 12;
const defaultContextRadius = 8;

const flatStoryTypes = new Set(["main", "other"]);
const nestedStoryTypes = new Set(["favor", "event", "group", "mini"]);

const voiceTagExamples = [
  "pause",
  "emphasis",
  "laughing",
  "inhale",
  "chuckle",
  "tsk",
  "singing",
  "excited",
  "laughing tone",
  "interrupting",
  "chuckling",
  "excited tone",
  "volume up",
  "echo",
  "angry",
  "low volume",
  "sigh",
  "soft sigh",
  "low voice",
  "whisper",
  "screaming",
  "shouting",
  "loud",
  "surprised",
  "confused",
  "hesitant",
  "embarrassed",
  "teasing",
  "playful",
  "smug",
  "deadpan",
  "sarcastic",
  "elegant tone",
  "gentle",
  "nervous",
  "worried",
  "relieved",
  "determined",
  "serious",
  "panicked",
  "frustrated",
  "annoyed",
  "awkward laugh",
  "soft laugh",
  "mischievous",
  "proud",
  "dramatic",
  "matter-of-fact",
  "short pause",
  "exhale",
  "delight",
  "panting",
  "audience laughter",
  "with strong accent",
  "volume down",
  "clearing throat",
  "sad",
  "moaning",
  "shocked",
];

const characterNameGlossary = [
  {
    zh: "纯子",
    ja: ["ジュンコ"],
    ko: ["준코"],
    forbiddenZh: ["朱莉", "茱莉", "朱里", "淳子", "俊子"],
  },
  {
    zh: "明里",
    ja: ["アカリ"],
    ko: ["아카리"],
    forbiddenZh: ["灯", "朱莉"],
  },
  {
    zh: "晴奈",
    ja: ["ハルナ"],
    ko: ["하루나"],
    forbiddenZh: ["春奈", "遥奈"],
  },
  {
    zh: "泉",
    ja: ["イズミ"],
    ko: ["이즈미"],
    forbiddenZh: ["和泉"],
  },
  {
    zh: "日奈",
    ja: ["ヒナ"],
    ko: ["히나"],
    forbiddenZh: ["雏", "阳奈"],
  },
  {
    zh: "千夏",
    ja: ["チナツ"],
    ko: ["치나츠"],
    forbiddenZh: ["千奈津"],
  },
  {
    zh: "伊织",
    ja: ["イオリ"],
    ko: ["이오리"],
    forbiddenZh: ["伊织里", "伊織"],
  },
];

const systemInstruction = `You are a senior Blue Archive scenario localizer and Japanese voice director.

Your job has two outputs for each requested story line:
1. TextCn: high-quality Simplified Chinese localization of TextJp.
2. TextJpVoice: the original Japanese TextJp enriched with concise voice emotion tags.

Rules:
- Use the provided full story outline, character roster, local scene context,
  script cues, SFX, BGM, and neighboring lines.
- Use the provided terminology glossary exactly. Character names in TextCn must
  use the glossary Chinese forms whenever the matching Japanese name appears.
- Never invent alternate Chinese character names.
- TextCn must be Simplified Chinese only. Do not add translator notes.
- TextCn should preserve Blue Archive tone: light novel/anime dialogue,
  natural Chinese punctuation, speaker intent, jokes, and honorific nuance
  when useful.
- TextCn should preserve line breaks roughly. Preserve important markup such as
  [ruby=...][/ruby], color tags, and wait tags if present.
- TextJpVoice must stay Japanese. Do not translate it.
- TextJpVoice should preserve the original Japanese wording and line breaks,
  only inserting bracket tags like [sigh], [angry], [whisper], [short pause].
- Voice tags may be free-form English descriptions, but keep them short and useful for TTS.
- Be expressive enough for voice generation. Use script cues, punctuation,
  speaker personality, and local context to infer tone.
- For character dialogue, prefer 1-3 tags when there is emotion, breath,
  hesitation, teasing, sarcasm, volume change, or a clear acting beat.
- Very expressive or multi-beat lines may use up to 4 tags placed near the
  relevant phrase, not only at the beginning.
- Calm one-sentence dialogue can use 0-1 tag. Do not tag every phrase.
- For title/place/narration lines, use no tag unless a clear delivery cue helps.
- Return strict JSON only. No markdown.`;

function printUsage() {
  console.log(`Usage:
  node ./CICD/create-story/enrich-story-with-llm.mjs <story-id-or-json-path> [options]

Options:
  --type <type>             story type when source is an id, default: group
  --directory-id <id>       directory id for favor/event/group/mini, default: source id prefix
  --output <file>           write to another file, default: overwrite source
  --model <model>           Vertex Gemini model, default: ${defaultModel}
  --project <project>       Vertex project id, defaults to env
  --location <location>     Vertex location, defaults to env or us-central1
  --batch-size <n>          target text units per LLM call, default: ${defaultBatchSize}
  --context-radius <n>      neighboring text units around each batch, default: ${defaultContextRadius}
  --limit <n>               process at most n target lines, useful for testing
  --force                   reprocess lines that already have TextCn and TextJpVoice
  --dry-run                 print plan without calling Vertex or writing
  --help, -h                show this help

Environment:
  GOOGLE_CLOUD_PROJECT / GCLOUD_PROJECT / GCP_PROJECT / VERTEX_PROJECT_ID
  GOOGLE_CLOUD_LOCATION / GOOGLE_CLOUD_REGION / VERTEX_LOCATION

Examples:
  pnpm enrich-story-llm 1101 --type group
  pnpm enrich-story-llm public/story/group/1101/1101.json --limit 5
`);
}

function parseArgs(argv) {
  const args = {
    source: "",
    type: "group",
    directoryId: "",
    output: "",
    model: process.env.GEMINI_MODEL || defaultModel,
    project: "",
    location: "",
    batchSize: defaultBatchSize,
    contextRadius: defaultContextRadius,
    limit: 0,
    force: false,
    dryRun: false,
    help: false,
  };

  const positional = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    switch (arg) {
      case "--type":
        args.type = readOptionValue(argv, ++index, arg);
        break;
      case "--directory-id":
        args.directoryId = readOptionValue(argv, ++index, arg);
        break;
      case "--output":
        args.output = readOptionValue(argv, ++index, arg);
        break;
      case "--model":
        args.model = readOptionValue(argv, ++index, arg);
        break;
      case "--project":
        args.project = readOptionValue(argv, ++index, arg);
        break;
      case "--location":
        args.location = readOptionValue(argv, ++index, arg);
        break;
      case "--batch-size":
        args.batchSize = positiveInteger(readOptionValue(argv, ++index, arg), arg);
        break;
      case "--context-radius":
        args.contextRadius = positiveInteger(readOptionValue(argv, ++index, arg), arg);
        break;
      case "--limit":
        args.limit = positiveInteger(readOptionValue(argv, ++index, arg), arg);
        break;
      case "--force":
        args.force = true;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        if (arg.startsWith("-")) {
          throw new Error(`Unknown option: ${arg}`);
        }
        positional.push(arg);
    }
  }

  args.source = positional[0] ?? "";
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

function positiveInteger(value, optionName) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${optionName} must be a positive integer`);
  }
  return parsed;
}

function resolveStoryPath(args) {
  if (!args.source) {
    throw new Error("Missing story id or json path");
  }

  const sourcePath = path.resolve(process.cwd(), args.source);
  if (fs.existsSync(sourcePath)) {
    return sourcePath;
  }

  if (flatStoryTypes.has(args.type)) {
    return path.join(appRoot, "public", "story", args.type, `${args.source}.json`);
  }

  if (nestedStoryTypes.has(args.type)) {
    const directoryId = args.directoryId || String(args.source).slice(0, 5);
    return path.join(
      appRoot,
      "public",
      "story",
      args.type,
      directoryId,
      `${args.source}.json`
    );
  }

  throw new Error(
    `Unsupported story type: ${args.type}. Expected one of ${[
      ...flatStoryTypes,
      ...nestedStoryTypes,
    ].join(", ")}`
  );
}

function resolveProject(args) {
  return (
    args.project ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCLOUD_PROJECT ||
    process.env.GCP_PROJECT ||
    process.env.VERTEX_PROJECT_ID ||
    process.env.GOOGLE_VERTEX_PROJECT ||
    ""
  );
}

function resolveLocation(args) {
  return (
    args.location ||
    process.env.GOOGLE_CLOUD_LOCATION ||
    process.env.GOOGLE_CLOUD_REGION ||
    process.env.VERTEX_LOCATION ||
    process.env.GOOGLE_VERTEX_LOCATION ||
    "us-central1"
  );
}

function collectTextUnits(story) {
  return story.content
    .map((unit, index) => ({
      index,
      textJp: String(unit.TextJp ?? ""),
      textCn: String(unit.TextCn ?? ""),
      textJpVoice: String(unit.TextJpVoice ?? ""),
      scriptKr: String(unit.ScriptKr ?? ""),
      sound: String(unit.Sound ?? ""),
      bgmId: unit.BGMId || 0,
      bgName: unit.BGName || 0,
      popup: String(unit.PopupFileName ?? ""),
      speaker: inferSpeaker(unit),
      role: inferRole(unit),
    }))
    .filter(unit => unit.textJp.trim());
}

function inferSpeaker(unit) {
  const script = String(unit.ScriptKr ?? "");
  const characterLine = script
    .split("\n")
    .map(line => line.trim())
    .find(line => /^(?!#)[1-5];/.test(line));
  if (characterLine) {
    return characterLine.split(";")[1] || "";
  }

  const narration = /#na;([^;\n]+);?/i.exec(script);
  if (narration?.[1]) {
    return narration[1];
  }

  if (/#title/i.test(script)) {
    return "title";
  }
  if (/#place/i.test(script)) {
    return "place";
  }
  return "";
}

function inferRole(unit) {
  const script = String(unit.ScriptKr ?? "");
  if (/#title/i.test(script)) return "title";
  if (/#place/i.test(script)) return "place";
  if (/#na/i.test(script)) return "narration";
  if (/^(?!#)[1-5];/m.test(script)) return "dialogue";
  return "text";
}

function collectCharacters(textUnits) {
  const map = new Map();
  for (const unit of textUnits) {
    for (const line of unit.scriptKr.split("\n")) {
      const match = /^(?!#)([1-5]);([^;\n]+);([^;\n]+);?([^;\n]+)?/.exec(
        line.trim()
      );
      if (!match) continue;
      const name = match[2];
      const glossaryEntry = findGlossaryEntryByKorean(name);
      const record = map.get(name) || {
        name,
        zhName: glossaryEntry?.zh || "",
        jaAliases: glossaryEntry?.ja || [],
        koAliases: glossaryEntry?.ko || [],
        appearances: 0,
        firstIndex: unit.index,
        sampleLines: [],
      };
      record.appearances++;
      if (record.sampleLines.length < 3 && unit.textJp) {
        record.sampleLines.push(unit.textJp.replace(/\n/g, " / "));
      }
      map.set(name, record);
    }
  }
  return [...map.values()].sort((a, b) => a.firstIndex - b.firstIndex);
}

function findGlossaryEntryByKorean(name) {
  return characterNameGlossary.find(entry => entry.ko.includes(name));
}

function buildTerminology() {
  return {
    rules: [
      "When TextJp contains a Japanese name listed here, TextCn must use the exact zh value.",
      "Honorifics may be localized naturally, e.g. さん as 同学/小姐 when appropriate.",
      "Do not use forbiddenZh forms for the corresponding source name.",
      "Speaker names in ScriptKr help identify who is talking, but do not force adding the speaker name to every line.",
    ],
    characterNames: characterNameGlossary.map(entry => ({
      zh: entry.zh,
      ja: entry.ja,
      ko: entry.ko,
      forbiddenZh: entry.forbiddenZh,
    })),
  };
}

function buildOutline(textUnits) {
  return textUnits.map(unit => ({
    index: unit.index,
    role: unit.role,
    speaker: unit.speaker,
    textJp: compactText(unit.textJp, 140),
  }));
}

function buildContextWindow(textUnits, firstTargetIndex, lastTargetIndex, radius) {
  const firstTextIndex = textUnits.findIndex(unit => unit.index === firstTargetIndex);
  const lastTextIndex = textUnits.findIndex(unit => unit.index === lastTargetIndex);
  const start = Math.max(0, firstTextIndex - radius);
  const end = Math.min(textUnits.length, lastTextIndex + radius + 1);
  return textUnits.slice(start, end).map(unit => ({
    index: unit.index,
    role: unit.role,
    speaker: unit.speaker,
    textJp: unit.textJp,
    scriptCues: summarizeScriptCues(unit.scriptKr),
    sound: unit.sound,
    bgmId: unit.bgmId,
    isTarget: unit.index >= firstTargetIndex && unit.index <= lastTargetIndex,
  }));
}

function summarizeScriptCues(script) {
  return script
    .split("\n")
    .map(line => line.trim())
    .filter(line => /^#/.test(line))
    .join(" ");
}

function compactText(text, maxLength) {
  const normalized = String(text).replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function shouldProcess(unit, force) {
  if (!unit.textJp.trim()) return false;
  if (force) return true;
  return !unit.textCn.trim() || !unit.textJpVoice.trim();
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function buildPrompt({ story, textUnits, characters, outline, batch, context }) {
  const storyTitle =
    textUnits.find(unit => unit.role === "title")?.textJp ||
    `Story ${story.GroupId}`;
  const storyPlace = textUnits.find(unit => unit.role === "place")?.textJp || "";

  return JSON.stringify(
    {
      task: [
        "Localize the target Blue Archive story lines into Simplified Chinese",
        "and create Japanese TTS emotion-tag text.",
      ].join(" "),
      story: {
        groupId: story.GroupId,
        titleJp: storyTitle,
        placeJp: storyPlace,
        translator: story.translator || "",
      },
      styleGuide: {
        textCn: [
          "Natural Simplified Chinese, anime/light-novel dialogue tone,",
          "keep humor and character voice, avoid literal machine translation.",
        ].join(" "),
        textJpVoice: [
          "Original Japanese with inserted [tag] voice/emotion directions only.",
          "Keep Japanese wording intact. Use expressive but controlled tags.",
          "Place tags where the delivery changes, including mid-line when useful.",
        ].join(" "),
        tagDensity: [
          "Dialogue with clear acting cues should usually get 1-3 tags.",
          "Very expressive lines can use up to 4 tags.",
          "Titles, places, and neutral narration usually get no tags.",
        ].join(" "),
        voiceTagExamples,
      },
      terminology: buildTerminology(),
      characters,
      globalOutline: outline,
      localContext: context,
      targetLines: batch.map(unit => ({
        index: unit.index,
        role: unit.role,
        speaker: unit.speaker,
        textJp: unit.textJp,
        scriptKr: unit.scriptKr,
        sound: unit.sound,
        bgmId: unit.bgmId,
        popup: unit.popup,
      })),
      outputContract: {
        items:
          "Return one item for every targetLines entry, same index values, no extra or missing lines.",
        itemShape: {
          index: "number",
          TextCn: "Simplified Chinese translation",
          TextJpVoice: "Japanese source text with bracket emotion tags",
        },
      },
    },
    null,
    2
  );
}

function makeResponseSchema(Type) {
  return {
    type: Type.OBJECT,
    properties: {
      items: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            index: { type: Type.INTEGER },
            TextCn: { type: Type.STRING },
            TextJpVoice: { type: Type.STRING },
          },
          required: ["index", "TextCn", "TextJpVoice"],
        },
      },
    },
    required: ["items"],
  };
}

async function loadGoogleGenAI() {
  try {
    return await import("@google/genai");
  } catch (error) {
    throw new Error(
      [
        "Missing official Google Gen AI SDK package: @google/genai.",
        "Install it before running this script, for example:",
        "  cd apps/blue-archive-story-viewer",
        "  pnpm add @google/genai",
        `Original error: ${error.message}`,
      ].join("\n")
    );
  }
}

function extractResponseText(response) {
  if (typeof response?.text === "string") {
    return response.text;
  }
  const parts = response?.candidates?.[0]?.content?.parts ?? [];
  return parts.map(part => part.text ?? "").join("");
}

function parseJsonResponse(text) {
  const raw = String(text ?? "").trim();
  const unwrapped = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  return JSON.parse(unwrapped);
}

function validateBatchResponse(parsed, batch) {
  if (!parsed || !Array.isArray(parsed.items)) {
    throw new Error("Response must be an object with an items array");
  }

  const expected = new Set(batch.map(unit => unit.index));
  const actual = new Set(parsed.items.map(item => item.index));
  for (const index of expected) {
    if (!actual.has(index)) {
      throw new Error(`Missing result for index ${index}`);
    }
  }
  for (const index of actual) {
    if (!expected.has(index)) {
      throw new Error(`Unexpected result for index ${index}`);
    }
  }

  for (const item of parsed.items) {
    if (typeof item.TextCn !== "string" || typeof item.TextJpVoice !== "string") {
      throw new Error(`Invalid item payload for index ${item.index}`);
    }
    if (!item.TextCn.trim()) {
      throw new Error(`Empty TextCn for index ${item.index}`);
    }
    if (!item.TextJpVoice.trim()) {
      throw new Error(`Empty TextJpVoice for index ${item.index}`);
    }
    validateTerminology(item, batch);
  }

  return parsed.items;
}

function validateTerminology(item, batch) {
  const sourceUnit = batch.find(unit => unit.index === item.index);
  if (!sourceUnit) return;

  for (const entry of characterNameGlossary) {
    const mentionedInJp = entry.ja.some(alias => sourceUnit.textJp.includes(alias));
    if (!mentionedInJp) {
      continue;
    }

    if (!item.TextCn.includes(entry.zh)) {
      throw new Error(
        `TextCn for index ${item.index} must use ${entry.zh} for ${entry.ja.join("/")}`
      );
    }

    for (const forbidden of entry.forbiddenZh) {
      if (item.TextCn.includes(forbidden)) {
        throw new Error(
          `TextCn for index ${item.index} used forbidden name ${forbidden}; use ${entry.zh}`
        );
      }
    }
  }
}

async function generateBatch(ai, Type, args, prompt, batch, retryContext = "") {
  const responseSchema = makeResponseSchema(Type);
  const contents = retryContext
    ? `${prompt}\n\nPrevious response validation error:\n${retryContext}\nRegenerate the full JSON batch.`
    : prompt;

  const response = await ai.models.generateContent({
    model: args.model,
    contents,
    config: {
      systemInstruction,
      temperature: 0.35,
      responseMimeType: "application/json",
      responseSchema,
    },
  });

  const responseText = extractResponseText(response);
  const parsed = parseJsonResponse(responseText);
  return validateBatchResponse(parsed, batch);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const storyPath = resolveStoryPath(args);
  if (!fs.existsSync(storyPath)) {
    throw new Error(`Story file not found: ${storyPath}`);
  }

  const outputPath = args.output
    ? path.resolve(process.cwd(), args.output)
    : storyPath;
  const story = JSON.parse(fs.readFileSync(storyPath, "utf8"));
  if (!story || !Array.isArray(story.content)) {
    throw new Error("Story JSON must have a content array");
  }

  const textUnits = collectTextUnits(story);
  let targets = textUnits.filter(unit => shouldProcess(unit, args.force));
  if (args.limit > 0) {
    targets = targets.slice(0, args.limit);
  }

  const batches = chunkArray(targets, args.batchSize);
  const plan = {
    storyPath,
    outputPath,
    model: args.model,
    project: resolveProject(args) || "(missing)",
    location: resolveLocation(args),
    totalTextUnits: textUnits.length,
    targetUnits: targets.length,
    batches: batches.length,
    force: args.force,
  };

  if (args.dryRun) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  const project = resolveProject(args);
  if (!project) {
    throw new Error(
      "Missing Vertex project id. Set GOOGLE_CLOUD_PROJECT or pass --project."
    );
  }

  const { GoogleGenAI, Type } = await loadGoogleGenAI();
  const ai = new GoogleGenAI({
    vertexai: true,
    project,
    location: resolveLocation(args),
  });

  const characters = collectCharacters(textUnits);
  const outline = buildOutline(textUnits);

  console.log(JSON.stringify(plan, null, 2));

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    const firstIndex = batch[0].index;
    const lastIndex = batch[batch.length - 1].index;
    const context = buildContextWindow(
      textUnits,
      firstIndex,
      lastIndex,
      args.contextRadius
    );
    const prompt = buildPrompt({
      story,
      textUnits,
      characters,
      outline,
      batch,
      context,
    });

    let items;
    let lastError = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        items = await generateBatch(ai, Type, args, prompt, batch, lastError);
        break;
      } catch (error) {
        lastError = error.message;
        if (attempt === 3) {
          throw new Error(
            `Batch ${batchIndex + 1}/${batches.length} failed: ${lastError}`
          );
        }
        console.warn(
          `Batch ${batchIndex + 1}/${batches.length} attempt ${attempt} failed: ${lastError}`
        );
      }
    }

    for (const item of items) {
      const unit = story.content[item.index];
      unit.TextCn = item.TextCn.trim();
      unit.TextJpVoice = item.TextJpVoice.trim();
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(story, null, 2)}\n`);
    console.log(
      `Batch ${batchIndex + 1}/${batches.length} written (${batch.length} lines)`
    );
  }

  console.log(`Done: ${outputPath}`);
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
