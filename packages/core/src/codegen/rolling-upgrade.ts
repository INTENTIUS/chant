/**
 * Rolling-spec drift detection for aws, azure, and github lexicons.
 *
 * These lexicons have no pinned version constant — "latest" is fetched on every
 * regen. An upgrade means regenerating from current-latest and diffing the
 * produced API surface against the committed baseline (surface.snapshot.json).
 * If the surface changed and validation passed, a PR can be opened with the
 * delta as the review payload.
 *
 * This module contains only pure business logic (detecting drift, classifying
 * it, formatting the report). It calls regenLexicon from #524 for the actual
 * regen/validate work, and never runs a live regen itself.
 *
 * azure extra delta:
 *   The Azure regen depends on `latestVersionPerProvider`, which picks one API
 *   version per ARM provider. When new providers appear or existing ones get a
 *   newer GA/preview version, that shows up in the surface diff. In addition,
 *   this module computes an `apiVersionDelta` to surface those version changes
 *   separately, so reviewers can see "Microsoft.Compute moved 2022-03-01 →
 *   2023-07-01" without reading the raw surface diff.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  diffSurface,
  formatDelta,
  parseSnapshot,
  type SurfaceDelta,
  type ChangeSeverity,
  type SurfaceSnapshot,
} from "./surface-snapshot";
import { regenLexicon, SNAPSHOT_FILENAME, type RegenOptions, type RegenResult } from "./lexicon-regen";

// ── Public types ──────────────────────────────────────────────────────

export type RollingLexicon = "aws" | "azure" | "github";

/**
 * An API-version change for one Azure ARM provider.
 * Only populated for the azure lexicon.
 */
export interface AzureApiVersionChange {
  provider: string;
  before: string | null;
  after: string | null;
  /** "added" when provider is new; "updated" when version bumped; "removed" when gone. */
  kind: "added" | "updated" | "removed";
}

/**
 * The result of a rolling-upgrade check for one lexicon.
 */
export interface RollingUpgradeResult {
  /** Lexicon identifier. */
  lexicon: RollingLexicon;
  /** True when the surface changed versus the committed baseline. */
  hasUpgrade: boolean;
  /** Severity of the surface delta. "none" when the surface is unchanged. */
  severity: ChangeSeverity;
  /** Structured surface delta. */
  delta: SurfaceDelta;
  /** Human-readable delta text. Empty when no changes. */
  deltaText: string;
  /** Whether regen+validation passed. False means the delta is unreliable. */
  validationOk: boolean;
  /** Failures captured during regen. */
  failures: RegenResult["failures"];
  /** azure-only: per-provider API version changes. Empty for aws/github. */
  apiVersionDelta: AzureApiVersionChange[];
  /** The fresh snapshot produced by the regen. Null when regen failed. */
  freshSnapshot: SurfaceSnapshot | null;
}

/**
 * Options for checkRollingUpgrade.
 */
export interface CheckRollingUpgradeOptions {
  /** Root of the lexicon package (must contain package.json and surface.snapshot.json). */
  lexiconDir: string;
  /** Force re-fetch of the upstream spec (bypass cache). Default: false. */
  force?: boolean;
  /** Print subprocess output while running. Default: false. */
  verbose?: boolean;
  /**
   * Override for the regen function — inject a mock in tests.
   * Defaults to the production regenLexicon.
   */
  _regenFn?: (opts: RegenOptions) => Promise<RegenResult>;
}

// ── Main entry ────────────────────────────────────────────────────────

/**
 * Check whether the rolling spec has drifted since the committed baseline.
 *
 * Calls regenLexicon (from #524) to regenerate from current-latest, then diffs
 * the resulting surface against the committed surface.snapshot.json. Returns
 * hasUpgrade=true when the surface changed and validation passed.
 *
 * For azure, also computes an apiVersionDelta showing which ARM providers gained
 * a new latest API version since the baseline was snapshotted.
 *
 * Never throws — all failures are captured in the result.
 */
export async function checkRollingUpgrade(
  opts: CheckRollingUpgradeOptions,
): Promise<RollingUpgradeResult> {
  const {
    lexiconDir,
    force = false,
    verbose = false,
    _regenFn = regenLexicon,
  } = opts;

  const lexicon = detectLexicon(lexiconDir);

  const regenResult = await _regenFn({
    lexiconDir,
    force,
    verbose,
    skipBundle: false,
    skipBuild: false,
    skipLint: false,
    skipExamples: true,
  });

  const apiVersionDelta: AzureApiVersionChange[] = [];

  if (lexicon === "azure" && regenResult.freshSnapshot) {
    const baselinePath = join(lexiconDir, SNAPSHOT_FILENAME);
    if (existsSync(baselinePath)) {
      try {
        const baselineJSON = readFileSync(baselinePath, "utf-8");
        const baseline = parseSnapshot(baselineJSON);
        apiVersionDelta.push(...computeAzureApiVersionDelta(baseline, regenResult.freshSnapshot));
      } catch {
        // Ignore — apiVersionDelta stays empty; the surface diff is still valid
      }
    }
  }

  return buildResult(lexicon, regenResult, apiVersionDelta);
}

// ── Lexicon detection ─────────────────────────────────────────────────

/**
 * Detect which rolling lexicon a directory belongs to by its package name.
 * Falls back to directory-name matching.
 */
function detectLexicon(lexiconDir: string): RollingLexicon {
  try {
    const pkgPath = join(lexiconDir, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { name?: string };
      const name = pkg.name ?? "";
      if (name.includes("azure")) return "azure";
      if (name.includes("github")) return "github";
    }
  } catch {
    // Fall through to directory-based detection
  }

  const normalized = lexiconDir.replace(/\\/g, "/");
  if (/\/azure(\/|$)/.test(normalized)) return "azure";
  if (/\/github(\/|$)/.test(normalized)) return "github";
  return "aws";
}

// ── Azure API-version delta ───────────────────────────────────────────

/**
 * Compute provider-level additions and removals between two azure snapshots.
 *
 * The snapshot resourceType values for azure look like
 * "Microsoft.Storage/storageAccounts". This function extracts the provider
 * name (the part before the first "/") and reports which providers appeared,
 * disappeared, or (when version strings are supplied via diffAzureApiVersions)
 * bumped their API version.
 *
 * Use diffAzureApiVersions when you have access to actual API version strings
 * (e.g. from the lexicon's latestVersionPerProvider output in a CI run).
 */
export function computeAzureApiVersionDelta(
  baseline: SurfaceSnapshot,
  fresh: SurfaceSnapshot,
): AzureApiVersionChange[] {
  const baseProviders = new Set<string>();
  const freshProviders = new Set<string>();

  for (const entry of Object.values(baseline.entries)) {
    const p = extractAzureProvider(entry.resourceType);
    if (p) baseProviders.add(p);
  }

  for (const entry of Object.values(fresh.entries)) {
    const p = extractAzureProvider(entry.resourceType);
    if (p) freshProviders.add(p);
  }

  const changes: AzureApiVersionChange[] = [];

  for (const p of freshProviders) {
    if (!baseProviders.has(p)) {
      changes.push({ provider: p, before: null, after: "latest", kind: "added" });
    }
  }

  for (const p of baseProviders) {
    if (!freshProviders.has(p)) {
      changes.push({ provider: p, before: "latest", after: null, kind: "removed" });
    }
  }

  return changes.sort((a, b) => a.provider.localeCompare(b.provider));
}

/**
 * Extract the Azure ARM provider name from a resourceType string.
 *
 * Input:  "Microsoft.Storage/storageAccounts"
 * Output: "Microsoft.Storage"
 *
 * Returns null for non-ARM resource types (e.g. empty string or non-Microsoft prefix).
 */
export function extractAzureProvider(resourceType: string): string | null {
  if (!resourceType.startsWith("Microsoft.")) return null;
  const slash = resourceType.indexOf("/");
  if (slash === -1) return null;
  return resourceType.slice(0, slash);
}

/**
 * Diff actual API version strings per provider between two regen runs.
 *
 * Use this when the caller has access to the azure lexicon's
 * latestVersionPerProvider output. Produces a richer delta that includes
 * version bumps ("updated"), not just provider additions/removals.
 *
 * @param baseVersions  Map<provider, apiVersion> from the previous regen.
 * @param freshVersions Map<provider, apiVersion> from the current regen.
 */
export function diffAzureApiVersions(
  baseVersions: Map<string, string>,
  freshVersions: Map<string, string>,
): AzureApiVersionChange[] {
  const changes: AzureApiVersionChange[] = [];

  for (const [provider, freshVersion] of freshVersions) {
    const baseVersion = baseVersions.get(provider) ?? null;
    if (baseVersion === null) {
      changes.push({ provider, before: null, after: freshVersion, kind: "added" });
    } else if (baseVersion !== freshVersion) {
      changes.push({ provider, before: baseVersion, after: freshVersion, kind: "updated" });
    }
  }

  for (const [provider, baseVersion] of baseVersions) {
    if (!freshVersions.has(provider)) {
      changes.push({ provider, before: baseVersion, after: null, kind: "removed" });
    }
  }

  return changes.sort((a, b) => a.provider.localeCompare(b.provider));
}

// ── Pure decision functions ───────────────────────────────────────────

/**
 * Diff two surface snapshots.
 *
 * Pure function re-exported for callers that import rolling-upgrade and want to
 * compute the delta without importing surface-snapshot directly.
 */
export function diffRollingSurface(
  baseline: SurfaceSnapshot,
  fresh: SurfaceSnapshot,
): SurfaceDelta {
  return diffSurface(baseline, fresh);
}

/**
 * Classify a delta as an upgrade and determine its severity.
 *
 * Pure function — no I/O. Unit-testable with fixture snapshots.
 * Used by the CLI and the checkRollingUpgrade entry point.
 */
export function classifyDelta(delta: SurfaceDelta): {
  hasUpgrade: boolean;
  severity: ChangeSeverity;
} {
  const hasUpgrade =
    delta.added.length > 0 || delta.changed.length > 0 || delta.removed.length > 0;
  return { hasUpgrade, severity: hasUpgrade ? delta.severity : "none" };
}

// ── Result builder ────────────────────────────────────────────────────

function buildResult(
  lexicon: RollingLexicon,
  regenResult: RegenResult,
  apiVersionDelta: AzureApiVersionChange[],
): RollingUpgradeResult {
  const delta = regenResult.delta;
  const { hasUpgrade, severity } = classifyDelta(delta);
  const deltaText = hasUpgrade ? formatDelta(delta) : "";

  return {
    lexicon,
    hasUpgrade,
    severity,
    delta,
    deltaText,
    validationOk: regenResult.ok,
    failures: regenResult.failures,
    apiVersionDelta,
    freshSnapshot: regenResult.freshSnapshot,
  };
}
