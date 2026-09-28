import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureLocalSpineResources, localSpineResources } from "./ensure-local-spine-resources.mjs";

test("keeps verified local Spine resources without fetching", async t => {
  const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "local-spine-existing-"));
  t.after(() => fs.rm(targetDir, { recursive: true, force: true }));
  const content = Buffer.from("verified resource");
  const resource = {
    ...localSpineResources[0],
    sha256: createHash("sha256").update(content).digest("hex"),
  };
  await fs.writeFile(path.join(targetDir, resource.name), content);

  let fetches = 0;
  await ensureLocalSpineResources({
    targetDir,
    fetchImpl: async () => { fetches += 1; throw new Error("unexpected fetch"); },
    logger: { log() {} },
    resources: [resource],
  });
  assert.equal(fetches, 0);
});

test("downloads and verifies a missing local Spine resource", async t => {
  const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "local-spine-download-"));
  t.after(() => fs.rm(targetDir, { recursive: true, force: true }));
  const content = Buffer.from("downloaded resource");
  const resource = {
    name: "resource.bin",
    url: "https://example.invalid/resource.bin",
    sha256: createHash("sha256").update(content).digest("hex"),
  };

  await ensureLocalSpineResources({
    targetDir,
    fetchImpl: async () => new Response(content, { status: 200 }),
    logger: { log() {} },
    resources: [resource],
  });
  assert.deepEqual(await fs.readFile(path.join(targetDir, resource.name)), content);
});
