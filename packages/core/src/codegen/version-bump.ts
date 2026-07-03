/**
 * 0.x-aware version bumping, shared by the pinned upgrade Op (#549) and the
 * rolling drift re-baseline (#616). Centralised here so the single source of
 * truth for the semver rule can't drift between the two callers.
 */

import { readFileSync, writeFileSync } from "fs";

/** Surface-change severity that drives a bump. */
export type BumpSeverity = "additive" | "breaking" | "none";

/**
 * Compute a bumped semver from a current version and a surface severity.
 *
 * Pre-1.0 (major 0) never auto-promotes to 1.0.0: breaking → minor, additive →
 * patch. At >= 1.0.0: breaking → major, additive → minor. Returns null for
 * "none" or a version string that can't be parsed as MAJOR.MINOR.PATCH.
 */
export function bumpForSeverity(current: string, severity: BumpSeverity): string | null {
  if (severity === "none") return null;
  const parts = current.replace(/^v/, "").split(".").map(Number);
  if (parts.length < 3 || parts.some((n) => Number.isNaN(n) || n < 0)) return null;
  const [major, minor, patch] = parts as [number, number, number];
  if (major === 0) {
    return severity === "breaking" ? `0.${minor + 1}.0` : `0.${minor}.${patch + 1}`;
  }
  return severity === "breaking" ? `${major + 1}.0.0` : `${major}.${minor + 1}.0`;
}

/**
 * Read a package.json, set its `version`, and write it back — preserving all
 * other fields, 2-space indent, and a trailing newline.
 */
export function bumpPackageJsonVersion(packageJsonPath: string, newVersion: string): void {
  const raw = readFileSync(packageJsonPath, "utf-8");
  const pkg = JSON.parse(raw) as Record<string, unknown>;
  pkg["version"] = newVersion;
  writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
}
