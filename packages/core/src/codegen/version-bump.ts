/**
 * 0.x-aware version bumping, shared by the pinned upgrade Op (#549) and the
 * rolling drift re-baseline (#616). Centralised here so the single source of
 * truth for the semver rule can't drift between the two callers.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, relative, resolve, sep } from "path";

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

const RANGE_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"] as const;

/** The nearest directory above `dir` whose package.json declares `workspaces`, or null. */
function workspaceRootAbove(dir: string): string | null {
  for (let at = dirname(resolve(dir)); ; at = dirname(at)) {
    const pkgPath = join(at, "package.json");
    if (existsSync(pkgPath)) {
      try {
        if (Array.isArray((JSON.parse(readFileSync(pkgPath, "utf-8")) as { workspaces?: unknown }).workspaces)) return at;
      } catch {
        /* not a manifest this can read; keep walking */
      }
    }
    if (dirname(at) === at) return null;
  }
}

/** The workspace package directories a root declares, for patterns of the form `dir` or `dir/*`. */
function workspaceDirs(root: string): string[] {
  const patterns = (JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as { workspaces: unknown[] }).workspaces;
  const dirs: string[] = [];
  for (const p of patterns) {
    if (typeof p !== "string") continue;
    if (p.endsWith("/*")) {
      const parent = join(root, p.slice(0, -2));
      if (!existsSync(parent)) continue;
      for (const name of readdirSync(parent).sort()) {
        if (existsSync(join(parent, name, "package.json"))) dirs.push(join(parent, name));
      }
    } else if (existsSync(join(root, p, "package.json"))) {
      dirs.push(join(root, p));
    }
  }
  return dirs;
}

/** Point every range on `name` in one manifest or lockfile entry at `^version`. `*` and `workspace:` ranges are left. */
function followIn(holder: Record<string, unknown>, name: string, version: string): boolean {
  let changed = false;
  for (const field of RANGE_FIELDS) {
    const deps = holder[field] as Record<string, unknown> | undefined;
    if (!deps || typeof deps !== "object" || typeof deps[name] !== "string") continue;
    const range = deps[name] as string;
    if (range === "*" || range.startsWith("workspace:") || range === `^${version}`) continue;
    deps[name] = `^${version}`;
    changed = true;
  }
  return changed;
}

function rewriteJson(path: string, edit: (doc: Record<string, unknown>) => boolean): boolean {
  const raw = readFileSync(path, "utf-8");
  const doc = JSON.parse(raw) as Record<string, unknown>;
  if (!edit(doc)) return false;
  const indent = /^\{\r?\n([ \t]+)"/.exec(raw)?.[1] ?? "  ";
  writeFileSync(path, JSON.stringify(doc, null, indent) + (raw.endsWith("\n") ? "\n" : ""), "utf-8");
  return true;
}

/**
 * After a package's version moves, move the ranges other workspace packages
 * declare on it (#5556). Each in-family range is `^<provider version>`
 * (packages/core/src/meta/peer-deps.test.ts), and at 0.x a caret does not
 * cross a minor, so a breaking bump left `^0.124.34` on a package now at
 * 0.125.0: npm then installed the old release from the registry beside the
 * workspace copy. The root's package-lock.json follows too: the package's
 * own entry takes the version and each dependent's entry the range, so
 * `npm ci` accepts the tree. Returns the files it changed, for staging; an
 * empty list when `packageDir` is in no npm workspace.
 */
export function followWorkspaceRanges(packageDir: string, version: string): string[] {
  const root = workspaceRootAbove(packageDir);
  if (!root) return [];
  const name = (JSON.parse(readFileSync(join(packageDir, "package.json"), "utf-8")) as { name?: unknown }).name;
  if (typeof name !== "string") return [];
  const changed: string[] = [];
  const self = resolve(packageDir);
  for (const dir of workspaceDirs(root)) {
    if (resolve(dir) === self) continue;
    const path = join(dir, "package.json");
    if (rewriteJson(path, (doc) => followIn(doc, name, version))) changed.push(path);
  }
  const lockPath = join(root, "package-lock.json");
  if (existsSync(lockPath)) {
    const ownKey = relative(root, self).split(sep).join("/");
    const lockChanged = rewriteJson(lockPath, (doc) => {
      const packages = (doc.packages ?? {}) as Record<string, Record<string, unknown>>;
      let any = false;
      for (const [key, entry] of Object.entries(packages)) {
        // Workspace entries only: an installed copy under node_modules is a published release.
        if (!entry || typeof entry !== "object" || key.split("/").includes("node_modules")) continue;
        if (key === ownKey) {
          if (typeof entry.version === "string" && entry.version !== version) {
            entry.version = version;
            any = true;
          }
          continue;
        }
        if (followIn(entry, name, version)) any = true;
      }
      return any;
    });
    if (lockChanged) changed.push(lockPath);
  }
  return changed;
}
