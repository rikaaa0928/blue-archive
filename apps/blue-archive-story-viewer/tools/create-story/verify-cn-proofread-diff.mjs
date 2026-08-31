import fs from "node:fs";
import path from "node:path";
import url from "node:url";

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function verifyCnProofreadDiff(before, after) {
  if (!before || !after || !Array.isArray(before.content) ||
      !Array.isArray(after.content)) {
    throw new Error("Both story files must contain content[]");
  }

  const violations = [];
  const rootKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of rootKeys) {
    if (key === "content" || key === "proofreader") continue;
    if (!sameJson(before[key], after[key])) {
      violations.push(`top-level field changed: ${key}`);
    }
  }

  if (before.content.length !== after.content.length) {
    violations.push(
      `content length changed: ${before.content.length} -> ` +
      `${after.content.length}`,
    );
  }

  const textCnChanges = [];
  const length = Math.min(before.content.length, after.content.length);
  for (let index = 0; index < length; index++) {
    const beforeUnit = before.content[index];
    const afterUnit = after.content[index];
    const unitKeys = new Set([
      ...Object.keys(beforeUnit),
      ...Object.keys(afterUnit),
    ]);
    for (const key of unitKeys) {
      if (sameJson(beforeUnit[key], afterUnit[key])) continue;
      if (key !== "TextCn") {
        violations.push(`content[${index}].${key} changed`);
        continue;
      }
      textCnChanges.push({
        index,
        before: String(beforeUnit.TextCn ?? ""),
        after: String(afterUnit.TextCn ?? ""),
      });
    }
  }

  if (violations.length > 0) {
    throw new Error(
      "CN proofread changed forbidden story fields:\n- " +
      violations.join("\n- "),
    );
  }
  return {
    textCnChanges,
    proofreaderChanged: !sameJson(before.proofreader, after.proofreader),
  };
}

function readStory(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function main() {
  const [beforePath, afterPath] = process.argv.slice(2);
  if (!beforePath || !afterPath) {
    throw new Error(
      "Usage: node verify-cn-proofread-diff.mjs <before.json> <after.json>",
    );
  }
  const result = verifyCnProofreadDiff(
    readStory(path.resolve(beforePath)),
    readStory(path.resolve(afterPath)),
  );
  console.log(
    `Verified: ${result.textCnChanges.length} TextCn changes; ` +
    `proofreader changed: ${result.proofreaderChanged ? "yes" : "no"}`,
  );
}

const invokedPath = process.argv[1]
  ? url.pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}
