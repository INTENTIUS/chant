import type { LintRule, LintDiagnostic, LintContext } from "./rule";
import { parseFile } from "./parser";
import { readFileSync } from "fs";

/**
 * Result of a lint run, separating active diagnostics from suppressed ones.
 */
export interface LintRunResult {
  /** Diagnostics that were not suppressed by disable directives */
  diagnostics: LintDiagnostic[];
  /** Diagnostics that were suppressed by disable directives, with optional reason */
  suppressed: Array<LintDiagnostic & { reason?: string }>;
}

/**
 * Represents a disable directive found in source code comments
 */
interface DisableDirective {
  /** Line number where the directive appears (1-based) */
  line: number;
  /** Type of directive */
  type: "file" | "line" | "next-line";
  /** Specific rule IDs to disable, or undefined for all rules */
  ruleIds?: string[];
  /** Optional reason for the suppression (text after ` -- `) */
  reason?: string;
}

/**
 * Parse disable comments from source code
 * Supports:
 * - // chant-disable - disable all rules for entire file
 * - // chant-disable-line - disable all rules for current line
 * - // chant-disable-next-line - disable all rules for next line
 * - // chant-disable rule-id1 rule-id2 - disable specific rules for file
 * - // chant-disable-line rule-id1 - disable specific rules for line
 * - // chant-disable-next-line rule-id1 - disable specific rules for next line
 */
/**
 * Parse the text after a directive keyword, splitting rule IDs from an optional reason.
 * Reason is separated by ` -- ` (first occurrence only).
 * Trailing `--` with no text is treated as no reason.
 */
function parseDirectiveText(afterDirective: string | undefined): {
  ruleIds?: string[];
  reason?: string;
} {
  if (!afterDirective) return {};

  const trimmed = afterDirective.trim();
  if (!trimmed) return {};

  // Handle `-- reason` at the start (no rule IDs, just reason)
  if (trimmed.startsWith("-- ")) {
    const reasonPart = trimmed.slice(3).trim();
    return { reason: reasonPart || undefined };
  }

  // Handle bare `--` (no rule IDs, no reason)
  if (trimmed === "--") {
    return {};
  }

  // Handle `RULE_ID -- reason` (rule IDs + reason separated by ` -- `)
  const dashIdx = trimmed.indexOf(" -- ");
  if (dashIdx >= 0) {
    const idsPart = trimmed.slice(0, dashIdx).trim();
    const reasonPart = trimmed.slice(dashIdx + 4).trim();
    const ruleIds = idsPart ? idsPart.split(/\s+/).filter(Boolean) : undefined;
    const reason = reasonPart || undefined;
    return {
      ruleIds: ruleIds && ruleIds.length > 0 ? ruleIds : undefined,
      reason,
    };
  }

  // Handle trailing ` --` with no reason text
  if (trimmed.endsWith(" --")) {
    const idsPart = trimmed.slice(0, -3).trim();
    const ruleIds = idsPart ? idsPart.split(/\s+/).filter(Boolean) : undefined;
    return {
      ruleIds: ruleIds && ruleIds.length > 0 ? ruleIds : undefined,
    };
  }

  // No `--` at all — just rule IDs
  const ruleIds = trimmed.split(/\s+/).filter(Boolean);
  return {
    ruleIds: ruleIds.length > 0 ? ruleIds : undefined,
  };
}

function parseDisableComments(content: string): DisableDirective[] {
  const directives: DisableDirective[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;

    // Match disable comments
    const disableFileMatch = line.match(/\/\/\s*chant-disable(?:\s+(.+))?$/);
    const disableLineMatch = line.match(/\/\/\s*chant-disable-line(?:\s+(.+))?$/);
    const disableNextLineMatch = line.match(/\/\/\s*chant-disable-next-line(?:\s+(.+))?$/);

    if (disableNextLineMatch) {
      const { ruleIds, reason } = parseDirectiveText(disableNextLineMatch[1]);
      directives.push({
        line: lineNumber + 1, // Next line
        type: "next-line",
        ruleIds,
        reason,
      });
    } else if (disableLineMatch) {
      const { ruleIds, reason } = parseDirectiveText(disableLineMatch[1]);
      directives.push({
        line: lineNumber,
        type: "line",
        ruleIds,
        reason,
      });
    } else if (disableFileMatch) {
      const { ruleIds, reason } = parseDirectiveText(disableFileMatch[1]);
      directives.push({
        line: lineNumber,
        type: "file",
        ruleIds,
        reason,
      });
    }
  }

  return directives;
}

/**
 * Check if a diagnostic should be suppressed based on disable directives.
 * Returns suppression info if suppressed, or null if not suppressed.
 */
function isDiagnosticDisabled(
  diagnostic: LintDiagnostic,
  directives: DisableDirective[],
  allRuleIds: Set<string>
): { suppressed: boolean; reason?: string } {
  // Check for file-level disables
  const fileDisables = directives.filter((d) => d.type === "file");
  for (const directive of fileDisables) {
    if (!directive.ruleIds) {
      // Disable all rules
      return { suppressed: true, reason: directive.reason };
    }
    // Check if rule ID exists before checking if it's disabled
    if (directive.ruleIds.some((id) => allRuleIds.has(id))) {
      if (directive.ruleIds.includes(diagnostic.ruleId)) {
        return { suppressed: true, reason: directive.reason };
      }
    }
    // Silently ignore non-existent rule IDs
  }

  // Check for line-specific disables
  const lineDisables = directives.filter(
    (d) => (d.type === "line" || d.type === "next-line") && d.line === diagnostic.line
  );
  for (const directive of lineDisables) {
    if (!directive.ruleIds) {
      // Disable all rules
      return { suppressed: true, reason: directive.reason };
    }
    // Check if rule ID exists before checking if it's disabled
    if (directive.ruleIds.some((id) => allRuleIds.has(id))) {
      if (directive.ruleIds.includes(diagnostic.ruleId)) {
        return { suppressed: true, reason: directive.reason };
      }
    }
    // Silently ignore non-existent rule IDs
  }

  return { suppressed: false };
}

/**
 * Execute lint rules on a set of files
 * @param files - Array of file paths to lint
 * @param rules - Array of lint rules to execute
 * @param ruleOptions - Optional map of rule ID to options object
 * @returns LintRunResult with diagnostics and suppressed items
 */
export async function runLint(
  files: string[],
  rules: LintRule[],
  ruleOptions?: Map<string, Record<string, unknown>>,
): Promise<LintRunResult> {
  const allDiagnostics: LintDiagnostic[] = [];
  const allSuppressed: Array<LintDiagnostic & { reason?: string }> = [];
  const allRuleIds = new Set(rules.map((r) => r.id));

  for (const filePath of files) {
    try {
      // Parse the file
      const sourceFile = parseFile(filePath);

      // Read file content for disable comment parsing
      const content = readFileSync(filePath, "utf-8");
      const directives = parseDisableComments(content);

      // Create lint context
      const context: LintContext = {
        sourceFile,
        entities: [],
        filePath,
        lexicon: undefined,
      };

      // Execute each rule
      for (const rule of rules) {
        const options = ruleOptions?.get(rule.id);
        const diagnostics = rule.check(context, options);
        allDiagnostics.push(...diagnostics);
      }

      // Partition file diagnostics into active and suppressed
      const fileDiags = allDiagnostics.filter((d) => d.file === filePath);
      const otherFileDiags = allDiagnostics.filter((d) => d.file !== filePath);

      const keptDiags: LintDiagnostic[] = [];
      for (const diagnostic of fileDiags) {
        const result = isDiagnosticDisabled(diagnostic, directives, allRuleIds);
        if (result.suppressed) {
          allSuppressed.push({ ...diagnostic, reason: result.reason });
        } else {
          keptDiags.push(diagnostic);
        }
      }

      // Replace file diagnostics with filtered ones
      allDiagnostics.length = 0;
      allDiagnostics.push(...otherFileDiags, ...keptDiags);
    } catch (error) {
      // If parsing fails, skip this file and continue with others
      continue;
    }
  }

  return { diagnostics: allDiagnostics, suppressed: allSuppressed };
}
