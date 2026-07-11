import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import * as ts from "typescript";

/**
 * Fly guest presets, per `cpu_kind`.
 *
 * `cpus` is the set of valid CPU counts; `memory_mb` must be a multiple of 256
 * within [minPerCpu * cpus, maxPerCpu * cpus]. Values mirror Fly's published
 * guest presets (shared-cpu-Nx / performance-Nx): shared allows 256–2048 MB per
 * CPU, performance allows 2048–8192 MB per CPU. The 256 MB step is the loosest
 * safe multiple, so a valid config is never flagged; only clearly-invalid combos
 * are. fly-go was not vendored in this tree to cross-check against, so this table
 * is a documented representative set (a limitation, widen if Fly changes presets).
 */
const GUEST_PRESETS: Record<string, { cpus: Set<number>; minPerCpu: number; maxPerCpu: number }> = {
  shared: { cpus: new Set([1, 2, 4, 8]), minPerCpu: 256, maxPerCpu: 2048 },
  performance: { cpus: new Set([1, 2, 4, 8, 16]), minPerCpu: 2048, maxPerCpu: 8192 },
};

const MEMORY_STEP_MB = 256;

/** Read a numeric property from an object literal, if present as a plain number literal. */
function numberProp(obj: ts.ObjectLiteralExpression, key: string, sf: ts.SourceFile): number | undefined {
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) && prop.name.getText(sf) === key && ts.isNumericLiteral(prop.initializer)) {
      return Number(prop.initializer.text);
    }
  }
  return undefined;
}

/** Read a string property from an object literal, if present as a plain string literal. */
function stringProp(obj: ts.ObjectLiteralExpression, key: string, sf: ts.SourceFile): string | undefined {
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) && prop.name.getText(sf) === key && ts.isStringLiteral(prop.initializer)) {
      return prop.initializer.text;
    }
  }
  return undefined;
}

/**
 * FLY002: Sane guest sizing
 *
 * A guest's `cpu_kind`, `cpus`, and `memory_mb` must be a valid combination per
 * Fly's guest presets. An invalid combination is rejected at apply time.
 */
export const guestSizingRule: LintRule = {
  id: "FLY002",
  severity: "error",
  category: "correctness",
  description: "A guest's cpu_kind, cpus and memory_mb must be a valid Fly combination",

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];

    function report(node: ts.Node, message: string): void {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      diagnostics.push({
        file: sourceFile.fileName,
        line: line + 1,
        column: character + 1,
        ruleId: "FLY002",
        severity: "error",
        message,
      });
    }

    function visit(node: ts.Node): void {
      // A guest is any object literal carrying a cpu_kind property (new MachineGuest({...})
      // or an inline guest object).
      if (ts.isObjectLiteralExpression(node)) {
        const cpuKind = stringProp(node, "cpu_kind", sourceFile);
        if (cpuKind !== undefined) {
          const preset = GUEST_PRESETS[cpuKind];
          if (!preset) {
            report(node, `Invalid guest cpu_kind "${cpuKind}". Use "shared" or "performance".`);
          } else {
            const cpus = numberProp(node, "cpus", sourceFile);
            const memoryMb = numberProp(node, "memory_mb", sourceFile);
            if (cpus !== undefined && !preset.cpus.has(cpus)) {
              report(node, `Invalid guest sizing: cpu_kind "${cpuKind}" does not allow ${cpus} cpus (valid: ${[...preset.cpus].join(", ")}).`);
            } else if (cpus !== undefined && memoryMb !== undefined) {
              const min = preset.minPerCpu * cpus;
              const max = preset.maxPerCpu * cpus;
              if (memoryMb % MEMORY_STEP_MB !== 0 || memoryMb < min || memoryMb > max) {
                report(node, `Invalid guest sizing: ${cpuKind}/${cpus} cpu requires memory_mb between ${min} and ${max} in steps of ${MEMORY_STEP_MB}, got ${memoryMb}.`);
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return diagnostics;
  },
};
