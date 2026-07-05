/**
 * Pinned-version upgrade detection for k8s, gcp, docker, gitlab lexicons.
 *
 * For each lexicon with a pinned upstream version constant, this module:
 *   1. Reads the currently pinned version from the source file.
 *   2. Queries upstream for the latest stable release tag (no pre-release/rc).
 *   3. Compares using semver ordering. If a newer version exists:
 *      a. Edits the version constant in the source file.
 *      b. Invokes regenLexicon to regenerate and surface-diff.
 *      c. Reverts the constant edit (dry-run mode — never commits the bump).
 *   4. Returns a structured report per lexicon.
 *
 * The upstream-query functions are injectable — pass a mock for unit tests.
 * The actual HTTP calls use the GitHub Releases/Tags API.
 *
 * Design decisions:
 * - "Latest stable" = highest semver excluding tags containing rc/alpha/beta/preview.
 * - The bump is always reverted after regen so the working tree is unchanged.
 *   Only the CLI reporter (#527) actually creates branches/PRs.
 * - Each lexicon's upstream query is a pure async function: () => Promise<string | null>
 *   (returns the latest version tag, or null when no stable release is found).
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { regenLexicon, type RegenResult } from "./lexicon-regen";
import { fetchWithRetry } from "./fetch";
import { isLexiconPlugin, type UpstreamPin } from "../lexicon";

// ── Public types ──────────────────────────────────────────────────────

/**
 * A pinned, self-upgradable lexicon's name (e.g. "k8s"). Any lexicon whose
 * plugin declares `upstreamPin` (../lexicon.ts) is eligible — the set is no
 * longer hard-coded here.
 */
export type LexiconId = string;

export type { UpstreamPin };

export interface UpgradeCheckResult {
  /** Lexicon identifier. */
  lexicon: LexiconId;
  /** Whether a newer stable upstream version was found. */
  hasUpgrade: boolean;
  /** Current pinned version string (e.g. "v1.32.0"). */
  from: string;
  /** Latest upstream version string, if one was found (e.g. "v1.33.0"). */
  to: string | null;
  /** Regen/surface-diff result — only present when hasUpgrade is true. */
  validation: RegenResult | null;
  /** Human-readable error when the upstream query itself failed. */
  fetchError: string | null;
}

/** Injectable upstream version resolver. Returns the latest stable tag or null. */
export type UpstreamResolver = () => Promise<string | null>;

export interface CheckPinnedUpgradeOptions {
  /** Resolved path to the lexicon root (e.g. /repo/lexicons/k8s). */
  lexiconDir: string;
  /** Which lexicon to check. */
  lexicon: LexiconId;
  /**
   * Override the upstream resolver (useful in tests to inject mocks).
   * When omitted the real GitHub API is called.
   */
  resolverOverride?: UpstreamResolver;
  /**
   * When true, pass force=true to regenLexicon so the spec cache is bypassed.
   * Default: false (use cached spec for the upgrade check).
   */
  force?: boolean;
  /** Forward to regenLexicon. */
  verbose?: boolean;
  /** Forward to regenLexicon — skip tsc step for speed in tests. */
  skipBuild?: boolean;
  /** Forward to regenLexicon. */
  skipBundle?: boolean;
  /** Forward to regenLexicon. */
  skipLint?: boolean;
}

// ── Version comparison ────────────────────────────────────────────────

/**
 * Parse a version string into numeric segments.
 *
 * Strips leading "v" and any build-metadata suffix after "-".
 * Returns null when the string is not a parseable version.
 */
export function parseVersion(tag: string): number[] | null {
  // Strip leading "v"
  const core = tag.startsWith("v") ? tag.slice(1) : tag;
  // Strip build metadata suffix (e.g. "-ee" from "17.8.1-ee")
  const base = core.split("-")[0];
  if (!base) return null;
  const parts = base.split(".").map(Number);
  if (parts.some((n) => Number.isNaN(n) || n < 0)) return null;
  if (parts.length === 0) return null;
  return parts;
}

/**
 * Compare two version tuples lexicographically.
 * Returns -1 when a < b, 0 when equal, +1 when a > b.
 */
export function compareVersionTuples(a: number[], b: number[]): -1 | 0 | 1 {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

/**
 * Return true when `candidate` is strictly newer than `current`.
 *
 * Strips build-metadata suffixes (e.g. "-ee") before comparing so that
 * "v17.9.0-ee" and "v17.9.0" compare by numeric part only.
 */
export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  return compareVersionTuples(a, b) > 0;
}

/**
 * Return true when a release tag looks like a pre-release.
 * Filters out rc, alpha, beta, preview, nightly, dev, canary suffixes.
 */
export function isPreRelease(tag: string): boolean {
  return /[\-_\.](rc|alpha|beta|preview|nightly|dev|canary)\d*/i.test(tag);
}

// ── Pin constant locations ────────────────────────────────────────────

interface PinLocation {
  /** Absolute path to the file containing the version constant. */
  filePath: string;
  /** Regex that matches the full constant line (must have a capture for the version). */
  pattern: RegExp;
  /** Function to build the replacement line given the new version string. */
  buildReplacement: (newVersion: string, oldVersion: string, line: string) => string;
}

/**
 * Read the current pinned version from a source file using a regex pattern.
 * Returns null when the pattern is not found.
 */
export function readPinnedVersion(location: PinLocation): string | null {
  let content: string;
  try {
    content = readFileSync(location.filePath, "utf-8");
  } catch {
    return null;
  }
  const match = location.pattern.exec(content);
  return match ? (match[1] ?? null) : null;
}

/**
 * Apply a version bump by replacing the constant in the source file.
 * Returns the original file content so it can be reverted.
 */
export function applyVersionBump(location: PinLocation, newVersion: string): string {
  const original = readFileSync(location.filePath, "utf-8");
  const lines = original.split("\n");
  const updated = lines.map((line) => {
    const match = location.pattern.exec(line);
    if (!match) return line;
    const currentVersion = match[1] ?? "";
    return location.buildReplacement(newVersion, currentVersion, line);
  });
  writeFileSync(location.filePath, updated.join("\n"), "utf-8");
  return original;
}

/**
 * Revert a file to its original content (undo a bump).
 */
export function revertVersionBump(filePath: string, original: string): void {
  writeFileSync(filePath, original, "utf-8");
}

// ── Pin descriptor, loaded from the lexicon plugin ────────────────────

/**
 * Load a lexicon's `upstreamPin` descriptor from its plugin package
 * (`@intentius/chant-lexicon-<name>`) — the lexicon's own declaration of where
 * its version constant lives and which upstream repo to check. Returns null
 * when the package can't be resolved or declares no `upstreamPin` (i.e. it is
 * not self-upgradable). Mirrors ../components/capability-plugin-loader.ts's
 * lexicon-borne loading.
 */
export async function loadUpstreamPin(lexicon: LexiconId): Promise<UpstreamPin | null> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(`@intentius/chant-lexicon-${lexicon}`)) as Record<string, unknown>;
  } catch {
    return null;
  }
  for (const value of Object.values(mod)) {
    if (isLexiconPlugin(value) && value.upstreamPin) return value.upstreamPin;
  }
  return null;
}

/** Build a concrete `PinLocation` (absolute path + patterns) from a lexicon's descriptor and its checkout dir. */
function pinLocationFrom(pin: UpstreamPin, lexiconDir: string): PinLocation {
  return {
    filePath: join(lexiconDir, pin.file),
    pattern: pin.pattern,
    buildReplacement: (newVer, _old, line) => pin.replace(newVer, line),
  };
}

// ── Real upstream resolvers ───────────────────────────────────────────

/**
 * Fetch GitHub releases or tags from the given repo and return the
 * latest stable version tag (highest semver, no pre-release).
 *
 * `kind` selects whether to use the releases API (which has published
 * stable releases) or the tags API (which has every git tag).
 *
 * `tagSuffix` filters tags to only those ending with the given string
 * (e.g. "-ee" for GitLab).
 */
async function latestGitHubRelease(
  owner: string,
  repo: string,
  kind: "releases" | "tags",
  tagSuffix?: string,
): Promise<string | null> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const url = `https://api.github.com/repos/${owner}/${repo}/${kind}?per_page=50`;

  const resp = await fetchWithRetry(url, 4, 1000, { headers });

  const items = (await resp.json()) as Array<{
    tag_name?: string;
    name?: string;
    prerelease?: boolean;
  }>;

  let best: string | null = null;
  let bestParsed: number[] | null = null;

  for (const item of items) {
    const rawTag = kind === "releases" ? (item.tag_name ?? "") : (item.name ?? "");
    if (!rawTag) continue;

    // For releases, the GitHub API pre-release flag is authoritative
    if (kind === "releases" && item.prerelease === true) continue;

    // Additional pre-release guard on tag name
    if (isPreRelease(rawTag)) continue;

    // Apply optional suffix filter (e.g. "-ee" for GitLab)
    if (tagSuffix && !rawTag.endsWith(tagSuffix)) continue;

    const parsed = parseVersion(rawTag);
    if (!parsed) continue;

    if (!bestParsed || compareVersionTuples(parsed, bestParsed) > 0) {
      best = rawTag;
      bestParsed = parsed;
    }
  }

  return best;
}

/** Build the real GitHub-backed upstream resolver from a lexicon's declared `upstream` descriptor. */
function resolverFor(pin: UpstreamPin): UpstreamResolver {
  return () => latestGitHubRelease(pin.upstream.owner, pin.upstream.repo, pin.upstream.kind, pin.upstream.tagSuffix);
}

// ── Main function ─────────────────────────────────────────────────────

/**
 * Check whether a newer upstream release exists for a pinned lexicon.
 *
 * When a newer version is found:
 *   1. Applies the version bump to the source constant.
 *   2. Runs regenLexicon (surface-diff pipeline).
 *   3. Reverts the bump unconditionally.
 *
 * The caller receives the full result including the regen validation output
 * without any lasting change to the working tree.
 */
export async function checkPinnedUpgrade(opts: CheckPinnedUpgradeOptions): Promise<UpgradeCheckResult> {
  const { lexiconDir, lexicon, force = false, verbose = false, skipBuild, skipBundle, skipLint } = opts;

  const pin = await loadUpstreamPin(lexicon);
  if (!pin) {
    return {
      lexicon,
      hasUpgrade: false,
      from: "(unknown)",
      to: null,
      validation: null,
      fetchError: `Lexicon "${lexicon}" declares no upstreamPin (not self-upgradable), or its plugin package could not be loaded.`,
    };
  }
  const location = pinLocationFrom(pin, lexiconDir);

  // Read current pin
  const from = readPinnedVersion(location);
  if (!from) {
    return {
      lexicon,
      hasUpgrade: false,
      from: "(unknown)",
      to: null,
      validation: null,
      fetchError: `Could not read pinned version constant from ${location.filePath}`,
    };
  }

  // Query upstream
  const resolver = opts.resolverOverride ?? resolverFor(pin);
  let latestTag: string | null;
  try {
    latestTag = await resolver();
  } catch (e) {
    return {
      lexicon,
      hasUpgrade: false,
      from,
      to: null,
      validation: null,
      fetchError: String(e),
    };
  }

  if (!latestTag || !isNewer(latestTag, from)) {
    return {
      lexicon,
      hasUpgrade: false,
      from,
      to: latestTag,
      validation: null,
      fetchError: null,
    };
  }

  // Apply bump, regen, then revert
  let originalContent: string;
  try {
    originalContent = applyVersionBump(location, latestTag);
  } catch (e) {
    return {
      lexicon,
      hasUpgrade: true,
      from,
      to: latestTag,
      validation: null,
      fetchError: `Failed to apply version bump to ${location.filePath}: ${String(e)}`,
    };
  }

  let validation: RegenResult;
  try {
    validation = await regenLexicon({
      lexiconDir,
      force,
      verbose,
      skipBuild: skipBuild ?? false,
      skipBundle: skipBundle ?? false,
      skipLint: skipLint ?? false,
      skipExamples: true,
    });
  } finally {
    // Always revert — even if regenLexicon throws
    revertVersionBump(location.filePath, originalContent);
  }

  return {
    lexicon,
    hasUpgrade: true,
    from,
    to: latestTag,
    validation,
    fetchError: null,
  };
}

// ── Branch-commit helper ──────────────────────────────────────────────

/**
 * Apply a version bump for a lexicon permanently (without reverting).
 *
 * Called by LexiconUpgradeOp when it has already decided to commit the bump
 * to a branch. Returns the absolute path to the modified file so the caller
 * can stage it with `git add`.
 *
 * Unlike `applyVersionBump` (which is generic), this function takes only a
 * lexicon id and directory — it resolves the pin location from the lexicon's
 * declared `upstreamPin` descriptor.
 */
export async function applyPinnedVersionBump(
  lexicon: LexiconId,
  lexiconDir: string,
  newVersion: string,
): Promise<{ filePath: string }> {
  const pin = await loadUpstreamPin(lexicon);
  if (!pin) throw new Error(`Lexicon "${lexicon}" declares no upstreamPin (not self-upgradable).`);
  const location = pinLocationFrom(pin, lexiconDir);
  applyVersionBump(location, newVersion);
  return { filePath: location.filePath };
}
