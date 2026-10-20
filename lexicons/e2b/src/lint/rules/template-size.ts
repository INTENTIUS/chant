import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import { at, numberLiteral, property, templateLiterals } from "./template-literal";

/**
 * E2B001: A template's CPU and memory are sizes E2B accepts.
 *
 * `cpuCount` is a whole number of vCPUs, at least one. `memoryMB` is a whole
 * number of MiB, at least one and even: `e2b template build` refuses an odd
 * one. Both are only checked when written as literals.
 */
export const templateSizeRule: LintRule = {
  id: "E2B001",
  severity: "error",
  category: "correctness",
  description: "A Template's cpuCount must be a positive integer and its memoryMB a positive even integer",

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];
    for (const obj of templateLiterals(sourceFile)) {
      const cpu = property(obj, "cpuCount", sourceFile);
      const cpuValue = cpu ? numberLiteral(cpu) : undefined;
      if (cpu && cpuValue !== undefined && !(Number.isInteger(cpuValue) && cpuValue >= 1)) {
        diagnostics.push(at(sourceFile, cpu, "E2B001", "error", `cpuCount ${cpuValue} is not a whole number of vCPUs; use 1 or more.`));
      }
      const mem = property(obj, "memoryMB", sourceFile);
      const memValue = mem ? numberLiteral(mem) : undefined;
      if (mem && memValue !== undefined && !(Number.isInteger(memValue) && memValue >= 2 && memValue % 2 === 0)) {
        diagnostics.push(
          at(sourceFile, mem, "E2B001", "error", `memoryMB ${memValue} is not a positive even number of MiB, which E2B requires.`),
        );
      }
    }
    return diagnostics;
  },
};
