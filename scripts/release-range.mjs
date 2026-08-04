function parseStableVersion(value, label) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) {
    throw new Error(`${label} must be a stable major.minor.patch version, got ${value}`);
  }

  return match.slice(1).map(Number);
}

/**
 * True when the repository's supported simple-caret dependency range can
 * select the current stable workspace version.
 */
export function caretIncludes(range, version) {
  if (!range.startsWith("^")) return false;

  const floor = parseStableVersion(range.slice(1), "workspace dependency floor");
  const current = parseStableVersion(version, "workspace package version");
  const [floorMajor, floorMinor, floorPatch] = floor;
  const [major, minor, patch] = current;

  if (
    major < floorMajor ||
    (major === floorMajor && minor < floorMinor) ||
    (major === floorMajor && minor === floorMinor && patch < floorPatch)
  ) {
    return false;
  }

  if (floorMajor > 0) return major === floorMajor;
  if (floorMinor > 0) return major === 0 && minor === floorMinor;
  return major === 0 && minor === 0 && patch === floorPatch;
}
