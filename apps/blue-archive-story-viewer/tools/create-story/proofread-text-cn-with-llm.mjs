import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

import yaml from "js-yaml";

import {
  loadTraditionalToSimplifiedCharacterNameMap,
  resolveStoryCharacterRoster,
} from "./ba-character-catalog.mjs";
import { normalizeExistingTextCnCharacterNames } from "./fill-text-cn-from-tw.mjs";
import {
  inferScenarioRole,
  isAnonymousScenarioSpeaker,
  parseScenarioScriptSpeakers,
} from "./scenario-script-speakers.mjs";
import { verifyCnProofreadDiff } from "./verify-cn-proofread-diff.mjs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..", "..");
const repoRoot = path.resolve(appRoot, "..", "..");

const defaultModel = "gemini-3.7-flash";
const defaultThinkingLevel = "MEDIUM";
const defaultBatchSize = 18;
const defaultContextRadius = 10;
const defaultPasses = 2;
const promptVersion = 3;
const defaultCacheRoot = path.join(
  appRoot,
  ".local-files",
  "cn-proofread-cache",
);
const defaultReportRoot = path.join(
  appRoot,
  ".local-files",
  "cn-proofread-reports",
);
const defaultTemporaryRoot = path.join(
  appRoot,
  ".local-files",
  "tmp",
  "cn-proofread",
);
const playerStudentsYamlPath = path.join(
  appRoot,
  "public",
  "config",
  "yaml",
  "students.yaml",
);

loadEnvFile(path.join(appRoot, ".env"));
loadEnvFile(path.join(repoRoot, ".env"));

const systemInstruction = `You are a conservative senior Simplified Chinese
localization proofreader for Blue Archive story scripts.

You receive Japanese source text, Traditional Chinese source text, the current
Simplified Chinese translation, story context, speaker identity, and an
authoritative character-name glossary.

Your task is to correct objective localization defects in current TextCn while
preserving correct text. This is proofreading, not creative rewriting.

Rules:
- Use Japanese as the semantic authority. Use Traditional Chinese as an
  additional translation reference, and use the glossary as the authority for
  Simplified Chinese character names and nicknames.
- Make the smallest change that fixes a real problem. Do not polish, paraphrase,
  modernize, embellish, censor, or harmonize wording merely for style.
- Correct mistranslations, missing or added meaning, wrong referents, inconsistent
  terminology, and character-name conversion errors supported by the sources or
  context.
- Independently audit every third-person Chinese pronoun in every target line.
  Traditional Chinese often uses 他 for a person of any gender, so never copy its
  gender mechanically. Resolve the referent from Japanese, story context, speaker
  identity, and the character glossary. All student characters listed in the
  supplied glossary are female. Preserve genuine lexical uses such as 其他 and 他人.
- Character names can be interrupted, stuttered, repeated, abbreviated, split by
  punctuation, or alternate between a nickname and a full name. Infer whether a
  fragment semantically belongs to a canonical name and render every such
  fragment consistently in Simplified Chinese. Do not assume an unmatched
  fragment is ordinary prose merely because it is not an exact glossary key.
- The playerStudentNames entries explicitly distinguish familyName,
  personalName, and fullName. Treat their Simplified Chinese forms as
  authoritative, including when only a family name occurs in dialogue. Never
  invent or transliterate a family name when an authoritative entry is present.
- Preserve the original TextCn line-break count and line-break positions as much
  as possible. Never merge or split lines. Before returning each item, verify
  that its TextCn contains exactly requiredLineBreakCount newline characters.
- Preserve every player markup token exactly, including selection tags and ruby
  tags. The returned tokens must exactly equal requiredMarkupTokens in the same
  order. Never add, remove, rename, reorder, or normalize markup.
- Preserve quotation style, punctuation intensity, speaker register, intentional
  repetition, hesitation, and incomplete sentences unless they are themselves a
  source-inconsistent error.
- Return the current TextCn unchanged when there is no objective defect.
- TextCn must contain only the final subtitle. Never put explanations,
  instructions, validation notes, labels, or other meta-commentary inside it.
  Do not introduce Latin-script words that do not occur in any supplied source
  or the current TextCn.
- Return strict JSON only. No markdown.`;

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(trimmed);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function resolveProject(options = {}) {
  return options.project ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCLOUD_PROJECT ||
    process.env.GCP_PROJECT ||
    process.env.VERTEX_PROJECT_ID ||
    process.env.GOOGLE_VERTEX_PROJECT ||
    "";
}

function resolveLocation(options = {}) {
  return options.location ||
    process.env.GOOGLE_CLOUD_LOCATION ||
    process.env.GOOGLE_CLOUD_REGION ||
    process.env.VERTEX_LOCATION ||
    process.env.GOOGLE_VERTEX_LOCATION ||
    "us-central1";
}

function compactText(value, maxLength = 180) {
  const normalized = String(value ?? "").replace(/\s+/gu, " ").trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 1)}…`;
}

function inferSpeaker(unit) {
  return parseScenarioScriptSpeakers(unit).dialogueSpeaker || "";
}

function collectTextUnits(story) {
  return story.content
    .map((unit, index) => ({
      index,
      role: inferScenarioRole(unit),
      speaker: inferSpeaker(unit),
      speakerCandidates: parseScenarioScriptSpeakers(unit).speakers,
      textJp: String(unit.TextJp ?? ""),
      textTw: String(unit.TextTw ?? ""),
      textCn: String(unit.TextCn ?? ""),
      scriptKr: String(unit.ScriptKr ?? ""),
    }))
    .filter(unit =>
      unit.textCn.trim() && (unit.textJp.trim() || unit.textTw.trim()),
    );
}

function chunkArray(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function collectLocalContext(textUnits, batch, radius) {
  const first = textUnits.findIndex(unit => unit.index === batch[0].index);
  const last = textUnits.findIndex(
    unit => unit.index === batch[batch.length - 1].index,
  );
  return textUnits
    .slice(Math.max(0, first - radius), Math.min(textUnits.length, last + radius + 1))
    .map(unit => ({
      index: unit.index,
      role: unit.role,
      speaker: unit.speaker,
      TextJp: unit.textJp,
      TextTw: unit.textTw,
      isTarget: batch.some(target => target.index === unit.index),
    }));
}

async function buildCharacterGlossary(
  textUnits,
  characterNameMappings,
  logger,
) {
  const fullTraditionalText = textUnits.map(unit => unit.textTw).join("\n");
  const fullSimplifiedText = textUnits.map(unit => unit.textCn).join("\n");
  const entries = [];
  for (const [traditional, simplified] of characterNameMappings) {
    if (
      fullTraditionalText.includes(traditional) ||
      fullSimplifiedText.includes(simplified)
    ) {
      entries.push({ traditional, simplified });
    }
  }

  const speakers = [...new Set(
    textUnits.flatMap(unit => unit.speakerCandidates)
      .filter(speaker =>
        speaker &&
        !isAnonymousScenarioSpeaker(speaker) &&
        !/^\([^)]*\)$/u.test(speaker),
      ),
  )];
  const characters = [];
  for (const speaker of speakers) {
    try {
      const roster = await resolveStoryCharacterRoster([{ speaker }]);
      const resolved = roster.get(speaker);
      if (!resolved) continue;
      const row = resolved.playerCharacter;
      characters.push({
        scriptSpeaker: speaker,
        nameJp: row.NameJP || "",
        nameTw: row.NameTW || "",
        nameCn: row.NameCN || resolved.translationName || "",
        nicknameTw: row.NicknameTW || "",
        nicknameCn: row.NicknameCN || "",
      });
    } catch (error) {
      logger.warn(
        `CN proofreader could not resolve speaker ${speaker}: ${error.message}`,
      );
    }
  }

  const playerStudents = yaml.load(
    fs.readFileSync(playerStudentsYamlPath, "utf8"),
  );
  if (!Array.isArray(playerStudents)) {
    throw new Error(`${playerStudentsYamlPath} must contain an array`);
  }
  const playerStudentNames = [];
  const seenPlayerNames = new Set();
  for (const character of characters) {
    const matchingStudents = playerStudents.filter(student =>
      student?.name?.jp === character.nameJp &&
      student?.name?.cn === character.nameCn,
    );
    for (const student of matchingStudents) {
      const familyName = {
        jp: String(student.familyName?.jp ?? ""),
        tw: String(student.familyName?.tw ?? ""),
        cn: String(student.familyName?.cn ?? ""),
      };
      const personalName = {
        jp: String(student.name?.jp ?? ""),
        tw: String(student.name?.tw ?? ""),
        cn: String(student.name?.cn ?? ""),
      };
      if (!personalName.jp || !personalName.cn) continue;
      const fullName = {
        jp: `${familyName.jp}${personalName.jp}`,
        tw: `${familyName.tw}${personalName.tw}`,
        cn: `${familyName.cn}${personalName.cn}`,
      };
      const key = JSON.stringify({ familyName, personalName, fullName });
      if (seenPlayerNames.has(key)) continue;
      seenPlayerNames.add(key);
      playerStudentNames.push({
        studentId: student.id,
        familyName,
        personalName,
        fullName,
      });
    }
  }

  return {
    mappedNames: entries.sort((left, right) =>
      [...right.traditional].length - [...left.traditional].length,
    ),
    storyCharacters: characters,
    playerStudentNames,
  };
}

export function buildPrompt({
  story,
  textUnits,
  glossary,
  batch,
  context,
  guidance = "",
}) {
  return JSON.stringify(
    {
      task: "Conservatively proofread current TextCn for the target lines.",
      reviewerGuidance: String(guidance).trim() || undefined,
      story: {
        groupId: story.GroupId,
        translator: story.translator || "",
      },
      authoritativeCharacterGlossary: glossary,
      globalStoryOutline: textUnits.map(unit => ({
        index: unit.index,
        role: unit.role,
        speaker: unit.speaker,
        TextJp: compactText(unit.textJp),
        TextTw: compactText(unit.textTw),
      })),
      localContext: context,
      targetLines: batch.map(unit => ({
        index: unit.index,
        role: unit.role,
        speaker: unit.speaker,
        scriptKr: unit.scriptKr,
        TextJp: unit.textJp,
        TextTw: unit.textTw,
        currentTextCn: unit.textCn,
        requiredLineBreakCount: countLineBreaks(unit.textCn),
        requiredMarkupTokens: structuralTokens(unit.textCn),
        requiredStylisticPunctuationTokens:
          stylisticPunctuationTokens(unit.textCn),
      })),
      outputContract: {
        items: "Exactly one item per target line, with identical indices.",
        structure: "For every item, preserve requiredLineBreakCount, " +
          "requiredMarkupTokens, and requiredStylisticPunctuationTokens exactly.",
        mandatoryReview:
          "Before returning, independently review every target line for " +
          "pronoun referents even when it has no other change.",
        itemShape: {
          index: "integer",
          TextCn: "final Simplified Chinese text, unchanged if already correct",
          issueTypes: "array of short general issue categories, empty if unchanged",
          rationale: "short evidence-based explanation, empty if unchanged",
        },
      },
    },
    null,
    2,
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
            issueTypes: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
            rationale: { type: Type.STRING },
          },
          required: ["index", "TextCn", "issueTypes", "rationale"],
        },
      },
    },
    required: ["items"],
  };
}

function extractResponseText(response) {
  if (typeof response?.text === "string") return response.text;
  const parts = response?.candidates?.[0]?.content?.parts ?? [];
  return parts.map(part => part.text ?? "").join("");
}

function parseJsonResponse(text) {
  return JSON.parse(
    String(text ?? "")
      .trim()
      .replace(/^```(?:json)?\s*/iu, "")
      .replace(/\s*```$/u, "")
      .trim(),
  );
}

function structuralTokens(text) {
  return String(text).match(/\[(?:n?s\d*|\/?ruby(?:=[^\]]+)?)\]/gu) ?? [];
}

function countLineBreaks(text) {
  return (String(text).match(/\n/gu) ?? []).length;
}

function asciiWordTokens(text) {
  return String(text).match(/[A-Za-z][A-Za-z/-]{2,}/gu) ?? [];
}

function stylisticPunctuationTokens(text) {
  return String(text).match(/[．·─—「」『』]/gu) ?? [];
}

export function validateProofreadBatch(parsed, batch) {
  if (!parsed || !Array.isArray(parsed.items)) {
    throw new Error("Response must be an object with an items array");
  }
  if (parsed.items.length !== batch.length) {
    throw new Error(
      `Expected ${batch.length} items, received ${parsed.items.length}`,
    );
  }

  const originals = new Map(batch.map(unit => [unit.index, unit.textCn]));
  const seen = new Set();
  for (const item of parsed.items) {
    if (!originals.has(item.index) || seen.has(item.index)) {
      throw new Error(`Unexpected or duplicate result index ${item.index}`);
    }
    seen.add(item.index);
    if (typeof item.TextCn !== "string" || !item.TextCn.trim()) {
      throw new Error(`TextCn must remain non-empty at index ${item.index}`);
    }
    if (!Array.isArray(item.issueTypes) || typeof item.rationale !== "string") {
      throw new Error(`Invalid audit fields at index ${item.index}`);
    }
    const original = originals.get(item.index);
    if (countLineBreaks(item.TextCn) !== countLineBreaks(original)) {
      throw new Error(`Line-break count changed at index ${item.index}`);
    }
    if (
      JSON.stringify(structuralTokens(item.TextCn)) !==
      JSON.stringify(structuralTokens(original))
    ) {
      throw new Error(`Player markup changed at index ${item.index}`);
    }
    const sourceAsciiWords = new Set(asciiWordTokens(
      `${original}\n${batch.find(unit => unit.index === item.index)?.textJp ?? ""}` +
      `\n${batch.find(unit => unit.index === item.index)?.textTw ?? ""}`,
    ));
    const introducedAsciiWord = asciiWordTokens(item.TextCn)
      .find(word => !sourceAsciiWords.has(word));
    if (introducedAsciiWord) {
      throw new Error(
        `Unsubstantiated Latin text introduced at index ${item.index}: ` +
        introducedAsciiWord,
      );
    }
    if (
      JSON.stringify(stylisticPunctuationTokens(item.TextCn)) !==
      JSON.stringify(stylisticPunctuationTokens(original))
    ) {
      throw new Error(`Punctuation style changed at index ${item.index}`);
    }
  }
  return parsed.items;
}

async function loadGoogleGenAI() {
  try {
    return await import("@google/genai");
  } catch (error) {
    throw new Error(`Cannot load @google/genai: ${error.message}`);
  }
}

function digestPrompt(location, model, thinkingLevel, prompt) {
  return crypto
    .createHash("sha256")
    .update(
      `${promptVersion}\nvertex\n${location}\n${model}\n${thinkingLevel}\n` +
      `${systemInstruction}\n${prompt}`,
    )
    .digest("hex");
}

function safePathPart(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/gu, "_");
}

function readCachedItems(cachePath, batch) {
  if (!fs.existsSync(cachePath)) return undefined;
  const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  return validateProofreadBatch(parsed, batch);
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(temporaryPath, filePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

async function generateVertexBatch(
  ai,
  Type,
  model,
  thinkingLevel,
  prompt,
  batch,
  retryContext,
) {
  const contents = retryContext
    ? `${prompt}\n\nThe previous response failed validation:\n` +
      `${retryContext}\nReturn the complete corrected batch again.`
    : prompt;
  const response = await ai.models.generateContent({
    model,
    contents,
    config: {
      systemInstruction,
      thinkingConfig: { thinkingLevel },
      responseMimeType: "application/json",
      responseSchema: makeResponseSchema(Type),
    },
  });
  return validateProofreadBatch(
    parseJsonResponse(extractResponseText(response)),
    batch,
  );
}

function addProofreaderSource(story, source) {
  const sources = String(story.proofreader ?? "")
    .split(/\s+\+\s+/u)
    .map(value => value.trim())
    .filter(Boolean);
  if (!sources.includes(source)) sources.push(source);
  story.proofreader = sources.join(" + ");
}

async function proofreadStoryTextCnOnePassWithLlm(story, options = {}) {
  if (!story || !Array.isArray(story.content)) {
    throw new Error("Story JSON must contain content[]");
  }
  const storyBeforeProofread = structuredClone(story);
  const logger = options.logger ?? console;
  const model = options.model || process.env.CN_PROOFREAD_MODEL || defaultModel;
  const thinkingLevel = String(
    options.thinkingLevel ||
    process.env.CN_PROOFREAD_THINKING_LEVEL ||
    defaultThinkingLevel,
  ).toUpperCase();
  if (!["MINIMAL", "LOW", "MEDIUM", "HIGH"].includes(thinkingLevel)) {
    throw new Error(`Unsupported thinking level: ${thinkingLevel}`);
  }
  const batchSize = options.batchSize || defaultBatchSize;
  const contextRadius = options.contextRadius || defaultContextRadius;
  const cacheRoot = options.cacheRoot || defaultCacheRoot;
  const mappings = options.characterNameMappings ||
    await loadTraditionalToSimplifiedCharacterNameMap();
  const deterministicNames = normalizeExistingTextCnCharacterNames(
    story.content,
    mappings,
  );
  const textUnits = collectTextUnits(story);
  let targets = textUnits;
  if (options.limit > 0) targets = targets.slice(0, options.limit);
  const batches = chunkArray(targets, batchSize);
  const glossary = await buildCharacterGlossary(textUnits, mappings, logger);
  const project = resolveProject(options);
  if (!options.ai && !project && batches.length > 0) {
    throw new Error(
      "Missing Vertex project id. Set GOOGLE_CLOUD_PROJECT or pass project.",
    );
  }

  let ai = options.ai;
  let Type = options.Type;
  if (ai && !Type && batches.length > 0) {
    throw new Error("Type is required when a custom AI client is supplied");
  }
  if (!ai && batches.length > 0) {
    const sdk = await loadGoogleGenAI();
    Type = sdk.Type;
    ai = new sdk.GoogleGenAI({
      vertexai: true,
      project,
      location: resolveLocation(options),
    });
  }

  const changes = [];
  let cacheHits = 0;
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    const context = collectLocalContext(textUnits, batch, contextRadius);
    const prompt = buildPrompt({
      story,
      textUnits,
      glossary,
      batch,
      context,
      guidance: options.guidance,
    });
    const digest = digestPrompt(
      resolveLocation(options),
      model,
      thinkingLevel,
      prompt,
    );
    const cachePath = path.join(
      cacheRoot,
      String(story.GroupId || "unknown"),
      "vertex",
      safePathPart(model),
      `${digest}.json`,
    );
    let items;
    if (!options.refreshCache) {
      try {
        items = readCachedItems(cachePath, batch);
      } catch (error) {
        logger.warn(
          `Ignoring invalid CN proofread cache ${cachePath}: ${error.message}`,
        );
      }
    }
    if (items) {
      cacheHits++;
    } else {
      let lastError = "";
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          items = await generateVertexBatch(
            ai,
            Type,
            model,
            thinkingLevel,
            prompt,
            batch,
            lastError,
          );
          writeJsonAtomic(cachePath, { items });
          break;
        } catch (error) {
          lastError = error.message;
          if (attempt === 3) {
            throw new Error(
              `CN proofread batch ${batchIndex + 1}/${batches.length} failed: ${lastError}`,
            );
          }
          logger.warn(
            `CN proofread batch ${batchIndex + 1}/${batches.length} attempt ${attempt} failed: ${lastError}`,
          );
        }
      }
    }

    for (const item of items) {
      const unit = story.content[item.index];
      const before = String(unit.TextCn ?? "");
      if (item.TextCn !== before) {
        unit.TextCn = item.TextCn;
        changes.push({
          index: item.index,
          before,
          after: item.TextCn,
          issueTypes: item.issueTypes,
          rationale: item.rationale,
          TextJp: String(unit.TextJp ?? ""),
          TextTw: String(unit.TextTw ?? ""),
        });
      }
    }
    logger.log(
      `CN proofread batch ${batchIndex + 1}/${batches.length} complete`,
    );
  }

  if (!options.limit || options.limit >= textUnits.length) {
    addProofreaderSource(
      story,
      `Gemini ${model} ${thinkingLevel} CN review`,
    );
  }
  verifyCnProofreadDiff(storyBeforeProofread, story);
  return {
    model,
    thinkingLevel,
    guidance: String(options.guidance ?? "").trim(),
    deterministicNameRows: deterministicNames.changedRows,
    textUnits: textUnits.length,
    batches: batches.length,
    cacheHits,
    changes,
  };
}

export async function proofreadStoryTextCnWithLlm(story, options = {}) {
  const passes = Number(options.passes ?? defaultPasses);
  if (!Number.isSafeInteger(passes) || passes <= 0) {
    throw new Error(`passes must be a positive integer, received: ${passes}`);
  }
  const storyBeforeAllPasses = structuredClone(story);
  const logger = options.logger ?? console;
  const passResults = [];
  for (let pass = 1; pass <= passes; pass++) {
    logger.log(`CN proofread pass ${pass}/${passes} starting`);
    const result = await proofreadStoryTextCnOnePassWithLlm(story, {
      ...options,
      refreshCache: Boolean(options.refreshCache) || pass > 1,
    });
    passResults.push(result);
    logger.log(
      `CN proofread pass ${pass}/${passes} complete: ` +
      `${result.changes.length} edits`,
    );
  }
  verifyCnProofreadDiff(storyBeforeAllPasses, story);
  const netChanges = [];
  for (let index = 0; index < story.content.length; index++) {
    const before = String(storyBeforeAllPasses.content[index]?.TextCn ?? "");
    const after = String(story.content[index]?.TextCn ?? "");
    if (before !== after) netChanges.push({ index, before, after });
  }
  const lastResult = passResults.at(-1);
  return {
    ...lastResult,
    passes,
    passResults,
    changes: passResults.flatMap((result, index) =>
      result.changes.map(change => ({ pass: index + 1, ...change })),
    ),
    netChanges,
    cacheHits: passResults.reduce((sum, result) => sum + result.cacheHits, 0),
    batches: passResults.reduce((sum, result) => sum + result.batches, 0),
  };
}

function printUsage() {
  console.log(`Usage:
  node ./tools/create-story/proofread-text-cn-with-llm.mjs <story-json-or-directory> [options]

Options:
  --model <model>         Vertex Gemini model, default: ${defaultModel}
  --thinking-level <level>
                          minimal, low, medium or high; default: ${defaultThinkingLevel.toLowerCase()}
  --project <project>     Vertex project id, defaults to environment
  --location <location>   Vertex location, default: us-central1
  --batch-size <n>        target rows per call, default: ${defaultBatchSize}
  --context-radius <n>    neighboring rows in full detail, default: ${defaultContextRadius}
  --passes <n>            independent proofreading passes, default: ${defaultPasses}
  --limit <n>             process at most n rows per story
  --refresh-cache         ignore cached model responses
  --dry-run               list files and row counts without calling Vertex
  --help, -h              show this help
`);
}

function readOptionValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function positiveInteger(value, option) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive integer`);
  }
  return parsed;
}

function parseArgs(argv) {
  const args = {
    source: "",
    model: process.env.CN_PROOFREAD_MODEL || defaultModel,
    thinkingLevel:
      process.env.CN_PROOFREAD_THINKING_LEVEL || defaultThinkingLevel,
    project: "",
    location: "",
    batchSize: defaultBatchSize,
    contextRadius: defaultContextRadius,
    passes: defaultPasses,
    limit: 0,
    refreshCache: false,
    dryRun: false,
    help: false,
  };
  const positional = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    switch (arg) {
      case "--model":
        args.model = readOptionValue(argv, ++index, arg);
        break;
      case "--thinking-level":
        args.thinkingLevel = readOptionValue(argv, ++index, arg);
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
      case "--passes":
        args.passes = positiveInteger(readOptionValue(argv, ++index, arg), arg);
        break;
      case "--limit":
        args.limit = positiveInteger(readOptionValue(argv, ++index, arg), arg);
        break;
      case "--refresh-cache":
        args.refreshCache = true;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
        positional.push(arg);
    }
  }
  args.source = positional[0] || "";
  if (positional.length > 1) {
    throw new Error(`Unexpected arguments: ${positional.slice(1).join(" ")}`);
  }
  return args;
}

function resolveStoryFiles(source) {
  const sourcePath = path.resolve(process.cwd(), source);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Story path does not exist: ${sourcePath}`);
  }
  if (fs.statSync(sourcePath).isDirectory()) {
    return fs.readdirSync(sourcePath)
      .filter(name => name.endsWith(".json"))
      .sort()
      .map(name => path.join(sourcePath, name));
  }
  return [sourcePath];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  if (!args.source) throw new Error("Missing story JSON or directory");
  const files = resolveStoryFiles(args.source);
  if (!args.dryRun) {
    fs.mkdirSync(defaultTemporaryRoot, { recursive: true });
  }
  const backupRoot = args.dryRun
    ? ""
    : fs.mkdtempSync(path.join(defaultTemporaryRoot, "run-"));
  if (backupRoot) {
    console.log(`CN proofread backups: ${backupRoot}`);
  }
  try {
    for (const storyPath of files) {
      const story = JSON.parse(fs.readFileSync(storyPath, "utf8"));
      const textUnits = collectTextUnits(story);
      if (args.dryRun) {
        console.log(`${storyPath}: ${textUnits.length} proofreadable rows`);
        continue;
      }
      const backupPath = path.join(backupRoot, path.basename(storyPath));
      fs.copyFileSync(storyPath, backupPath);
      const result = await proofreadStoryTextCnWithLlm(story, args);
      writeJsonAtomic(storyPath, story);
      try {
        const diskVerification = verifyCnProofreadDiff(
          JSON.parse(fs.readFileSync(backupPath, "utf8")),
          JSON.parse(fs.readFileSync(storyPath, "utf8")),
        );
        console.log(
          `${storyPath}: disk diff verified; ` +
          `${diskVerification.textCnChanges.length} TextCn changes`,
        );
      } catch (error) {
        const restorePath = `${storyPath}.restore.tmp`;
        fs.copyFileSync(backupPath, restorePath);
        fs.renameSync(restorePath, storyPath);
        throw new Error(
          `Post-write verification failed; restored ${storyPath} from ` +
          `${backupPath}: ${error.message}`,
        );
      }
      const reportPath = path.join(
        defaultReportRoot,
        `${story.GroupId}-${safePathPart(result.model)}-` +
        `${result.thinkingLevel.toLowerCase()}.json`,
      );
      writeJsonAtomic(reportPath, {
        storyPath,
        ...result,
      });
      console.log(
        `${storyPath}: ${result.netChanges.length} net changes across ` +
        `${result.passes} passes; report ${reportPath}`,
      );
    }
  } catch (error) {
    if (backupRoot) {
      console.error(`CN proofread failed; retained recovery files: ${backupRoot}`);
    }
    throw error;
  }
  if (backupRoot) {
    try {
      fs.rmSync(backupRoot, { recursive: true, force: true });
      console.log(`Removed completed CN proofread backups: ${backupRoot}`);
    } catch (error) {
      console.warn(
        `CN proofread succeeded, but temporary backups could not be removed: ` +
        `${backupRoot}: ${error.message}`,
      );
    }
  }
}

const invokedPath = process.argv[1]
  ? url.pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
