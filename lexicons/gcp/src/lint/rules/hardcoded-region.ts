import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import * as ts from "typescript";

/**
 * WGC002: Hardcoded GCP Region/Zone
 *
 * Detects hardcoded GCP region and zone strings in code.
 * Regions/zones should use GCP.Region or GCP.Zone pseudo-parameters instead.
 */
export const hardcodedRegionRule: LintRule = {
  id: "WGC002",
  severity: "warning",
  category: "security",
  description: "Detects hardcoded GCP region/zone strings — use GCP.Region/GCP.Zone pseudo-parameters instead",

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];

    // GCP region pattern: continent-direction[N] (e.g., us-central1, europe-west4)
    const regionPattern = /^(us|europe|asia|australia|southamerica|northamerica|me|africa)-(central|east|west|south|north|northeast|southeast|southwest|northwest)\d+$/;
    // GCP zone pattern: region-[a-f] (e.g., us-central1-a)
    const zonePattern = /^(us|europe|asia|australia|southamerica|northamerica|me|africa)-(central|east|west|south|north|northeast|southeast|southwest|northwest)\d+-[a-f]$/;

    function visit(node: ts.Node): void {
      if (ts.isStringLiteral(node)) {
        const value = node.text;
        if (zonePattern.test(value)) {
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          diagnostics.push({
            file: sourceFile.fileName,
            line: line + 1,
            column: character + 1,
            ruleId: "WGC002",
            severity: "warning",
            message: `Hardcoded zone "${value}" detected. Use GCP.Zone pseudo-parameter instead.`,
          });
        } else if (regionPattern.test(value)) {
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          diagnostics.push({
            file: sourceFile.fileName,
            line: line + 1,
            column: character + 1,
            ruleId: "WGC002",
            severity: "warning",
            message: `Hardcoded region "${value}" detected. Use GCP.Region pseudo-parameter instead.`,
          });
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return diagnostics;
  },
};
