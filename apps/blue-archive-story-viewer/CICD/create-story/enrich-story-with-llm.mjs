import fs from "fs";
import path from "path";
import url from "url";
import { resolveStoryCharacterRoster } from "./ba-character-catalog.mjs";
import {
  inferScenarioRole,
  parseScenarioScriptSpeakers,
} from "./scenario-script-speakers.mjs";
import {
  applyStoryTextJpVoiceOverrides,
  voiceTagExamples,
  normalizeTextJpVoice,
} from "./shared-config.mjs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..", "..");

const defaultModel = "gemini-3.6-flash";
const defaultBatchSize = 12;
const defaultContextRadius = 8;

const flatStoryTypes = new Set(["main", "other"]);
const nestedStoryTypes = new Set(["favor", "event", "group", "mini"]);

const systemInstruction = `You are a senior Japanese voice director for Blue Archive.

Your only output for each requested story line is TextJpVoice: the original
Japanese TextJp enriched with concise voice emotion tags.

Rules:
- Use the provided full story outline, character roster, local scene context,
  script cues, SFX, BGM, and neighboring lines.
- TextJpVoice must stay Japanese. Do not translate it.
- TextJpVoice should preserve the original Japanese wording and line breaks,
  only inserting bracket tags like [sigh], [angry], [whisper], [short pause].
- Voice tags support free-form natural-language English descriptions. The
  provided examples are inspiration, not a whitelist. Invent precise tags when
  they better express the intended delivery, while keeping them useful for TTS.
- Be expressive enough for voice generation. Use script cues, punctuation,
  speaker personality, and local context to infer tone.
- For character dialogue, prefer 1-3 tags when there is emotion, breath,
  hesitation, teasing, sarcasm, volume change, or a clear acting beat.
- Emotion tags MUST be placed at the very beginning of the sentence or phrase
  they apply to. NEVER place an emotion tag at the end of a sentence. For
  example: "[excited tone]大丈夫そうですね。" is correct, but
  "大丈夫そうですね。[excited tone]" is strictly forbidden.
- Calm one-sentence dialogue can use 0-1 tag. Do not tag every phrase.
- TextJpVoice must ONLY contain spoken dialogue, emotion tags, and basic punctuation.
- Remove ALL decorative symbols that are not pronounced (e.g., "☆", "★",
  "♪", "♡", "♥", "！？？", "～") from TextJpVoice. Keep only standard
  grammatical punctuation (e.g., "。", "、", "！", "？", "……").
- CRITICAL: Remove all non-spoken sound effects, actions, or onomatopoeia
  enclosed in parentheses like "（ズルッ）", "（ドサッッッ！！！）", or
  "（ガチャッ）" from TextJpVoice. Do NOT output
  "[surprised]ふあっ！？[sigh]（ズルッ）"; it must be just
  "[surprised]ふあっ！？".
- Remove ALL other parenthetical content too, including explanations and
  abbreviations such as "(SNP)". Parentheses and their contents must never
  appear in TextJpVoice.
- If a line contains NO spoken dialogue (e.g., only sound effects or actions), set TextJpVoice to an empty string "".
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
  --force                   reprocess lines that already have TextJpVoice
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
      hasTextJpVoice: Object.hasOwn(unit, "TextJpVoice"),
      scriptKr: String(unit.ScriptKr ?? ""),
      sound: String(unit.Sound ?? ""),
      bgmId: unit.BGMId || 0,
      bgName: unit.BGName || 0,
      popup: String(unit.PopupFileName ?? ""),
      speaker: inferSpeaker(unit),
      speakerCandidates: inferSpeakerCandidates(unit),
      role: inferRole(unit),
    }))
    .filter(unit => unit.textJp.trim());
}

function inferSpeaker(unit) {
  const script = String(unit.ScriptKr ?? "");
  const { dialogueSpeaker } = parseScenarioScriptSpeakers(script);
  if (dialogueSpeaker) {
    return dialogueSpeaker;
  }

  if (/#title/i.test(script)) {
    return "title";
  }
  if (/#place/i.test(script)) {
    return "place";
  }
  return "";
}

function inferSpeakerCandidates(unit) {
  return parseScenarioScriptSpeakers(unit).speakers;
}

function inferRole(unit) {
  return inferScenarioRole(unit);
}

function collectCharacters(textUnits, resolvedRoster = new Map()) {
  const map = new Map();
  for (const unit of textUnits) {
    const name = unit.speaker;
    if (!name) continue;
    const resolved = resolvedRoster.get(name);
    const record = map.get(name) || {
      name,
      zhName: resolved?.translationName || "",
      jaAliases: resolved?.jaAliases || [],
      koAliases: resolved?.koAliases || [],
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
  return [...map.values()].sort((a, b) => a.firstIndex - b.firstIndex);
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

function shouldProcess(unit, force, lockedIndices) {
  if (!unit.textJp.trim()) return false;
  if (unit.role === "option") return false;
  if (lockedIndices.has(unit.index)) return false;
  if (force) return true;
  return !unit.hasTextJpVoice;
}

function removeRawImportVoicePlaceholders(story) {
  if (
    String(story.translator || "").includes("Gemini") ||
    story.content.some(unit => String(unit.VoiceJp || "").trim())
  ) {
    return 0;
  }

  let removed = 0;
  for (const unit of story.content) {
    if (
      Object.hasOwn(unit, "TextJpVoice") &&
      !String(unit.TextJpVoice || "").trim()
    ) {
      delete unit.TextJpVoice;
      removed++;
    }
  }
  return removed;
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function buildPrompt({
  story,
  textUnits,
  characters,
  outline,
  batch,
  context,
}) {
  const storyTitle =
    textUnits.find(unit => unit.role === "title")?.textJp ||
    `Story ${story.GroupId}`;
  const storyPlace = textUnits.find(unit => unit.role === "place")?.textJp || "";

  return JSON.stringify(
    {
      task: [
        "Create Japanese TTS emotion-tag text for the target Blue Archive story lines.",
      ].join(" "),
      story: {
        groupId: story.GroupId,
        titleJp: storyTitle,
        placeJp: storyPlace,
        translator: story.translator || "",
      },
      styleGuide: {
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
        tagVocabulary:
          "Examples are not a whitelist. Use concise free-form English " +
          "descriptions whenever they direct the performance more precisely.",
        voiceTagExamples,
      },
      characters,
      globalOutline: outline,
      localContext: context,
      targetLines: batch.map(unit => ({
        index: unit.index,
        role: unit.role,
        speaker: unit.speaker,
        textJp: unit.textJp,
        textCn: unit.textCn,
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
            TextJpVoice: { type: Type.STRING },
          },
          required: ["index", "TextJpVoice"],
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
    if (typeof item.TextJpVoice !== "string") {
      throw new Error(`Invalid item payload for index ${item.index}`);
    }
    if (item.TextJpVoice === undefined || item.TextJpVoice === null) {
      throw new Error(`Missing TextJpVoice for index ${item.index}`);
    }
  }

  return parsed.items;
}

async function generateBatch(
  ai,
  Type,
  args,
  prompt,
  batch,
  retryContext = "",
) {
  const responseSchema = makeResponseSchema(Type);
  const contents = retryContext
    ? `${prompt}\n\nPrevious response validation error:\n${retryContext}\nRegenerate the full JSON batch.`
    : prompt;

  const response = await ai.models.generateContent({
    model: args.model,
    contents,
    config: {
      systemInstruction,
      responseMimeType: "application/json",
      responseSchema,
    },
  });

  const responseText = extractResponseText(response);
  const parsed = parseJsonResponse(responseText);
  return validateBatchResponse(parsed, batch);
}

async function resolveCharacterRoster(textUnits) {
  return resolveStoryCharacterRoster(
    textUnits
      .filter(
        unit =>
          unit.speaker &&
          !["title", "place"].includes(unit.speaker),
      )
      .map(unit => ({
        speaker: unit.speaker,
        speakerCandidates: unit.speakerCandidates,
      })),
  );
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

  const removedVoicePlaceholders = removeRawImportVoicePlaceholders(story);
  if (removedVoicePlaceholders > 0) {
    console.log(
      `Removed ${removedVoicePlaceholders} empty raw TextJpVoice placeholders`,
    );
  }

  const lockedOverrideIndices = applyStoryTextJpVoiceOverrides(
    String(story.GroupId),
    story.content,
  );
  const textUnits = collectTextUnits(story);
  let targets = textUnits.filter(unit =>
    shouldProcess(unit, args.force, lockedOverrideIndices),
  );
  if (args.limit > 0) {
    targets = targets.slice(0, args.limit);
  }

  const batches = chunkArray(targets, args.batchSize);
  const roster = await resolveCharacterRoster(textUnits);
  const characters = collectCharacters(textUnits, roster);
  const plan = {
    storyPath,
    outputPath,
    model: args.model,
    project: resolveProject(args) || "(missing)",
    location: resolveLocation(args),
    totalTextUnits: textUnits.length,
    targetUnits: targets.length,
    batches: batches.length,
    resolvedCharacters: characters.map(character => ({
      speaker: character.name,
      characterName: character.zhName,
    })),
    force: args.force,
    lockedOverrideIndices: [...lockedOverrideIndices],
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
        items = await generateBatch(
          ai,
          Type,
          args,
          prompt,
          batch,
          lastError,
        );
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
      // Enforce the no-parentheses contract in code instead of trusting model
      // output alone.
      unit.TextJpVoice = normalizeTextJpVoice(item.TextJpVoice);
      if (!unit.TextJpVoice) {
        unit.VoiceJp = "";
      }
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
