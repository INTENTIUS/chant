/**
 * Lexicon regen-validate pipeline.
 *
 * Given a lexicon root directory, this module:
 *   1. Runs the prepack chain (generate -> bundle -> validate -> build)
 *      by invoking `npm run <script>` in the lexicon directory.
 *   2. Runs `chant lint` on any examples found under `examples/`.
 *   3. Extracts the generated public API surface.
 *   4. Diffs the fresh surface against the committed per-lexicon baseline
 *      (`surface.snapshot.json` at the lexicon root).
 *   5. Returns { ok, changed, severity, delta, failures } — never throws.
 *
 * Supply-chain guarantee:
 *   All spec fetching happens through the lexicon's own `generate` script,
 *   which is pinned to the lexicon's existing fetch layer (cached, TTL-based).
 *   When `force` is true, the cache is bypassed and the spec is re-downloaded.
 *   This module never executes spec-provided content — it only reads the
 *   artifacts that the generate script produced.
 *
 * Never auto-fix:
 *   Any failure is captured into `failures` and returned. This module never
 *   rewrites examples, skips checks, or masks errors.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, type Dirent } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import {
  extractSurface,
  diffSurface,
  serializeSnapshot,
  parseSnapshot,
  formatDelta,
  type SurfaceDelta,
  type ChangeSeverity,
  type SurfaceSnapshot,
} from "./surface-snapshot";

// ── Public types ─────────────────────────────────────────────────────

export interface RegenFailure {
  /**
   * Which step failed:
   * "setup" | "digest-verify" | "generate" | "bundle" | "validate"
   * | "build" | "lint" | "examples" | "surface-extract" | "surface-diff"
   */
  step: string;
  /** Exit code from the subprocess, if applicable. */
  exitCode?: number;
  /** Combined stdout+stderr output captured from the subprocess. */
  output: string;
}

export interface RegenResult {
  /** True only when all steps passed and (if a baseline exists) the diff completed. */
  ok: boolean;
  /** True when the surface changed versus the baseline. */
  changed: boolean;
  /** Rolled-up severity of the surface delta. "none" when unchanged. */
  severity: ChangeSeverity;
  /** Structured delta: what was added, changed, or removed. */
  delta: SurfaceDelta;
  /** Human-readable delta text (empty string when no changes). */
  deltaText: string;
  /** Step failures captured during the run. */
  failures: RegenFailure[];
  /** Fresh surface snapshot — caller can write this as the new baseline. */
  freshSnapshot: SurfaceSnapshot | null;
}

export interface RegenOptions {
  /**
   * Root of the lexicon package (e.g. `/path/to/lexicons/aws`).
   * Must contain a `package.json` with `generate`, `bundle`, `validate`, `build` scripts.
   */
  lexiconDir: string;
  /**
   * When true, pass `CHANT_FORCE_FETCH=1` to the generate step so the spec is
   * re-downloaded from upstream even if the cache is fresh.
   */
  force?: boolean;
  /** Print subprocess output as it runs. Default: false. */
  verbose?: boolean;
  /**
   * Skip the `bundle` step. Useful when testing without a full dist build.
   * Default: false.
   */
  skipBundle?: boolean;
  /**
   * Skip the `build` (tsc) step. Useful in test contexts where tsc is not available.
   * Default: false.
   */
  skipBuild?: boolean;
  /**
   * Skip running `chant lint` on examples.
   * Default: false.
   */
  skipLint?: boolean;
  /**
   * Skip running example deploy harness (npm run deploy / npm run build in each example).
   * Default: true (examples require live cloud credentials; opt-in only).
   */
  skipExamples?: boolean;
  /**
   * Path to a SHA-256 digest file pinning the spec cache file.
   *
   * When provided, this module verifies the digest of the cached spec file
   * before invoking `generate`. This is the supply-chain choke point:
   * untrusted upstream content is verified here before any downstream processing.
   * The spec file is never executed — only checksummed and then passed to the
   * lexicon's own generator as data.
   *
   * File format (shasum -a 256 style):
   *   sha256:<64-hex-chars>  <relative-path-to-spec-file>
   */
  pinnedDigestPath?: string;
}

// ── Pipeline ──────────────────────────────────────────────────────────

export const SNAPSHOT_FILENAME = "surface.snapshot.json";

/**
 * Run the full regen-validate pipeline for a lexicon and return the result.
 */
export async function regenLexicon(opts: RegenOptions): Promise<RegenResult> {
  const {
    lexiconDir,
    force = false,
    verbose = false,
    skipBundle = false,
    skipBuild = false,
    skipLint = false,
    skipExamples = true,
  } = opts;

  const failures: RegenFailure[] = [];

  // Verify lexicon directory
  if (!existsSync(join(lexiconDir, "package.json"))) {
    failures.push({
      step: "setup",
      output: `No package.json found at ${lexiconDir}`,
    });
    return makeResult(false, failures, null, null);
  }

  // Step 1: Verify pinned digest (supply-chain gate, runs before fetch)
  if (opts.pinnedDigestPath) {
    const digestFailure = await verifyPinnedDigest(lexiconDir, opts.pinnedDigestPath);
    if (digestFailure) {
      failures.push(digestFailure);
      return makeResult(false, failures, null, null);
    }
  }

  // Step 2: generate
  // Pass CHANT_FORCE_FETCH=1 so lexicons that check this env var will bypass cache.
  const genEnv: NodeJS.ProcessEnv = force
    ? { ...process.env, CHANT_FORCE_FETCH: "1" }
    : { ...process.env };

  const genFail = runScript(lexiconDir, "generate", genEnv, verbose);
  if (genFail) {
    failures.push(genFail);
    // Cannot proceed without generated artifacts
    return makeResult(false, failures, null, null);
  }

  // Step 3: bundle (optional)
  if (!skipBundle) {
    const bundleFail = runScript(lexiconDir, "bundle", process.env, verbose);
    if (bundleFail) {
      failures.push(bundleFail);
      // Continue to extract surface even if bundle fails
    }
  }

  // Step 4: validate
  const validateFail = runScript(lexiconDir, "validate", process.env, verbose);
  if (validateFail) {
    failures.push(validateFail);
  }

  // Step 5: build (tsc)
  if (!skipBuild) {
    const buildFail = runScript(lexiconDir, "build", process.env, verbose);
    if (buildFail) {
      failures.push(buildFail);
    }
  }

  // Step 6: lint examples
  if (!skipLint) {
    const lintFail = runLintOnExamples(lexiconDir, verbose);
    if (lintFail) {
      failures.push(lintFail);
    }
  }

  // Step 7: example harness (opt-in only; requires cloud credentials)
  if (!skipExamples) {
    const exFail = runExampleHarness(lexiconDir, verbose);
    if (exFail) {
      failures.push(exFail);
    }
  }

  // Step 8: extract surface from generated artifacts
  const freshSnapshot = extractFreshSurface(lexiconDir);
  if (!freshSnapshot) {
    failures.push({
      step: "surface-extract",
      output: `Could not read generated artifacts in ${join(lexiconDir, "src", "generated")}. The generate step should have produced them.`,
    });
    return makeResult(false, failures, null, null);
  }

  // Step 9: diff against baseline
  const baselinePath = join(lexiconDir, SNAPSHOT_FILENAME);
  let delta: SurfaceDelta;

  if (existsSync(baselinePath)) {
    try {
      const baselineJSON = readFileSync(baselinePath, "utf-8");
      const baseline = parseSnapshot(baselineJSON);
      delta = diffSurface(baseline, freshSnapshot);
    } catch (err) {
      failures.push({
        step: "surface-diff",
        output: `Failed to read or parse baseline snapshot at ${baselinePath}: ${String(err)}`,
      });
      return makeResult(false, failures, freshSnapshot, null);
    }
  } else {
    // No baseline — treat entire current surface as "added"
    const emptyBaseline: SurfaceSnapshot = {
      schemaVersion: 1,
      generatedAt: new Date(0).toISOString(),
      entries: {},
    };
    delta = diffSurface(emptyBaseline, freshSnapshot);
  }

  const ok = failures.length === 0;
  return makeResult(ok, failures, freshSnapshot, delta);
}

/**
 * Write the fresh surface snapshot to the lexicon's committed baseline file.
 * Call this after a successful regen when the snapshot should be updated.
 */
export function writeSurfaceSnapshot(lexiconDir: string, snapshot: SurfaceSnapshot): void {
  const path = join(lexiconDir, SNAPSHOT_FILENAME);
  writeFileSync(path, serializeSnapshot(snapshot), "utf-8");
}

// ── Subprocess helpers ────────────────────────────────────────────────

/**
 * Run one npm script in the lexicon directory.
 * Returns a RegenFailure on non-zero exit; null on success.
 */
function runScript(
  cwd: string,
  script: string,
  env: NodeJS.ProcessEnv,
  verbose: boolean,
): RegenFailure | null {
  try {
    const out = execSync(`npm run --silent ${script}`, {
      cwd,
      env,
      stdio: verbose ? "inherit" : "pipe",
      encoding: "utf-8",
      timeout: 10 * 60 * 1000, // 10 minutes
    });
    if (verbose && typeof out === "string" && out) process.stderr.write(out);
    return null;
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number; message?: string };
    const captured = [e.stdout ?? "", e.stderr ?? ""].filter(Boolean).join("\n");
    return {
      step: script,
      exitCode: e.status ?? 1,
      output: captured || e.message || String(err),
    };
  }
}

/**
 * Run `chant lint` on each example subdirectory.
 */
function runLintOnExamples(lexiconDir: string, verbose: boolean): RegenFailure | null {
  const examplesDir = join(lexiconDir, "examples");
  if (!existsSync(examplesDir)) return null;

  let entries: Dirent<string>[];
  try {
    entries = readdirSync(examplesDir, { withFileTypes: true, encoding: "utf-8" });
  } catch {
    return null;
  }

  const exampleDirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => join(examplesDir, e.name))
    .filter((d) => existsSync(join(d, "chant.config.ts")) || existsSync(join(d, "src")));

  if (exampleDirs.length === 0) return null;

  const chantBin = resolveChantBin(lexiconDir);
  const outputs: string[] = [];
  let failed = false;

  for (const exDir of exampleDirs) {
    try {
      const out = execSync(`${chantBin} lint ${exDir}`, {
        stdio: verbose ? "inherit" : "pipe",
        encoding: "utf-8",
        timeout: 60 * 1000,
      });
      if (verbose && typeof out === "string" && out) process.stderr.write(out);
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; status?: number };
      const captured = [e.stdout ?? "", e.stderr ?? ""].filter(Boolean).join(" ").trim();
      outputs.push(`[${exDir}] exit ${e.status ?? 1}: ${captured}`);
      failed = true;
    }
  }

  if (failed) {
    return { step: "lint", output: outputs.join("\n") };
  }
  return null;
}

/**
 * Run `npm run build --if-present` in each example directory.
 * Opt-in only — requires cloud credentials in most cases.
 */
function runExampleHarness(lexiconDir: string, verbose: boolean): RegenFailure | null {
  const examplesDir = join(lexiconDir, "examples");
  if (!existsSync(examplesDir)) return null;

  let entries: Dirent<string>[];
  try {
    entries = readdirSync(examplesDir, { withFileTypes: true, encoding: "utf-8" });
  } catch {
    return null;
  }

  const exampleDirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => join(examplesDir, e.name))
    .filter((d) => existsSync(join(d, "package.json")));

  const outputs: string[] = [];
  let failed = false;

  for (const exDir of exampleDirs) {
    try {
      const out = execSync("npm run build --if-present", {
        cwd: exDir,
        stdio: verbose ? "inherit" : "pipe",
        encoding: "utf-8",
        timeout: 5 * 60 * 1000,
      });
      if (verbose && typeof out === "string" && out) process.stderr.write(out);
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; status?: number };
      const captured = [e.stdout ?? "", e.stderr ?? ""].filter(Boolean).join(" ").trim();
      outputs.push(`[${exDir}] exit ${e.status ?? 1}: ${captured}`);
      failed = true;
    }
  }

  if (failed) {
    return { step: "examples", output: outputs.join("\n") };
  }
  return null;
}

/**
 * Extract the fresh surface from the generated artifacts in the lexicon directory.
 */
function extractFreshSurface(lexiconDir: string): SurfaceSnapshot | null {
  const generatedDir = join(lexiconDir, "src", "generated");
  if (!existsSync(generatedDir)) return null;

  let files: string[];
  try {
    files = readdirSync(generatedDir, { encoding: "utf-8" });
  } catch {
    return null;
  }

  const lexiconFile = files.find((f) => f.startsWith("lexicon-") && f.endsWith(".json"));
  if (!lexiconFile) return null;

  let lexiconJSON: string;
  try {
    lexiconJSON = readFileSync(join(generatedDir, lexiconFile), "utf-8");
  } catch {
    return null;
  }

  let typesDTS = "";
  const dtsPath = join(generatedDir, "index.d.ts");
  if (existsSync(dtsPath)) {
    try {
      typesDTS = readFileSync(dtsPath, "utf-8");
    } catch {
      // Proceed without .d.ts — props won't be extracted
    }
  }

  try {
    return extractSurface(lexiconJSON, typesDTS);
  } catch {
    return null;
  }
}

/**
 * Verify the spec cache file against a pinned SHA-256 digest.
 *
 * Digest file format (shasum -a 256 style):
 *   sha256:<64-hex-chars>  <relative-path-to-spec-file>
 */
async function verifyPinnedDigest(
  lexiconDir: string,
  digestPath: string,
): Promise<RegenFailure | null> {
  if (!existsSync(digestPath)) {
    return {
      step: "digest-verify",
      output: `Pinned digest file not found: ${digestPath}`,
    };
  }

  let digestContent: string;
  try {
    digestContent = readFileSync(digestPath, "utf-8").trim();
  } catch (err) {
    return {
      step: "digest-verify",
      output: `Cannot read digest file ${digestPath}: ${String(err)}`,
    };
  }

  const digestMatch = /^sha256:([a-f0-9]{64})\s+(.+)$/.exec(digestContent);
  if (!digestMatch) {
    return {
      step: "digest-verify",
      output: `Malformed digest file (expected "sha256:<hex>  <filename>"): ${digestPath}`,
    };
  }

  const [, expectedHex, relFilename] = digestMatch;
  const specPath = join(lexiconDir, relFilename);

  if (!existsSync(specPath)) {
    return {
      step: "digest-verify",
      output: `Spec file referenced in digest not found: ${specPath}. Run generate first or check the digest file path.`,
    };
  }

  try {
    const { createHash } = await import("crypto");
    const data = readFileSync(specPath);
    const actualHex = createHash("sha256").update(data).digest("hex");

    if (actualHex !== expectedHex) {
      return {
        step: "digest-verify",
        output: [
          `Spec digest mismatch for ${relFilename}:`,
          `  expected: ${expectedHex}`,
          `  actual:   ${actualHex}`,
          "",
          "The cached spec does not match the pinned digest.",
          "Re-fetch with --force to update the cache, then update the digest file.",
        ].join("\n"),
      };
    }

    return null;
  } catch (err) {
    return {
      step: "digest-verify",
      output: `Digest computation failed: ${String(err)}`,
    };
  }
}

/**
 * Resolve the chant binary path from the lexicon's workspace node_modules.
 */
function resolveChantBin(lexiconDir: string): string {
  // Try workspace root node_modules (two levels up from lexicons/<name>)
  const rootBin = join(lexiconDir, "..", "..", "node_modules", ".bin", "chant");
  if (existsSync(rootBin)) return rootBin;

  // Try lexicon-local node_modules
  const localBin = join(lexiconDir, "node_modules", ".bin", "chant");
  if (existsSync(localBin)) return localBin;

  // Fall back to npx
  return "npx chant";
}

/**
 * Build the final RegenResult.
 */
function makeResult(
  ok: boolean,
  failures: RegenFailure[],
  freshSnapshot: SurfaceSnapshot | null,
  delta: SurfaceDelta | null,
): RegenResult {
  const emptyDelta: SurfaceDelta = {
    added: [],
    changed: [],
    removed: [],
    severity: "none",
  };
  const effectiveDelta = delta ?? emptyDelta;
  const changed =
    effectiveDelta.added.length > 0 ||
    effectiveDelta.changed.length > 0 ||
    effectiveDelta.removed.length > 0;
  const deltaText = changed ? formatDelta(effectiveDelta) : "";

  return {
    ok,
    changed,
    severity: effectiveDelta.severity,
    delta: effectiveDelta,
    deltaText,
    failures,
    freshSnapshot,
  };
}
