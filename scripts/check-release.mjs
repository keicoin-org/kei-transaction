import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const packagesDirectory = fileURLToPath(new URL("../packages/", import.meta.url));
const entries = await readdir(packagesDirectory, { withFileTypes: true });
const manifests = [];

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

      const expectedRange = `^${localVersion}`;
      if (range !== expectedRange) {
        throw new Error(
          `${manifest.name} ${dependencyGroup}.${name} must be ${expectedRange}, got ${range}`,
        );
      }
    }
  }
}

console.log(
  `Release manifests valid: ${manifests.length} public packages and aligned workspace dependency ranges.`,
);
