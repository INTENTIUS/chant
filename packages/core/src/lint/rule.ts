import type * as ts from "typescript";

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
  /** Check the code and return diagnostics */
  check(context: LintContext, options?: Record<string, unknown>): LintDiagnostic[];
  /** Optionally provide fixes for issues found */
  fix?(context: LintContext): LintFix[];
}
