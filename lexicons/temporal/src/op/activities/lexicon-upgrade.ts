/**
 * lexiconUpgrade — the upgrade-detection and PR-automation activity for
 * in-scope lexicons (k8s, gcp, docker, gitlab, aws, azure, github).
 *
 * Classifies the lexicon as pinned or rolling, calls the right check function,
 * then surfaces the result in the requested mode: report (default), issue, or
 * pull-request. In pull-request mode it maintains a long-lived branch per
 * lexicon (`lexicon-upgrade/<lexicon>`), updates the PR in place when the delta
 * changes, and applies a semver label derived from the surface severity.
 *
 * For pinned lexicons in pull-request mode, the PR also bumps the lexicon's
 * own package.json version according to the semver label (minor → minor bump,
 * breaking → major bump). Merging the PR carries the version change so
 * publish-on-merge can ship just that lexicon without a full monorepo release.
 *
 * Rolling lexicons (aws, azure, github) drift on their own cadence and are not
 * version-bumped here — they move to drift-issues per #546.
 *
 * Supply-chain note: this activity never executes spec-provided content.
 * It only reads the artifacts produced by the lexicon's own generate step,
 * which is called through the lexicon's npm prepack chain.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UpgradeCheckResult, LexiconId } from "@intentius/chant/codegen/pinned-upgrade";
import type { RollingUpgradeResult, RollingLexicon } from "@intentius/chant/codegen/rolling-upgrade";

const execAsync = promisify(exec);

// ── Public types ──────────────────────────────────────────────────────

/** Finding mode, mirrors ReconcileOp's mode. */
export type LexiconUpgradeMode = "report" | "issue" | "pull-request";

/** All lexicons supported by this activity. */
export type SupportedLexicon = LexiconId | RollingLexicon;

/** Semver label applied to upgrade PRs. */
export type SemverLabel = "minor" | "breaking";

export interface LexiconUpgradeArgs {
  /**
   * Which lexicon to check. Determines pinned vs rolling dispatch:
   *   PINNED: k8s, gcp, docker, gitlab
   *   ROLLING: aws, azure, github
   */
  lexicon: SupportedLexicon;
  /**
   * Absolute path to the lexicon root directory.
   * Defaults to `<cwd>/lexicons/<lexicon>`.
   */
  lexiconDir?: string;
  /** What to produce. Default: "report". */
  mode?: LexiconUpgradeMode;
  /**
   * Override the pinned check function — inject a mock in tests.
   * The real implementation calls checkPinnedUpgrade from core.
   */
  _checkPinned?: CheckPinnedFn;
  /**
   * Override the rolling check function — inject a mock in tests.
   * The real implementation calls checkRollingUpgrade from core.
   */
  _checkRolling?: CheckRollingFn;
  /**
   * Override the gh/git runner — inject a mock in tests.
   */
  _gh?: GhRunner;
  /**
   * Override the applyPinnedVersionBump function — inject a mock in tests.
   */
  _applyBump?: ApplyBumpFn;
  /**
   * Override the package.json version writer — inject a mock in tests.
   * Defaults to bumpPackageJsonVersion.
   */
  _bumpPackageVersion?: BumpPackageVersionFn;
}

export interface LexiconUpgradeResult {
  lexicon: SupportedLexicon;
  mode: LexiconUpgradeMode;
  /** True when an upgrade is available and validation passed. */
  hasUpgrade: boolean;
  /** Human-readable surface delta summary. Empty when no upgrade. */
  deltaText: string;
  /** Semver label applied to the PR. null when no upgrade or no change. */
  semverLabel: SemverLabel | null;
  /** URL of the opened/updated PR (pull-request mode). */
  prUrl?: string;
  /** URL of the opened issue (issue mode). */
  issueUrl?: string;
  /** Full markdown summary, used as PR/issue body or printed in report mode. */
  summary: string;
  /** Whether validation passed. False means a breakage report was produced. */
  validationOk: boolean;
}

// ── Injected dependency types ─────────────────────────────────────────

/** Matches checkPinnedUpgrade from core. */
export type CheckPinnedFn = (opts: {
  lexiconDir: string;
  lexicon: LexiconId;
  force?: boolean;
  verbose?: boolean;
}) => Promise<UpgradeCheckResult>;

/** Matches checkRollingUpgrade from core. */
export type CheckRollingFn = (opts: {
  lexiconDir: string;
  force?: boolean;
  verbose?: boolean;
}) => Promise<RollingUpgradeResult>;

/** Minimal shell-exec interface for gh/git invocations. */
export type GhRunner = (cmd: string) => Promise<{ stdout: string; stderr: string }>;

/** Applies a pinned version bump permanently (no revert). */
export type ApplyBumpFn = (lexicon: LexiconId, lexiconDir: string, newVersion: string) => { filePath: string };

/**
 * Write a new version into a package.json, returning the file path.
 * Injectable for tests via LexiconUpgradeArgs._bumpPackageVersion.
 */
export type BumpPackageVersionFn = (packageJsonPath: string, newVersion: string) => void;

// ── Package.json version bumping ──────────────────────────────────────

/**
 * Compute a bumped semver string from a current version and a semver label.
 *
 * The mapping is 0.x-aware, because promoting to 1.0.0 should signal the
 * lexicon's own API stability, not track an upstream spec's breaking change:
 *
 * - Pre-1.0 (major === 0): "breaking" bumps the minor (0.13.1 → 0.14.0),
 *   "minor" (additive) bumps the patch (0.13.1 → 0.13.2). Never auto-1.0.0.
 * - >= 1.0.0: "minor" bumps the minor (1.2.3 → 1.3.0), "breaking" bumps the
 *   major (1.2.3 → 2.0.0).
 *
 * Handles the common "MAJOR.MINOR.PATCH" form. Returns null when the
 * current version string cannot be parsed as M.m.p.
 */
export function computeBumpedVersion(
  current: string,
  label: SemverLabel,
): string | null {
  const parts = current.replace(/^v/, "").split(".").map(Number);
  if (parts.length < 3 || parts.some((n) => Number.isNaN(n) || n < 0)) return null;
  const [major, minor, patch] = parts as [number, number, number];
  // Pre-1.0: keep the package in 0.x — breaking → minor, additive → patch.
  if (major === 0) {
    if (label === "minor") return `0.${minor}.${patch + 1}`;
    if (label === "breaking") return `0.${minor + 1}.0`;
    return null;
  }
  // >= 1.0.0: additive → minor, breaking → major.
  if (label === "minor") return `${major}.${minor + 1}.0`;
  if (label === "breaking") return `${major + 1}.0.0`;
  return null;
}

/**
 * Read package.json at `packageJsonPath`, set `version` to `newVersion`,
 * and write it back. Preserves all other fields and 2-space indent.
 */
export function bumpPackageJsonVersion(packageJsonPath: string, newVersion: string): void {
  const raw = readFileSync(packageJsonPath, "utf-8");
  const pkg = JSON.parse(raw) as Record<string, unknown>;
  pkg["version"] = newVersion;
  writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
}

// ── Classification ────────────────────────────────────────────────────

const PINNED_LEXICONS: ReadonlySet<string> = new Set<LexiconId>(["k8s", "gcp", "docker", "gitlab"]);
const ROLLING_LEXICONS: ReadonlySet<string> = new Set<RollingLexicon>(["aws", "azure", "github"]);

/** Return true when the lexicon uses a pinned version constant. */
export function isPinned(lexicon: SupportedLexicon): lexicon is LexiconId {
  return PINNED_LEXICONS.has(lexicon);
}

/** Return true when the lexicon follows a rolling spec (no pinned constant). */
export function isRolling(lexicon: SupportedLexicon): lexicon is RollingLexicon {
  return ROLLING_LEXICONS.has(lexicon);
}

// ── Semver labeling ───────────────────────────────────────────────────

/**
 * Map a surface severity to a semver label for the PR.
 *
 * "additive" → "minor"   (new resources/properties added)
 * "breaking" → "breaking" (removed or changed resources/properties)
 * "none"     → null       (surface unchanged)
 */
export function severityToLabel(severity: string): SemverLabel | null {
  if (severity === "additive") return "minor";
  if (severity === "breaking") return "breaking";
  return null;
}

// ── Branch / PR naming ────────────────────────────────────────────────

/** Long-lived branch name for a lexicon upgrade PR. */
export function upgradeBranchName(lexicon: SupportedLexicon): string {
  return `lexicon-upgrade/${lexicon}`;
}

/** PR title for an upgrade. */
export function upgradePrTitle(
  lexicon: SupportedLexicon,
  from?: string,
  to?: string | null,
): string {
  if (from && to) return `feat(${lexicon}): upgrade spec ${from} to ${to}`;
  return `feat(${lexicon}): upgrade to latest spec`;
}

// ── Markdown summary builder ──────────────────────────────────────────

/** Build the PR/issue/report body from the upgrade result data. */
export function buildUpgradeSummary(opts: {
  lexicon: SupportedLexicon;
  from?: string;
  to?: string | null;
  deltaText: string;
  semverLabel: SemverLabel | null;
  validationOk: boolean;
  failures?: Array<{ step: string; output: string }>;
}): string {
  const { lexicon, from, to, deltaText, semverLabel, validationOk, failures = [] } = opts;

  // Example validation status (#604): the upgrade check lints the lexicon's
  // examples (regenLexicon step 6), and an example failure makes validation
  // fail. Surface it explicitly so the PR / drift issue states example health
  // instead of leaving it implicit in CI. (The authoritative example *build*
  // still runs in CI — the pinned PR's test job, and main's continuous build
  // for rolling lexicons.)
  const exampleFailures = failures.filter((f) => f.step === "lint" || f.step === "examples");

  const lines: string[] = [`## Lexicon upgrade: ${lexicon}`];
  if (from) lines.push(``, `**From:** \`${from}\`  **To:** \`${to ?? "latest"}\``);
  if (semverLabel) lines.push(`**Semver label:** \`${semverLabel}\``);
  lines.push(
    exampleFailures.length > 0
      ? `**Examples:** ⚠️ ${exampleFailures.length} check(s) failing — see Validation failures below`
      : `**Examples:** lint clean`,
  );

  lines.push(``);

  if (!validationOk) {
    lines.push(`### Validation failures`);
    lines.push(``);
    lines.push(`Regen or validation did not pass. Review the failures before merging.`);
    for (const f of failures) {
      lines.push(``, `**Step: ${f.step}**`, "```", f.output.slice(0, 2000), "```");
    }
    lines.push(``);
  }

  if (deltaText) {
    lines.push(`### Surface delta`);
    lines.push(``);
    lines.push(deltaText);
    lines.push(``);
  } else if (validationOk) {
    lines.push(`No surface delta detected.`);
  }

  return lines.join("\n");
}

// ── Shell helpers ─────────────────────────────────────────────────────

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

const defaultGh: GhRunner = async (cmd) => execAsync(cmd);

// ── PR idempotency helpers ────────────────────────────────────────────

/**
 * Check whether an open PR exists for the given branch.
 * Returns the PR URL, or null if none.
 */
async function openPrUrl(branch: string, gh: GhRunner): Promise<string | null> {
  try {
    const { stdout } = await gh(
      `gh pr view ${shellQuote(branch)} --json url,state --jq 'select(.state=="OPEN") | .url'`,
    );
    const url = stdout.trim();
    return url || null;
  } catch {
    return null;
  }
}

/**
 * Read the body of the open PR for `branch`, if any.
 * Returns null when there is no open PR or gh is unavailable.
 */
async function currentPrBody(branch: string, gh: GhRunner): Promise<string | null> {
  try {
    const { stdout } = await gh(
      `gh pr view ${shellQuote(branch)} --json body,state --jq 'select(.state=="OPEN") | .body'`,
    );
    const body = stdout.trim();
    return body || null;
  } catch {
    return null;
  }
}

/**
 * Apply or ensure a label exists on the repo, then add it to the PR.
 * Best-effort — never throws.
 */
async function ensureLabelOnPr(branch: string, label: SemverLabel, gh: GhRunner): Promise<void> {
  try {
    const color = label === "breaking" ? "B60205" : "0075CA";
    await gh(`gh label create ${shellQuote(label)} --color ${shellQuote(color)} --force`).catch(
      () => {/* label already exists */},
    );
    await gh(`gh pr edit ${shellQuote(branch)} --add-label ${shellQuote(label)}`);
  } catch {
    // Best-effort
  }
}

// ── Real check function loaders ───────────────────────────────────────

let _realCheckPinned: CheckPinnedFn | null = null;
let _realCheckRolling: CheckRollingFn | null = null;
let _realApplyBump: ApplyBumpFn | null = null;

async function getRealCheckPinned(): Promise<CheckPinnedFn> {
  if (!_realCheckPinned) {
    const mod = await import("@intentius/chant/codegen/pinned-upgrade");
    _realCheckPinned = (opts) => mod.checkPinnedUpgrade(opts);
  }
  return _realCheckPinned;
}

async function getRealCheckRolling(): Promise<CheckRollingFn> {
  if (!_realCheckRolling) {
    const mod = await import("@intentius/chant/codegen/rolling-upgrade");
    _realCheckRolling = (opts) => mod.checkRollingUpgrade(opts);
  }
  return _realCheckRolling;
}

async function getRealApplyBump(): Promise<ApplyBumpFn> {
  if (!_realApplyBump) {
    const mod = await import("@intentius/chant/codegen/pinned-upgrade");
    _realApplyBump = (lexicon, lexiconDir, newVersion) =>
      mod.applyPinnedVersionBump(lexicon, lexiconDir, newVersion);
  }
  return _realApplyBump;
}

// ── Main activity ─────────────────────────────────────────────────────

/**
 * Run the lexicon upgrade check for one lexicon and surface the result.
 *
 * Pinned lexicons (k8s, gcp, docker, gitlab):
 *   Calls checkPinnedUpgrade. A PR is opened only when hasUpgrade=true AND
 *   validation passed. Validation failures produce a report or issue.
 *
 * Rolling lexicons (aws, azure, github):
 *   Calls checkRollingUpgrade. A PR is opened only when the surface changed
 *   AND validation passed. Surface unchanged = no action.
 *
 * In pull-request mode:
 *   - Branch: lexicon-upgrade/<lexicon> (long-lived, one per lexicon).
 *   - Idempotent: if the open PR body matches the new summary, skip re-push.
 *   - Semver label: "minor" (additive) or "breaking" (changed/removed).
 *   - Validation failure falls back to issue mode.
 *
 * Never auto-merges or auto-publishes.
 */
export async function lexiconUpgrade(args: LexiconUpgradeArgs): Promise<LexiconUpgradeResult> {
  const {
    lexicon,
    mode = "report",
    _gh: gh = defaultGh,
  } = args;

  const lexiconDir = args.lexiconDir ?? `${process.cwd()}/lexicons/${lexicon}`;

  // ── 1. Run the appropriate check ──────────────────────────────────

  let hasUpgrade: boolean;
  let deltaText: string;
  let severity: string;
  let validationOk: boolean;
  let failures: Array<{ step: string; output: string }> = [];
  let from: string | undefined;
  let to: string | null | undefined;
  let freshSnapshotJson: string | null = null;

  if (isPinned(lexicon)) {
    const checkPinned = args._checkPinned ?? (await getRealCheckPinned());
    const result = await checkPinned({ lexiconDir, lexicon });

    if (result.fetchError) {
      const summary = buildUpgradeSummary({
        lexicon,
        from: result.from,
        to: result.to,
        deltaText: "",
        semverLabel: null,
        validationOk: false,
        failures: [{ step: "upstream-fetch", output: result.fetchError }],
      });
      return {
        lexicon,
        mode,
        hasUpgrade: false,
        deltaText: "",
        semverLabel: null,
        summary,
        validationOk: false,
      };
    }

    hasUpgrade = result.hasUpgrade;
    from = result.from;
    to = result.to;
    severity = result.validation?.severity ?? "none";
    deltaText = result.validation?.deltaText ?? "";
    validationOk = result.validation?.ok ?? true;
    failures = (result.validation?.failures ?? []).map((f) => ({ step: f.step, output: f.output }));
    if (result.validation?.freshSnapshot) {
      const { serializeSnapshot } = await import("@intentius/chant/codegen/surface-snapshot");
      freshSnapshotJson = serializeSnapshot(result.validation.freshSnapshot);
    }
  } else if (isRolling(lexicon)) {
    const checkRolling = args._checkRolling ?? (await getRealCheckRolling());
    const result = await checkRolling({ lexiconDir });

    hasUpgrade = result.hasUpgrade;
    severity = result.severity;
    deltaText = result.deltaText;
    validationOk = result.validationOk;
    failures = (result.failures ?? []).map((f) => ({ step: f.step, output: f.output }));
    if (result.freshSnapshot) {
      const { serializeSnapshot } = await import("@intentius/chant/codegen/surface-snapshot");
      freshSnapshotJson = serializeSnapshot(result.freshSnapshot);
    }
  } else {
    throw new Error(
      `Lexicon "${lexicon as string}" is not supported by LexiconUpgradeOp. ` +
        `Supported: k8s, gcp, docker, gitlab, aws, azure, github`,
    );
  }

  const semverLabel = severityToLabel(severity);
  const summary = buildUpgradeSummary({
    lexicon,
    from,
    to,
    deltaText,
    semverLabel,
    validationOk,
    failures,
  });

  // ── 2. No upgrade ─────────────────────────────────────────────────

  if (!hasUpgrade) {
    return {
      lexicon,
      mode,
      hasUpgrade: false,
      deltaText,
      semverLabel: null,
      summary,
      validationOk,
    };
  }

  // ── 3. Validation failure: surface as report or issue, never PR ───

  if (!validationOk) {
    const effectiveMode: LexiconUpgradeMode = mode === "pull-request" ? "issue" : mode;
    if (effectiveMode === "issue") {
      const title = `chore(${lexicon}): spec upgrade validation failed`;
      const { stdout } = await gh(
        `gh issue create --title ${shellQuote(title)} --body ${shellQuote(summary)}`,
      );
      return {
        lexicon,
        mode,
        hasUpgrade: true,
        deltaText,
        semverLabel,
        issueUrl: stdout.trim(),
        summary,
        validationOk: false,
      };
    }
    return {
      lexicon,
      mode,
      hasUpgrade: true,
      deltaText,
      semverLabel,
      summary,
      validationOk: false,
    };
  }

  // ── 4. Upgrade ready: surface according to mode ───────────────────

  const title = upgradePrTitle(lexicon, from, to);

  // #546: rolling lexicons have no version pin, so a "pull-request" would only
  // refresh the baseline snapshot — low signal, no build-output change. Surface
  // rolling drift as an issue instead; re-baselining stays a deliberate
  // maintainer action (`chant dev surface-diff <lexicon> --update-snapshot`).
  // Pinned lexicons keep opening version-bump PRs.
  const effectiveMode: LexiconUpgradeMode =
    mode === "pull-request" && isRolling(lexicon) ? "issue" : mode;

  if (effectiveMode === "report") {
    return {
      lexicon,
      mode: effectiveMode,
      hasUpgrade: true,
      deltaText,
      semverLabel,
      summary,
      validationOk: true,
    };
  }

  if (effectiveMode === "issue") {
    const { stdout } = await gh(
      `gh issue create --title ${shellQuote(title)} --body ${shellQuote(summary)}`,
    );
    return {
      lexicon,
      mode: effectiveMode,
      hasUpgrade: true,
      deltaText,
      semverLabel,
      issueUrl: stdout.trim(),
      summary,
      validationOk: true,
    };
  }

  // ── 5. pull-request mode: idempotent branch + PR management ──────

  const branch = upgradeBranchName(lexicon);

  // Idempotency check: if the open PR already has this summary, nothing changed.
  // Compare trimmed — gh/git round-trips can alter trailing whitespace.
  const existingPrBody = await currentPrBody(branch, gh);
  if (existingPrBody !== null && existingPrBody.trim() === summary.trim()) {
    const existingUrl = await openPrUrl(branch, gh);
    return {
      lexicon,
      mode,
      hasUpgrade: true,
      deltaText,
      semverLabel,
      prUrl: existingUrl ?? undefined,
      summary,
      validationOk: true,
    };
  }

  // Reset/create the long-lived branch from main and commit the changes.
  // All git shell-outs go through the injectable `gh` runner (which defaults to
  // execAsync) so tests can mock them — a test must never touch the real repo
  // or push to origin.
  await gh(`git fetch origin main`);
  await gh(
    `git branch -f ${shellQuote(branch)} origin/main`,
  ).catch(async () => {
    await gh(`git branch ${shellQuote(branch)} origin/main`);
  });

  // Save current branch, switch to upgrade branch.
  const { stdout: currentBranch } = await gh(`git rev-parse --abbrev-ref HEAD`);
  const savedBranch = currentBranch.trim();

  await gh(`git stash --include-untracked`).catch(() => {/* nothing to stash */});

  try {
    await gh(`git checkout ${shellQuote(branch)}`);

    // For pinned lexicons: apply the spec version bump permanently on this branch.
    if (isPinned(lexicon) && to) {
      const applyBump = args._applyBump ?? (await getRealApplyBump());
      const { filePath } = applyBump(lexicon, lexiconDir, to);
      await gh(`git add ${shellQuote(filePath)}`).catch(() => {/* best-effort */});

      // Bump the lexicon's package.json version so merging this PR causes
      // publish-on-merge to ship exactly this lexicon (minor → minor bump,
      // breaking → major bump). Rolling lexicons are excluded — they use
      // drift-issues (#546) and do not pin to a version constant.
      if (semverLabel) {
        const pkgJsonPath = join(lexiconDir, "package.json");
        const raw = readFileSync(pkgJsonPath, "utf-8");
        const pkg = JSON.parse(raw) as { version?: string };
        const currentVersion = pkg.version ?? "0.0.0";
        const bumpedVersion = computeBumpedVersion(currentVersion, semverLabel);
        if (bumpedVersion) {
          const doBump = args._bumpPackageVersion ?? bumpPackageJsonVersion;
          doBump(pkgJsonPath, bumpedVersion);
          await gh(`git add ${shellQuote(pkgJsonPath)}`).catch(() => {/* best-effort */});
        }
      }
    }

    // Write and stage the fresh surface snapshot.
    if (freshSnapshotJson) {
      const { SNAPSHOT_FILENAME } = await import("@intentius/chant/codegen/lexicon-regen");
      const snapshotPath = join(lexiconDir, SNAPSHOT_FILENAME);
      writeFileSync(snapshotPath, freshSnapshotJson, "utf-8");
      await gh(`git add ${shellQuote(snapshotPath)}`).catch(() => {/* best-effort */});
    }

    await gh(`git commit -m ${shellQuote(title)} --allow-empty`);

    // Push to origin — force-with-lease, then fall back to force on first push.
    await gh(`git push -u origin ${shellQuote(branch)} --force-with-lease`).catch(async () => {
      await gh(`git push -u origin ${shellQuote(branch)} --force`);
    });

    // Open or update the PR.
    const existingUrl = await openPrUrl(branch, gh);
    let prUrl: string;

    if (existingUrl) {
      await gh(`gh pr edit ${shellQuote(branch)} --title ${shellQuote(title)} --body ${shellQuote(summary)}`);
      prUrl = existingUrl;
    } else {
      const { stdout } = await gh(
        `gh pr create --title ${shellQuote(title)} --body ${shellQuote(summary)} --head ${shellQuote(branch)} --base main`,
      );
      prUrl = stdout.trim();
    }

    if (semverLabel) {
      await ensureLabelOnPr(branch, semverLabel, gh);
    }

    return {
      lexicon,
      mode,
      hasUpgrade: true,
      deltaText,
      semverLabel,
      prUrl,
      summary,
      validationOk: true,
    };
  } finally {
    await gh(`git checkout ${shellQuote(savedBranch)}`).catch(() => {/* best-effort */});
    await gh(`git stash pop`).catch(() => {/* nothing to pop */});
  }
}
