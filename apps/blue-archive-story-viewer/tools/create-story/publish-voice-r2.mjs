import fs from "fs";
import crypto from "crypto";
import path from "path";
import url from "url";
import { manifestProvesCurrentAudioPublished } from "./r2-publication-state.mjs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..", "..");
const repoRoot = path.resolve(appRoot, "..", "..");

loadEnvFile(path.join(appRoot, ".env"));
loadEnvFile(path.join(repoRoot, ".env"));

const flatStoryTypes = new Set(["main", "other"]);
const nestedStoryTypes = new Set(["favor", "event", "group", "mini"]);
const audioMimeTypes = new Map([
  [".aac", "audio/aac"],
  [".flac", "audio/flac"],
  [".m4a", "audio/mp4"],
  [".mp3", "audio/mpeg"],
  [".ogg", "audio/ogg"],
  [".opus", "audio/ogg"],
  [".wav", "audio/wav"],
]);

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) {
    return;
  }

  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) {
      continue;
    }

    const key = match[1];
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function printUsage() {
  console.log(`Usage:
  node ./tools/create-story/publish-voice-r2.mjs <story-id-or-json-path> [options]

Options:
  --type <type>             story type when source is an id, default: group
  --directory-id <id>       directory id for favor/event/group/mini
  --output <file>           story JSON to write, default: overwrite source
  --manifest <file>         ZeroTTS manifest, default under .local-files
  --local-file-root <dir>   local file root, default: .local-files
  --bucket <name>           R2 bucket name, default: R2_BUCKET
  --account-id <id>         Cloudflare account id, default: CLOUDFLARE_ACCOUNT_ID
  --access-key-id <key>     R2 S3 access key, default: R2_ACCESS_KEY_ID
  --secret-access-key <key> R2 S3 secret key, default: R2_SECRET_ACCESS_KEY
  --public-base-url <url>   public R2/custom-domain URL, default: R2_PUBLIC_BASE_URL
  --key-prefix <prefix>     R2 object prefix, default: ba-story-viewer
  --cache-control <value>   object Cache-Control, default: public, max-age=31536000, immutable
  --proxy <url>             HTTP/HTTPS proxy URL, default: HTTPS_PROXY or HTTP_PROXY
  --skip-upload             only rewrite VoiceJp URLs
  --missing-only            publish only voice lines whose VoiceJp is empty
  --skip-indices <csv>      keep reviewed no-voice indices empty and do not upload them
  --dry-run                 print planned uploads/rewrites without writing
  --help, -h                show this help

Environment:
  CLOUDFLARE_ACCOUNT_ID
  R2_ACCESS_KEY_ID
  R2_SECRET_ACCESS_KEY
  R2_BUCKET
  R2_PUBLIC_BASE_URL

Example:
  pnpm publish-voice-r2 1101 --type group
`);
}

function parseArgs(argv) {
  const args = {
    source: "",
    type: "group",
    directoryId: "",
    output: "",
    manifest: "",
    localFileRoot:
      process.env.BA_LOCAL_FILE_ROOT || path.resolve(appRoot, ".local-files"),
    bucket: process.env.R2_BUCKET || "",
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID || "",
    accessKeyId: process.env.R2_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "",
    publicBaseUrl: process.env.R2_PUBLIC_BASE_URL || "",
    keyPrefix: process.env.R2_KEY_PREFIX || "ba-story-viewer",
    cacheControl:
      process.env.R2_CACHE_CONTROL || "public, max-age=31536000, immutable",
    proxy:
      process.env.R2_PROXY ||
      process.env.HTTPS_PROXY ||
      process.env.HTTP_PROXY ||
      process.env.ALL_PROXY ||
      "",
    skipUpload: false,
    missingOnly: false,
    skipIndices: [],
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
      case "--manifest":
        args.manifest = readOptionValue(argv, ++index, arg);
        break;
      case "--local-file-root":
        args.localFileRoot = readOptionValue(argv, ++index, arg);
        break;
      case "--bucket":
        args.bucket = readOptionValue(argv, ++index, arg);
        break;
      case "--account-id":
        args.accountId = readOptionValue(argv, ++index, arg);
        break;
      case "--access-key-id":
        args.accessKeyId = readOptionValue(argv, ++index, arg);
        break;
      case "--secret-access-key":
        args.secretAccessKey = readOptionValue(argv, ++index, arg);
        break;
      case "--public-base-url":
        args.publicBaseUrl = readOptionValue(argv, ++index, arg);
        break;
      case "--key-prefix":
        args.keyPrefix = readOptionValue(argv, ++index, arg);
        break;
      case "--cache-control":
        args.cacheControl = readOptionValue(argv, ++index, arg);
        break;
      case "--proxy":
        args.proxy = readOptionValue(argv, ++index, arg);
        break;
      case "--skip-upload":
        args.skipUpload = true;
        break;
      case "--missing-only":
        args.missingOnly = true;
        break;
      case "--skip-indices": {
        const values = readOptionValue(argv, ++index, arg).split(",").map(value => Number(value.trim()));
        if (!values.length || values.some(value => !Number.isSafeInteger(value) || value < 0)) {
          throw new Error("--skip-indices must be a comma-separated list of non-negative integers");
        }
        args.skipIndices = [...new Set(values)];
        break;
      }
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

function validateArgs(args) {
  if (!args.publicBaseUrl) {
    throw new Error("Missing R2_PUBLIC_BASE_URL or --public-base-url");
  }

  if (args.skipUpload || args.dryRun) {
    return;
  }

  const missing = [];
  if (!args.accountId) missing.push("CLOUDFLARE_ACCOUNT_ID");
  if (!args.bucket) missing.push("R2_BUCKET");
  if (!args.accessKeyId) missing.push("R2_ACCESS_KEY_ID");
  if (!args.secretAccessKey) missing.push("R2_SECRET_ACCESS_KEY");
  if (missing.length > 0) {
    throw new Error(`Missing R2 upload configuration: ${missing.join(", ")}`);
  }
}

function storyIdFromPath(storyPath) {
  return path.basename(storyPath, ".json");
}

function resolveManifestPath(args, storyId) {
  if (args.manifest) {
    return path.resolve(process.cwd(), args.manifest);
  }
  return path.join(
    path.resolve(args.localFileRoot),
    "tts",
    args.type,
    storyId,
    "voice-zero-tts-manifest.json",
  );
}

function collectVoiceItems(story, args, manifest) {
  const items = [];
  const localFileRoot = path.resolve(args.localFileRoot);
  const skippedIndices = new Set(args.skipIndices);

  for (const task of Object.values(manifest.tasks || {})) {
    if (task.status !== "COMPLETED" || !Number.isSafeInteger(task.index)) {
      continue;
    }
    if (!story.content[task.index]) {
      throw new Error(`TTS task index is outside story content: ${task.index}`);
    }
    if (skippedIndices.has(task.index)) continue;
    const currentVoiceJp = String(story.content[task.index].VoiceJp || "");
    if (args.missingOnly && currentVoiceJp.trim()) {
      continue;
    }
    const currentVoiceText = String(
      story.content[task.index].TextJpVoice || "",
    ).trim();
    const generatedText = String(
      task.generatedText ?? task.text ?? "",
    ).trim();
    if (!currentVoiceText || generatedText !== currentVoiceText) {
      continue;
    }

    const localPath = path.resolve(String(task.audioPath || ""));
    const relativeToRoot = path.relative(localFileRoot, localPath);
    if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
      throw new Error(`TTS audio escapes local file root at index ${task.index}: ${localPath}`);
    }

    const relativePath = relativeToRoot.split(path.sep).join("/");
    const objectKey = joinUrlPath(args.keyPrefix, relativePath);
    const publicUrl = joinUrlPath(args.publicBaseUrl, objectKey);
    items.push({
      index: task.index,
      localPath,
      relativePath,
      objectKey,
      publicUrl,
      alreadyPublished:
        task.needsPublish !== true &&
        (currentVoiceJp === publicUrl || manifestProvesCurrentAudioPublished(task)),
      task,
    });
  }

  return items.sort((a, b) => a.index - b.index);
}

function joinUrlPath(...parts) {
  return parts
    .filter(part => part !== "")
    .map((part, index) => {
      const value = String(part);
      if (index === 0) {
        return value.replace(/\/+$/, "");
      }
      return value.replace(/^\/+|\/+$/g, "");
    })
    .join("/");
}

async function uploadItems(args, items, manifestPath, manifest) {
  let uploadedCount = 0;
  for (const item of items) {
    if (!fs.existsSync(item.localPath)) {
      throw new Error(`Missing local audio for index ${item.index}: ${item.localPath}`);
    }

    await uploadItemWithRetry(args, item);
    item.task.needsPublish = false;
    item.task.publishedTaskId =
      item.task.taskId || item.task.mix?.inputsHash;
    item.task.publishedText =
      item.task.generatedText ?? item.task.text ?? "";
    item.task.publishedTextHash =
      item.task.generatedTextHash ||
      crypto
        .createHash("sha256")
        .update(String(item.task.publishedText))
        .digest("hex");
    item.task.publishedAt = new Date().toISOString();

    uploadedCount++;
    console.log(`Uploaded (${uploadedCount}/${items.length}) ${item.objectKey}`);

    if (manifestPath && manifest && uploadedCount % 10 === 0) {
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }
  }
}

async function uploadItemWithRetry(args, item, maxRetries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await uploadItem(args, item);
      return;
    } catch (error) {
      lastError = error;
      const causeMsg = error.cause?.message || error.cause || "";
      console.warn(
        `Upload attempt ${attempt}/${maxRetries} failed for ${item.objectKey}: ${error.message}${
          causeMsg ? ` (${causeMsg})` : ""
        }`
      );
      if (attempt < maxRetries) {
        const delayMs = 1000 * Math.pow(2, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

async function uploadItem(args, item) {
  const body = fs.readFileSync(item.localPath);
  const ext = path.extname(item.localPath).toLowerCase();
  const contentType = audioMimeTypes.get(ext) || "application/octet-stream";
  const host = `${args.accountId}.r2.cloudflarestorage.com`;
  const encodedPath = `/${encodePathSegment(args.bucket)}/${encodeObjectKey(item.objectKey)}`;
  const endpoint = `https://${host}${encodedPath}`;
  const now = new Date();
  const amzDate = formatAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body);
  const headers = {
    "cache-control": args.cacheControl,
    "content-length": String(body.byteLength),
    "content-type": contentType,
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map(key => `${key}:${headers[key]}\n`)
    .join("");
  const canonicalRequest = [
    "PUT",
    encodedPath,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const credentialScope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const signingKey = getSignatureKey(args.secretAccessKey, dateStamp, "auto", "s3");
  const signature = hmacHex(signingKey, stringToSign);
  const authorization = [
    `AWS4-HMAC-SHA256 Credential=${args.accessKeyId}/${credentialScope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`,
  ].join(", ");

  let response;
  try {
    response = await fetch(endpoint, {
      method: "PUT",
      headers: {
        "Cache-Control": headers["cache-control"],
        "Content-Length": headers["content-length"],
        "Content-Type": headers["content-type"],
        "X-Amz-Content-Sha256": headers["x-amz-content-sha256"],
        "X-Amz-Date": headers["x-amz-date"],
        Authorization: authorization,
      },
      body,
      duplex: "half",
    });
  } catch (err) {
    const cause = err.cause ? ` (${err.cause?.message || err.cause})` : "";
    throw new Error(`Network fetch failed for ${item.objectKey}: ${err.message}${cause}`, {
      cause: err,
    });
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `R2 upload failed for ${item.objectKey}: ${response.status} ${response.statusText}\n${text}`
    );
  }
}

function encodePathSegment(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, char =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function encodeObjectKey(value) {
  return String(value)
    .split("/")
    .map(segment => encodePathSegment(segment))
    .join("/");
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hmac(key, value) {
  return crypto.createHmac("sha256", key).update(value).digest();
}

function hmacHex(key, value) {
  return crypto.createHmac("sha256", key).update(value).digest("hex");
}

function getSignatureKey(secretAccessKey, dateStamp, regionName, serviceName) {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, regionName);
  const kService = hmac(kRegion, serviceName);
  return hmac(kService, "aws4_request");
}

function formatAmzDate(date) {
  return date
    .toISOString()
    .replace(/[:-]|\.\d{3}/g, "");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  if (args.proxy) {
    process.env.HTTPS_PROXY = args.proxy;
    process.env.HTTP_PROXY = args.proxy;
  }

  const activeProxy =
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.ALL_PROXY ||
    args.proxy;

  if (
    activeProxy &&
    !process.execArgv.includes("--use-env-proxy") &&
    !(process.env.NODE_OPTIONS || "").includes("--use-env-proxy")
  ) {
    const { spawnSync } = await import("child_process");
    const child = spawnSync(
      process.execPath,
      ["--use-env-proxy", ...process.argv.slice(1)],
      {
        stdio: "inherit",
        env: process.env,
      }
    );
    process.exit(child.status ?? 0);
  }

  validateArgs(args);

  const storyPath = resolveStoryPath(args);
  if (!fs.existsSync(storyPath)) {
    throw new Error(`Story file not found: ${storyPath}`);
  }

  const outputPath = args.output ? path.resolve(process.cwd(), args.output) : storyPath;
  const storyId = storyIdFromPath(storyPath);
  const manifestPath = resolveManifestPath(args, storyId);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`ZeroTTS manifest not found: ${manifestPath}`);
  }
  const story = JSON.parse(fs.readFileSync(storyPath, "utf8"));
  if (!story || !Array.isArray(story.content)) {
    throw new Error("Story JSON must have a content array");
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  let clearedSkippedRows = 0;
  for (const index of args.skipIndices) {
    if (!story.content[index]) throw new Error(`Skipped TTS index is outside story content: ${index}`);
    if (String(story.content[index].VoiceJp ?? "")) {
      story.content[index].VoiceJp = "";
      clearedSkippedRows++;
    }
  }
  const items = collectVoiceItems(story, args, manifest);
  const pendingItems = items.filter(item => !item.alreadyPublished);
  const plan = {
    storyPath,
    outputPath,
    manifestPath,
    localFileRoot: path.resolve(args.localFileRoot),
    bucket: args.bucket || "(skip upload)",
    publicBaseUrl: args.publicBaseUrl,
    keyPrefix: args.keyPrefix,
    voiceItems: items.length,
    pendingUploads: pendingItems.length,
    skipUpload: args.skipUpload,
    missingOnly: args.missingOnly,
    skippedIndices: args.skipIndices,
    clearedSkippedRows,
    dryRun: args.dryRun,
  };
  console.log(JSON.stringify(plan, null, 2));

  if (items.length === 0) {
    console.log("No completed local TTS audio found in the manifest.");
    if (!args.dryRun) {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, `${JSON.stringify(story, null, 2)}\n`);
    }
    return;
  }

  if (args.dryRun) {
    console.log(
      JSON.stringify(
        items.map(item => ({
          index: item.index,
          localPath: item.localPath,
          objectKey: item.objectKey,
          publicUrl: item.publicUrl,
          alreadyPublished: item.alreadyPublished,
          localFileExists: fs.existsSync(item.localPath),
        })),
        null,
        2
      )
    );
    return;
  }

  if (!args.skipUpload) {
    await uploadItems(args, pendingItems, manifestPath, manifest);
  }

  let rewritten = 0;
  for (const item of items) {
    if (story.content[item.index].VoiceJp !== item.publicUrl) {
      story.content[item.index].VoiceJp = item.publicUrl;
      rewritten++;
    }
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(story, null, 2)}\n`);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Rewritten ${rewritten} VoiceJp URLs: ${outputPath}`);
}

main().catch(error => {
  console.error(error.message);
  if (error.cause) {
    console.error("Cause:", error.cause);
  }
  process.exit(1);
});
