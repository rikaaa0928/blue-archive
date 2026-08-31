import fs from "fs";
import path from "path";
import url from "url";

import xxhash from "xxhashjs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..", "..");
const repoRoot = path.resolve(appRoot, "..", "..");

loadEnvFile(path.join(appRoot, ".env"));
loadEnvFile(path.join(repoRoot, ".env"));

const defaultSchemaPath =
  process.env.BA_SCENARIO_SCHEMA_PATH ||
  "/Volumes/storage/ba-asset-data-global/extracted/Table/ExcelDB/ScenarioScriptDBSchema.json";

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

    const key = match[1];
    let value = match[2].trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
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
  pnpm find-event-story <event-id|name> [options]

Options:
  --schema <file>     ScenarioScriptDBSchema.json; related tables are read from
                      the same directory
  --table-dir <dir>   directory containing the extracted ExcelDB JSON tables
  --group-id          treat a numeric query as a Scenario GroupId
  --json              print machine-readable JSON
  --help, -h          show this help

The name lookup supports partial Japanese or Korean event names. Numeric lookup
first checks event IDs, then falls back to a Scenario GroupId reverse lookup.
Both modes include reruns whose OriginalEventContentId uses the same stories.

Examples:
  pnpm find-event-story 801
  pnpm find-event-story 桜花
  pnpm find-event-story 10000005
  pnpm find-event-story 10000005 --group-id
  pnpm --silent find-event-story 벚꽃 --json
  pnpm find-event-story 801 --table-dir /data/extracted/Table/ExcelDB
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
    query: "",
    schema: defaultSchemaPath,
    tableDir: "",
    groupId: false,
    json: false,
    help: false,
  };
  const positional = [];

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    switch (arg) {
      case "--schema":
        args.schema = readOptionValue(argv, ++index, arg);
        break;
      case "--table-dir":
        args.tableDir = readOptionValue(argv, ++index, arg);
        break;
      case "--group-id":
        args.groupId = true;
        break;
      case "--json":
        args.json = true;
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

  if (positional.length > 1) {
    throw new Error("Quote a name containing spaces as one argument");
  }
  args.query = positional[0] ?? "";
  return args;
}

function readJson(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} does not exist: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function normalize(value) {
  return String(value ?? "").normalize("NFKC").trim().toLocaleLowerCase();
}

function eventNameHash(nameKey) {
  return xxhash.h32(String(nameKey), 0).toNumber();
}

function unique(values) {
  return [...new Set(values)];
}

function buildScenarioIndex(rows) {
  const index = new Map();
  for (const row of rows) {
    const eventId = Number(row.EventContentId ?? row.Bytes?.EventContentId);
    const list = index.get(eventId) ?? [];
    list.push(row.Bytes);
    index.set(eventId, list);
  }

  for (const [eventId, list] of index) {
    const scenarioGroupIds = list
      .sort((left, right) => Number(left.Order) - Number(right.Order))
      .flatMap(row => row.ScenarioGroupId ?? [])
      .map(Number);
    index.set(eventId, unique(scenarioGroupIds));
  }
  return index;
}

function canonicalEvents(rows) {
  const preferred = new Map();
  for (const row of rows) {
    const event = row.Bytes;
    const eventId = Number(event?.EventContentId);
    if (!Number.isFinite(eventId)) {
      continue;
    }

    const current = preferred.get(eventId);
    const score =
      (event.EventContentType === "Stage" ? 2 : 0) +
      (event.EventDisplay ? 1 : 0);
    if (!current || score > current.score) {
      preferred.set(eventId, { event, score });
    }
  }
  return [...preferred.values()].map(value => value.event);
}

function resolveResults({
  query,
  forceGroupId,
  seasonRows,
  localizeRows,
  scenarioIndex,
}) {
  const localizeByKey = new Map(
    localizeRows.map(row => [
      Number(row.Key ?? row.Bytes?.Key),
      row.Bytes ?? row,
    ]),
  );
  const numericQuery = /^\d+$/u.test(query) ? Number(query) : null;
  const normalizedQuery = normalize(query);
  if (forceGroupId && numericQuery === null) {
    throw new Error("--group-id requires a numeric query");
  }
  const events = canonicalEvents(seasonRows);
  const hasEventIdMatch =
    numericQuery !== null &&
    (
      scenarioIndex.has(numericQuery) ||
      events.some(event => {
        const eventId = Number(event.EventContentId);
        const originalEventId = Number(event.OriginalEventContentId || eventId);
        return eventId === numericQuery || originalEventId === numericQuery;
      })
    );
  const reverseGroupId =
    numericQuery !== null && (forceGroupId || !hasEventIdMatch)
      ? numericQuery
      : null;
  const storySourceMatches = new Set(
    reverseGroupId === null
      ? []
      : [...scenarioIndex]
        .filter(([, groupIds]) => groupIds.includes(reverseGroupId))
        .map(([eventId]) => eventId),
  );
  const results = [];

  for (const event of events) {
    const eventId = Number(event.EventContentId);
    const originalEventId = Number(event.OriginalEventContentId || eventId);
    const localized =
      localizeByKey.get(eventNameHash(event.Name)) ?? {};
    const matched = reverseGroupId !== null
      ? storySourceMatches.has(eventId) ||
        storySourceMatches.has(originalEventId)
      : numericQuery !== null
        ? eventId === numericQuery || originalEventId === numericQuery
        : [event.Name, localized.Jp, localized.Kr]
          .some(value => normalize(value).includes(normalizedQuery));
    if (!matched) {
      continue;
    }

    const directIds = scenarioIndex.get(eventId) ?? [];
    const originalIds = scenarioIndex.get(originalEventId) ?? [];
    const storySourceEventId = directIds.length ? eventId : originalEventId;
    results.push({
      eventId,
      originalEventId,
      isReturn: Boolean(event.IsReturn),
      nameKey: event.Name ?? "",
      nameJp: localized.Jp ?? "",
      nameKr: localized.Kr ?? "",
      ...(reverseGroupId === null
        ? {}
        : { matchedGroupId: reverseGroupId }),
      storySourceEventId,
      scenarioGroupIds: directIds.length ? directIds : originalIds,
    });
  }

  if (numericQuery !== null && reverseGroupId === null && results.length === 0) {
    const scenarioGroupIds = scenarioIndex.get(numericQuery);
    if (scenarioGroupIds) {
      results.push({
        eventId: numericQuery,
        originalEventId: numericQuery,
        isReturn: false,
        nameKey: "",
        nameJp: "",
        nameKr: "",
        storySourceEventId: numericQuery,
        scenarioGroupIds,
      });
    }

    if (reverseGroupId !== null && results.length === 0) {
      for (const eventId of storySourceMatches) {
        results.push({
          eventId,
          originalEventId: eventId,
          isReturn: false,
          nameKey: "",
          nameJp: "",
          nameKr: "",
          matchedGroupId: reverseGroupId,
          storySourceEventId: eventId,
          scenarioGroupIds: scenarioIndex.get(eventId) ?? [],
        });
      }
    }
  }

  return results.sort(
    (left, right) =>
      left.originalEventId - right.originalEventId ||
      left.eventId - right.eventId,
  );
}

function printHuman(results) {
  for (const [index, event] of results.entries()) {
    if (index > 0) {
      console.log("");
    }
    const title = event.nameJp || event.nameKr || event.nameKey || "(unknown)";
    console.log(`${title} [event ${event.eventId}]`);
    if (event.nameKr && event.nameKr !== title) {
      console.log(`  Korean: ${event.nameKr}`);
    }
    console.log(
      `  Original: ${event.originalEventId}` +
      (event.isReturn ? " (rerun)" : ""),
    );
    if (event.storySourceEventId !== event.eventId) {
      console.log(`  Story source event: ${event.storySourceEventId}`);
    }
    if (event.matchedGroupId !== undefined) {
      console.log(`  Matched GroupId: ${event.matchedGroupId}`);
    }
    console.log(`  GroupIds (${event.scenarioGroupIds.length}):`);
    console.log(
      event.scenarioGroupIds.length
        ? `    ${event.scenarioGroupIds.join(" ")}`
        : "    (none found in EventContentScenarioDBSchema)",
    );
  }
}

export function findEventStories({
  query,
  forceGroupId = false,
  schema = defaultSchemaPath,
  tableDir: requestedTableDir = "",
}) {
  const schemaPath = path.resolve(schema);
  const tableDir = path.resolve(requestedTableDir || path.dirname(schemaPath));
  const seasonRows = readJson(
    path.join(tableDir, "EventContentSeasonDBSchema.json"),
    "event season table",
  );
  const scenarioRows = readJson(
    path.join(tableDir, "EventContentScenarioDBSchema.json"),
    "event scenario table",
  );
  const localizeRows = readJson(
    path.join(tableDir, "LocalizeDBSchema.json"),
    "localization table",
  );
  const results = resolveResults({
    query,
    forceGroupId,
    seasonRows,
    localizeRows,
    scenarioIndex: buildScenarioIndex(scenarioRows),
  });

  if (results.length === 0) {
    throw new Error(`No event matched "${query}" in ${tableDir}`);
  }
  return results;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  if (!args.query) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const results = findEventStories({
    query: args.query,
    forceGroupId: args.groupId,
    schema: args.schema,
    tableDir: args.tableDir,
  });

  if (args.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    printHuman(results);
  }
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url);

if (isDirectRun) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}
