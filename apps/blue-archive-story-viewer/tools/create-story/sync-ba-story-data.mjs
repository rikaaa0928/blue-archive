import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import url from "url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..", "..");
const repoRoot = path.resolve(appRoot, "..", "..");

loadEnvFile(path.join(appRoot, ".env"));
loadEnvFile(path.join(repoRoot, ".env"));

const defaultSchemaPath =
  process.env.BA_SCENARIO_SCHEMA_PATH ||
  "/Volumes/storage/ba-asset-data-global/extracted/Table/ExcelDB/ScenarioScriptDBSchema.json";
const defaultDataDir =
  process.env.BA_ASSET_DATA_DIR ||
  path.resolve(path.dirname(defaultSchemaPath), "..", "..", "..");
const defaultImage =
  process.env.BA_ASSET_DOWNLOADER_IMAGE ||
  "ba-asset-downloader:v2.3.0";
const requiredTableFiles = [
  "ScenarioScriptDBSchema.json",
  "EventContentScenarioDBSchema.json",
  "EventContentSeasonDBSchema.json",
  "LocalizeDBSchema.json",
  "LocalizeEtcDBSchema.json",
  "ScenarioCharacterNameDBSchema.json",
];

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

function printUsage() {
  console.log(`Usage:
  pnpm sync-ba-story-data [options]

Options:
  --data-dir <dir>     host data root, default: BA_ASSET_DATA_DIR or ${defaultDataDir}
  --image <name>       downloader image, default: ${defaultImage}
  --region <gl|jp>     server region, default: gl
  --threads <n>        download worker count, default: 4
  --proxy <url>        HTTP proxy passed to the downloader
  --skip-download      reuse an existing raw/Table/ExcelDB.db
  --help, -h           show this help

The command downloads only ExcelDB.db and exports only the six JSON tables
required by story import, event lookup and character resolution. It never downloads the full Table
catalog payload.
`);
}

function readOptionValue(argv, index, optionName) {
  const value = argv[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

function parseArgs(argv) {
  const args = {
    dataDir: defaultDataDir,
    image: defaultImage,
    region: "gl",
    threads: 4,
    proxy: "",
    skipDownload: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    switch (arg) {
      case "--data-dir":
        args.dataDir = readOptionValue(argv, ++index, arg);
        break;
      case "--image":
        args.image = readOptionValue(argv, ++index, arg);
        break;
      case "--region":
        args.region = readOptionValue(argv, ++index, arg);
        break;
      case "--threads":
        args.threads = Number(readOptionValue(argv, ++index, arg));
        break;
      case "--proxy":
        args.proxy = readOptionValue(argv, ++index, arg);
        break;
      case "--skip-download":
        args.skipDownload = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!["gl", "jp"].includes(args.region)) {
    throw new Error("--region must be gl or jp");
  }
  if (!Number.isInteger(args.threads) || args.threads < 1) {
    throw new Error("--threads must be a positive integer");
  }
  args.dataDir = path.resolve(args.dataDir);
  return args;
}

function run(command, args) {
  const printableArgs = args.map((arg, index) =>
    args[index - 1] === "--proxy" ? "<redacted>" : arg,
  );
  console.log(`\n$ ${[command, ...printableArgs].join(" ")}`);
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const reason = result.signal
      ? `signal ${result.signal}`
      : `exit code ${result.status}`;
    throw new Error(`${command} failed with ${reason}`);
  }
}

function dockerBaseArgs(args) {
  return [
    "run",
    "--rm",
    "-v",
    `${args.dataDir}:/data`,
    args.image,
  ];
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  fs.mkdirSync(args.dataDir, { recursive: true });
  if (!args.skipDownload) {
    const downloadArgs = [
      ...dockerBaseArgs(args),
      "download",
      "--region",
      args.region,
      "--threads",
      String(args.threads),
      "--resource-type",
      "table",
      "--search",
      "ExcelDB",
      "--raw-dir",
      "/data/raw",
      "--extract-dir",
      "/data/extracted",
      "--temp-dir",
      "/data/temp",
    ];
    if (args.proxy) {
      downloadArgs.push("--proxy", args.proxy);
    }
    run("docker", downloadArgs);
  }

  const extractArgs = [
    "run",
    "--rm",
    "-v",
    `${args.dataDir}:/data`,
    "--entrypoint",
    "uv",
    args.image,
    "run",
    "--no-sync",
    "python",
    "/opt/ba-story-tools/extract-story-tables.py",
    "--region",
    args.region,
    "--raw-dir",
    "/data/raw",
    "--extract-dir",
    "/data/extracted",
    "--temp-dir",
    "/data/temp",
  ];
  if (args.proxy) {
    extractArgs.push("--proxy", args.proxy);
  }
  run("docker", extractArgs);

  const tableDir = path.join(
    args.dataDir,
    "extracted",
    "Table",
    "ExcelDB",
  );
  const missingFiles = requiredTableFiles.filter(
    fileName => !fs.existsSync(path.join(tableDir, fileName)),
  );
  if (missingFiles.length > 0) {
    throw new Error(
      "Focused extraction did not create: " +
      missingFiles.map(fileName => path.join(tableDir, fileName)).join(", "),
    );
  }
  const schemaPath = path.join(tableDir, "ScenarioScriptDBSchema.json");
  console.log(`\nStory data ready: ${schemaPath}`);
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
