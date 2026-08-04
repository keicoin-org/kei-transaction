import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { caretIncludes } from "./release-range.mjs";

const packagesDirectory = fileURLToPath(new URL("../packages/", import.meta.url));
const entries = await readdir(packagesDirectory, { withFileTypes: true });
const manifests = [];
const workspaceDirectories = new Map();

for (const entry of entries) {
  if (!entry.isDirectory()) continue;

  const path = join(packagesDirectory, entry.name, "package.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  if (manifest.private) continue;

  if (manifest.publishConfig?.access !== "public") {
    throw new Error(
      `${manifest.name ?? entry.name} must declare publishConfig.access as public`,
    );
  }

  manifests.push(manifest);
  workspaceDirectories.set(manifest.name, entry.name);
}

const localVersions = new Map(
  manifests.map((manifest) => [manifest.name, manifest.version]),
);

for (const manifest of manifests) {
  for (const dependencyGroup of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    for (const [name, range] of Object.entries(
      manifest[dependencyGroup] ?? {},
    )) {
      const localVersion = localVersions.get(name);
      if (!localVersion) continue;

      if (!caretIncludes(range, localVersion)) {
        throw new Error(
          `${manifest.name} ${dependencyGroup}.${name} range ${range} cannot select workspace ${localVersion}`,
        );
      }
    }
  }
}

// Bun's text lockfile is JSON with trailing commas. Parse only that extension,
// preserving commas inside strings, so workspace metadata can be checked rather
// than merely trusting that `--frozen-lockfile` noticed package-only changes.
function parseBunLock(text) {
  let json = "";
  let quoted = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      json += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }

    if (character === '"') {
      quoted = true;
      json += character;
      continue;
    }

    if (character === ",") {
      let next = index + 1;
      while (/\s/.test(text[next] ?? "")) next += 1;
      if (text[next] === "}" || text[next] === "]") continue;
    }
    json += character;
  }

  return JSON.parse(json);
}

const lockPath = fileURLToPath(new URL("../bun.lock", import.meta.url));
const lock = parseBunLock(await readFile(lockPath, "utf8"));
for (const manifest of manifests) {
  const directory = workspaceDirectories.get(manifest.name);
  const locked = lock.workspaces?.[`packages/${directory}`];
  if (!locked) throw new Error(`bun.lock omits workspace packages/${directory}`);
  if (locked.name !== manifest.name || locked.version !== manifest.version) {
    throw new Error(
      `bun.lock has ${String(locked.name)}@${String(locked.version)} for packages/${directory}, expected ${manifest.name}@${manifest.version}`,
    );
  }

  const expectedDependencies = manifest.dependencies ?? {};
  const lockedDependencies = locked.dependencies ?? {};
  if (JSON.stringify(lockedDependencies) !== JSON.stringify(expectedDependencies)) {
    throw new Error(
      `bun.lock dependencies for ${manifest.name} do not match package.json; regenerate the lockfile`,
    );
  }
}

console.log(
  `Release manifests valid: ${manifests.length} public packages with compatible dependency ranges and aligned lockfile metadata.`,
);
