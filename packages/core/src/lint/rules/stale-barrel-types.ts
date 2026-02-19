import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { LintRule, LintContext, LintDiagnostic } from "../rule";
import { generateBarrelTypes } from "../../project/sync";

/**
 * COR016: stale-barrel-types
 *
 * Checks that `_.d.ts` barrel type declarations are up-to-date with
 * the current project scan. Fires only on `_.ts` barrel files.
 *
 * When --fix is used, the fix writes the expected content to `_.d.ts`.
 */
export const staleBarrelTypesRule: LintRule = {
  id: "COR016",
  severity: "warning",
  category: "correctness",
  check(context: LintContext): LintDiagnostic[] {
    // Only fire on _.ts barrel files
    if (!context.filePath.endsWith("/_.ts") && context.filePath !== "_.ts") {
      return [];
    }

    // Requires projectScan
    if (!context.projectScan) return [];

    const expected = generateBarrelTypes(context.projectScan);
    const dtsPath = join(dirname(context.filePath), "_.d.ts");

    let existing: string | undefined;
    try {
      existing = readFileSync(dtsPath, "utf-8");
    } catch {
      // File doesn't exist
    }

    if (existing === expected) return [];

    const message = existing === undefined
      ? "Missing _.d.ts barrel type declarations. Run 'chant lint --fix' to generate."
      : "Stale _.d.ts barrel type declarations. Run 'chant lint --fix' to regenerate.";

    return [
      {
        file: context.filePath,
        line: 1,
        column: 1,
        ruleId: "COR016",
        severity: "warning",
        message,
        fix: {
          range: [0, 0],
          replacement: "",
          kind: "write-file",
          params: { path: dtsPath, content: expected },
        },
      },
    ];
  },
};
