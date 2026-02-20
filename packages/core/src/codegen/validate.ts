/**
 * Generic validation framework for lexicon artifacts.
 *
 * Provides configurable validation checks that any lexicon can use
 * by passing lexicon-specific configuration.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { computeCoverage, checkThresholds, type CoverageThresholds } from "./coverage";

export interface ValidateCheck {
  name: string;
  ok: boolean;
  error?: string;
}

export interface ValidateResult {
  success: boolean;
  checks: ValidateCheck[];
}

export interface LexiconValidationConfig {
  /** Filename of the lexicon JSON (e.g. "lexicon-mydom.json") */
  lexiconJsonFilename: string;
  /** Required backward-compatible export names to check in lexicon JSON */
  requiredNames: string[];
  /** Base path of the lexicon package */
  basePath: string;
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
    const missing = config.requiredNames.filter((name) => !(name in lexiconData!));
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
