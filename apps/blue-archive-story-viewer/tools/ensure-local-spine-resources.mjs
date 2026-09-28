import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const upstreamCommit = "427f96368c397bffae64be45afeaf383502c049c";
const upstreamBaseUrl = `https://raw.githubusercontent.com/SunsetMkt/blue-archive-spine-production/${upstreamCommit}/assets/spine/spinebg`;

export const localSpineResources = [
  {
    name: "SC11000_01.skel",
    sha256: "200878a716098fa4327b7ba065d940e2d18968f3da76bf7025967d036b43aec4",
  },
  {
    name: "SC11000_01.png",
    sha256: "f403e8999d6020c770b9523690316ac4325ea342c15369e4011d68d9f7762c0a",
  },
  {
    name: "SC11000_01_2.png",
    sha256: "2b1625b63e1573beda8c802e5e5ac060fdc4e57efd72a895c3eb02428a2fe060",
  },
].map(resource => ({ ...resource, url: `${upstreamBaseUrl}/${resource.name}` }));

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultTargetDir = path.join(appRoot, "public", "resources", "spine", "spinebg");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readValidResource(filePath, expectedHash) {
  try {
    return sha256(await fs.readFile(filePath)) === expectedHash;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function ensureLocalSpineResources({
  targetDir = defaultTargetDir,
  fetchImpl = globalThis.fetch,
  logger = console,
  resources = localSpineResources,
} = {}) {
  await fs.mkdir(targetDir, { recursive: true });
  for (const resource of resources) {
    const targetPath = path.join(targetDir, resource.name);
    if (await readValidResource(targetPath, resource.sha256)) continue;

    logger.log(`Fetching pinned local Spine resource: ${resource.name}`);
    const response = await fetchImpl(resource.url);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${resource.name}: HTTP ${response.status}`);
    }
    const content = Buffer.from(await response.arrayBuffer());
    const actualHash = sha256(content);
    if (actualHash !== resource.sha256) {
      throw new Error(`SHA-256 mismatch for ${resource.name}: expected ${resource.sha256}, got ${actualHash}`);
    }

    const temporaryPath = `${targetPath}.${process.pid}.tmp`;
    await fs.writeFile(temporaryPath, content);
    await fs.rename(temporaryPath, targetPath);
  }
  return targetDir;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await ensureLocalSpineResources();
}
