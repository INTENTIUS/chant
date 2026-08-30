import type * as ts from "typescript";
import type { IntrinsicDef } from "../lexicon";

/**
 * Severity level for lint diagnostics
 */
export type Severity = "error" | "warning" | "info";

/**
 * Category for grouping related lint rules
 */
export type Category = "correctness" | "style" | "performance" | "security";

/**
 * A fix that can be applied to source code
 */
export interface LintFix {
  /** [start, end] positions in the source file */
  range: [number, number];
  /** Text to replace the range with */
  replacement: string;
  /** Kind of fix operation */
  kind?: "replace" | "insert-before" | "insert-after" | "delete" | "write-file";
  /** Additional parameters for the fix */
  params?: Record<string, unknown>;
}

/**
 * A diagnostic message from a lint rule
 */
export interface LintDiagnostic {
  /** File path where the issue was found */
  file: string;
  /** Line number (1-based) */
  line: number;
  /** Column number (1-based) */
  column: number;
  /** End line number (1-based), when the diagnostic spans a range */
  endLine?: number;
  /** End column number (1-based), when the diagnostic spans a range */
  endColumn?: number;
  /** ID of the rule that produced this diagnostic */
  ruleId: string;
  /** Severity level */
  severity: Severity;
  /** Human-readable message */
  message: string;
  /** Optional fix that can be applied */
  fix?: LintFix;
}

/**
 * The slice of the project's `chant.config` a config-aware rule reads
 * (#1221) — threaded into {@link LintContext} by `runLint` when the caller
 * resolved the project's config (`chant lint` does; a bare unit test or the
 * LSP's single-file lint may not). Structurally mirrors the corresponding
 * `ChantConfig` fields (../config.ts) without importing them, so `rule.ts`
 * stays dependency-light for lexicon rule authors.
 */
export interface LintProjectConfig {
  /** Declared environments — a bare name or `{ name, endpoint }` (#1166). */
  environments?: Array<string | { name: string; endpoint?: string }>;
  /** Ownership marking config — `env` is a literal or a build-parameter reference (#1396). */
  ownership?: { stack?: string; env?: string | { param: string }; enabled?: boolean };
}

/**
 * Context provided to lint rules during checking
 */
export interface LintContext {
  /** Parsed TypeScript source file */
  sourceFile: ts.SourceFile;
  /** Discovered entities in the file */
  entities: unknown[];
  /** Path to the file being linted */
  filePath: string;
  /** Optional lexicon context (undefined for core rules) */
  lexicon?: string;
  /**
   * chant #1106 — the active lexicons' registered intrinsics (`Ref`,
   * `GetAtt`, ...), threaded down from `runLint` (../lint/engine.ts) so a
   * rule built on the shared `../fold/subset.ts` predicate
   * (`findSubsetViolation`/`checkObjectMember`, used by EVL001) gets the
   * SAME answer `fold()` does for a registered, opted-in call. Mirrors how
   * `discover()` has threaded `IntrinsicDef[]` into the fold path since
   * #1039/#1105. Undefined when the caller hasn't resolved a project's
   * lexicons (a bare unit test constructing a `LintContext` directly, for
   * instance) — subset.ts then falls back to its pre-#1044 answer: every
   * call is a violation.
   */
  intrinsics?: readonly IntrinsicDef[];
  /**
   * chant #1221 — the project's resolved config slice for config-aware rules
   * (COR021 reads `environments` + `ownership`). Threaded from `runLint`;
   * undefined when the caller never loaded a project config (a unit test
   * constructing a context directly, the LSP's single-file path), in which
   * case config-aware rules stay silent.
   */
  projectConfig?: LintProjectConfig;
}

/**
 * Configuration value for a rule: either a severity string or a [severity, options] tuple
 */
export type RuleConfig = Severity | "off" | [Severity | "off", Record<string, unknown>];

/**
 * A lint rule that can check code and optionally provide fixes
 */
export interface LintRule {
  /** Unique identifier for this rule */
  id: string;
  /** Severity level for diagnostics from this rule */
  severity: Severity;
  /** Category for grouping */
  category: Category;
  /** Human-readable description of what this rule checks */
  description?: string;
  /** Link to rule documentation */
  helpUri?: string;
  /** Check the code and return diagnostics */
  check(context: LintContext, options?: Record<string, unknown>): LintDiagnostic[];
  /** Optionally provide fixes for issues found */
  fix?(context: LintContext): LintFix[];
}
