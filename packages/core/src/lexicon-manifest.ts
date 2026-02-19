/**
 * Lexicon manifest validation and version compatibility checking.
 */

/**
 * Check if the current version satisfies a semver range requirement.
 * Supports: >=X.Y.Z, <=X.Y.Z, >X.Y.Z, <X.Y.Z, =X.Y.Z, X.Y.Z (exact match)
 */
export function checkVersionCompatibility(required: string, current: string): boolean {
  const trimmed = required.trim();
  if (!trimmed) return true;

  let op: string;
  let versionStr: string;

  if (trimmed.startsWith(">=")) {
    op = ">=";
    versionStr = trimmed.slice(2).trim();
  } else if (trimmed.startsWith("<=")) {
    op = "<=";
    versionStr = trimmed.slice(2).trim();
  } else if (trimmed.startsWith(">")) {
    op = ">";
    versionStr = trimmed.slice(1).trim();
  } else if (trimmed.startsWith("<")) {
    op = "<";
    versionStr = trimmed.slice(1).trim();
  } else if (trimmed.startsWith("=")) {
    op = "=";
    versionStr = trimmed.slice(1).trim();
  } else {
    op = "=";
    versionStr = trimmed;
  }

  const requiredParts = parseVersion(versionStr);
  const currentParts = parseVersion(current.trim());

  if (!requiredParts || !currentParts) return false;

  const cmp = compareVersions(currentParts, requiredParts);

  switch (op) {
    case ">=": return cmp >= 0;
    case "<=": return cmp <= 0;
    case ">":  return cmp > 0;
    case "<":  return cmp < 0;
    case "=":  return cmp === 0;
    default:   return false;
  }
}

function parseVersion(v: string): [number, number, number] | null {
  // Strip leading 'v'
  if (v.startsWith("v")) v = v.slice(1);

  const parts = v.split(".");
  if (parts.length < 2 || parts.length > 3) return null;

  const nums = parts.map(Number);
  if (nums.some(isNaN)) return null;

  return [nums[0], nums[1], nums[2] ?? 0];
}

function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}
