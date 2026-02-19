import type { LintRule, LintDiagnostic, LintContext, LintRunOptions } from "./rule";
import { parseFile } from "./parser";
import { readFileSync } from "fs";

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
      const ruleIds = disableNextLineMatch[1]?.trim().split(/\s+/).filter(Boolean);
      directives.push({
        line: lineNumber + 1, // Next line
        type: "next-line",
        ruleIds: ruleIds && ruleIds.length > 0 ? ruleIds : undefined,
      });
    } else if (disableLineMatch) {
      const ruleIds = disableLineMatch[1]?.trim().split(/\s+/).filter(Boolean);
      directives.push({
        line: lineNumber,
        type: "line",
        ruleIds: ruleIds && ruleIds.length > 0 ? ruleIds : undefined,
      });
    } else if (disableFileMatch) {
      const ruleIds = disableFileMatch[1]?.trim().split(/\s+/).filter(Boolean);
      directives.push({
        line: lineNumber,
        type: "file",
        ruleIds: ruleIds && ruleIds.length > 0 ? ruleIds : undefined,
      });
    }
  }

  return directives;
}

/**
 * Check if a diagnostic should be suppressed based on disable directives
 */
function isDiagnosticDisabled(
  diagnostic: LintDiagnostic,
  directives: DisableDirective[],
  allRuleIds: Set<string>
): boolean {
  // Check for file-level disables
  const fileDisables = directives.filter((d) => d.type === "file");
  for (const directive of fileDisables) {
    if (!directive.ruleIds) {
      // Disable all rules
      return true;
    }
    // Check if rule ID exists before checking if it's disabled
    if (directive.ruleIds.some((id) => allRuleIds.has(id))) {
      if (directive.ruleIds.includes(diagnostic.ruleId)) {
        return true;
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
      return true;
    }
    // Check if rule ID exists before checking if it's disabled
    if (directive.ruleIds.some((id) => allRuleIds.has(id))) {
      if (directive.ruleIds.includes(diagnostic.ruleId)) {
        return true;
      }
    }
    // Silently ignore non-existent rule IDs
  }

  return false;
}

/**
 * Execute lint rules on a set of files
 * @param files - Array of file paths to lint
 * @param rules - Array of lint rules to execute
 * @param ruleOptions - Optional map of rule ID to options object
 * @returns Array of diagnostics from all rules and files, with disable comments applied
 */
export async function runLint(
  files: string[],
  rules: LintRule[],
  ruleOptions?: Map<string, Record<string, unknown>>,
  runOptions?: LintRunOptions,
): Promise<LintDiagnostic[]> {
  const allDiagnostics: LintDiagnostic[] = [];
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
        barrelExports: runOptions?.barrelExports,
        projectExports: runOptions?.projectExports,
        projectScan: runOptions?.projectScan,
      };

      // Execute each rule
      for (const rule of rules) {
        const options = ruleOptions?.get(rule.id);
        const diagnostics = rule.check(context, options);
        allDiagnostics.push(...diagnostics);
      }

      // Filter out disabled diagnostics for this file
      const filteredDiagnostics = allDiagnostics.filter(
        (diagnostic) => diagnostic.file === filePath && !isDiagnosticDisabled(diagnostic, directives, allRuleIds)
      );

      // Replace file diagnostics with filtered ones
      const otherFileDiagnostics = allDiagnostics.filter((d) => d.file !== filePath);
      allDiagnostics.length = 0;
      allDiagnostics.push(...otherFileDiagnostics, ...filteredDiagnostics);
    } catch (error) {
      // If parsing fails, skip this file and continue with others
      // In a real implementation, you might want to collect these errors
      continue;
    }
  }

  return allDiagnostics;
}
