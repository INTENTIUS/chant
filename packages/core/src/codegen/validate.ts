/**
 * Generic validation framework for lexicon artifacts.
 *
 * Provides configurable validation checks that any lexicon can use
 * by passing lexicon-specific configuration.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { computeCoverage, checkThresholds, type CoverageThresholds } from "./coverage";
import { extractSurface, diffSurface, parseSnapshot, formatDelta } from "./surface-snapshot";

export interface ValidateCheck {
  name: string;
  ok: boolean;
  error?: string;
}

export interface ValidateResult {
  success: boolean;
  checks: ValidateCheck[];
}

/**
 * Set by the publish workflow to arm the release-time surface gate
 * (chant #1473). Absent in ordinary CI, where upstream drift is expected.
 */
export const RELEASE_GATE_ENV = "CHANT_RELEASE_GATE";

export interface LexiconValidationConfig {
  /** Filename of the lexicon JSON (e.g. "lexicon-mydom.json") */
  lexiconJsonFilename: string;
  /** Required backward-compatible export names to check in lexicon JSON */
  requiredNames: string[];
  /**
   * When true, a required name is satisfied if it appears as a substring of any
   * lexicon JSON key (not only as an exact key). Lexicons that bound their
   * generated type expansion (e.g. azure, #438) emit shared types under
   * resource-prefixed/variant names, so the bare curated name is present only
   * as a substring. Defaults to false (exact-key match).
   */
  requiredNamesMatchSubstring?: boolean;
  /** Base path of the lexicon package */
  basePath: string;
  /**
   * chant #1473 — this lexicon's release is gated on the generated API
   * matching the committed `surface.snapshot.json`.
   *
   * Two conditions, both required. The lexicon opts in here, AND
   * {@link RELEASE_GATE_ENV} is set — which the publish workflow does and
   * ordinary CI does not.
   *
   * The env half is not caution, it is correctness. `validate` runs on every
   * PR, and the upstream a lexicon generates from can move at any time: the
   * CloudFormation archive republishes schemas several times a day, and some
   * of those edits do change the surface. A hard surface check on every PR
   * would turn any unrelated change red the moment upstream moved, which is
   * the same trap the spec pin fell into one level down. Drift between
   * releases is expected and is what the scheduled lexicon-upgrade job exists
   * to report (#1423).
   *
   * What must never happen is *publishing* a surface nobody reviewed. That is
   * a release-time property, so it is checked at release time.
   *
   * `"always"` drops the env half (#1475). It is for a lexicon whose upstream
   * is pinned to an immutable ref — k8s generates from a kubernetes release
   * tag plus vendored CRDs, azure from a commit sha of the
   * resource-manager-schemas repo — so a fresh `generate` on a PR is
   * deterministic and the only way the surface can move is a change in this
   * repo. For those, drift on a PR is exactly the thing to fail on: the CRD
   * batches #1319/#1320/#1321 left the k8s baseline 393 entries behind, and
   * the #1144 pin left azure 483 behind, because nothing compared the two
   * until a release was attempted. Never use `"always"` for a lexicon that
   * fetches a moving upstream.
   */
  checkSurfaceSnapshot?: boolean | "always";
  /** Environment to read {@link RELEASE_GATE_ENV} from. Defaults to `process.env`; overridden in tests. */
  env?: NodeJS.ProcessEnv;
  /** Path to the generated directory (defaults to basePath/src/generated) */
  generatedDir?: string;
  /** Coverage thresholds (optional) */
  coverageThresholds?: CoverageThresholds;
}

/**
 * Validate generated lexicon artifacts using the provided configuration.
 */
export async function validateLexiconArtifacts(config: LexiconValidationConfig): Promise<ValidateResult> {
  const generatedDir = config.generatedDir ?? join(config.basePath, "src", "generated");
  const checks: ValidateCheck[] = [];

  // Check 1: lexicon JSON exists and parses
  const lexiconPath = join(generatedDir, config.lexiconJsonFilename);
  let lexiconData: Record<string, unknown> | null = null;

  if (!existsSync(lexiconPath)) {
    checks.push({ name: "lexicon-json-exists", ok: false, error: `${config.lexiconJsonFilename} not found` });
  } else {
    try {
      const raw = readFileSync(lexiconPath, "utf-8");
      lexiconData = JSON.parse(raw);
      checks.push({ name: "lexicon-json-exists", ok: true });
    } catch (err) {
      checks.push({
        name: "lexicon-json-exists",
        ok: false,
        error: `Failed to parse ${config.lexiconJsonFilename}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // Check 2: index.d.ts exists
  const dtsPath = join(generatedDir, "index.d.ts");
  if (!existsSync(dtsPath)) {
    checks.push({ name: "types-exist", ok: false, error: "index.d.ts not found" });
  } else {
    checks.push({ name: "types-exist", ok: true });
  }

  // Check 3: Required backward-compatible names present in lexicon JSON
  if (lexiconData && config.requiredNames.length > 0) {
    const keys = Object.keys(lexiconData);
    const present = config.requiredNamesMatchSubstring
      ? (name: string) => keys.some((k) => k.includes(name))
      : (name: string) => name in lexiconData!;
    const missing = config.requiredNames.filter((name) => !present(name));
    if (missing.length > 0) {
      checks.push({
        name: "required-names",
        ok: false,
        error: `Missing required names: ${missing.join(", ")}`,
      });
    } else {
      checks.push({ name: "required-names", ok: true });
    }
  } else if (!lexiconData && config.requiredNames.length > 0) {
    checks.push({
      name: "required-names",
      ok: false,
      error: "Skipped — lexicon JSON not available",
    });
  }

  // Check 4: Coverage thresholds (only if lexicon JSON was loaded)
  if (lexiconData && config.coverageThresholds) {
    try {
      const raw = readFileSync(lexiconPath, "utf-8");
      const report = computeCoverage(raw);
      const result = checkThresholds(report, config.coverageThresholds);
      if (result.ok) {
        checks.push({ name: "coverage-thresholds", ok: true });
      } else {
        checks.push({
          name: "coverage-thresholds",
          ok: false,
          error: result.violations.join("; "),
        });
      }
    } catch (err) {
      checks.push({
        name: "coverage-thresholds",
        ok: false,
        error: `Coverage check failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // Check 5: Type-check generated .d.ts
  if (existsSync(dtsPath)) {
    try {
      const { typecheckDTS } = await import("./typecheck");
      const dtsContent = readFileSync(dtsPath, "utf-8");
      const tcResult = await typecheckDTS(dtsContent);
      if (tcResult.ok) {
        checks.push({ name: "types-compile", ok: true });
      } else {
        checks.push({
          name: "types-compile",
          ok: false,
          error: `TypeScript errors: ${tcResult.diagnostics.slice(0, 5).join("; ")}`,
        });
      }
    } catch (err) {
      checks.push({
        name: "types-compile",
        ok: false,
        error: `Type-check failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // Check: the generated API matches the reviewed one (chant #1473).
  //
  // This is the gate that makes a release trustworthy. `prepack` regenerates
  // from upstream, and for aws that upstream republishes schemas several times
  // a day, so the input can differ from the one whose delta a human accepted.
  // What must not differ is the API that ships. Comparing the just-generated
  // artifacts against the committed `surface.snapshot.json` says exactly that,
  // and says nothing about byte churn that changed no declaration.
  //
  // Runs on the artifacts already on disk — no second generation — and is
  // skipped for a lexicon with no committed snapshot, which is the case for a
  // new lexicon before its first baseline.
  const snapshotPath = join(config.basePath, "surface.snapshot.json");
  const surfaceGate =
    config.checkSurfaceSnapshot === "always" ||
    (config.checkSurfaceSnapshot === true && (config.env ?? process.env)[RELEASE_GATE_ENV] === "1");
  if (surfaceGate && lexiconData && existsSync(snapshotPath) && existsSync(dtsPath)) {
    try {
      const fresh = extractSurface(readFileSync(lexiconPath, "utf-8"), readFileSync(dtsPath, "utf-8"));
      const delta = diffSurface(parseSnapshot(readFileSync(snapshotPath, "utf-8")), fresh);
      const moved = delta.added.length + delta.removed.length + delta.renamed.length + delta.changed.length;
      checks.push(
        moved === 0
          ? { name: "surface-matches-snapshot", ok: true }
          : {
              name: "surface-matches-snapshot",
              ok: false,
              error:
                `The generated API differs from the reviewed surface.snapshot.json ` +
                `(${delta.added.length} added, ${delta.removed.length} removed, ${delta.renamed.length} renamed, ${delta.changed.length} changed). ` +
                `Accept it deliberately with \`chant dev surface-diff <lexicon> --update-snapshot --bump\`, ` +
                `never as a side effect of a release.\n${formatDelta(delta)}`,
            },
      );
    } catch (err) {
      checks.push({
        name: "surface-matches-snapshot",
        ok: false,
        error: `Failed to compare against surface.snapshot.json: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return {
    success: checks.every((c) => c.ok),
    checks,
  };
}

/**
 * Print validation results to stderr and throw on failure.
 */
export function printValidationResult(result: ValidateResult): void {
  for (const check of result.checks) {
    const status = check.ok ? "OK" : "FAIL";
    const msg = check.error ? ` — ${check.error}` : "";
    console.error(`  [${status}] ${check.name}${msg}`);
  }

  if (!result.success) {
    throw new Error("Validation failed");
  }
  console.error("All validation checks passed.");
}
