import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import * as ts from "typescript";

/**
 * AZR001: Hardcoded Azure Location
 *
 * Detects hardcoded Azure location strings in code.
 * Locations should use Azure.ResourceGroupLocation pseudo-parameter instead.
 */
export const hardcodedLocationRule: LintRule = {
  id: "AZR001",
  severity: "warning",
  category: "correctness",
  description: "Detects hardcoded Azure location strings — use Azure.ResourceGroupLocation instead",

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];

    // Common Azure location strings (case-insensitive match)
    const azureLocations = new Set([
      "eastus",
      "eastus2",
      "westus",
      "westus2",
      "westus3",
      "centralus",
      "northcentralus",
      "southcentralus",
      "westcentralus",
      "canadacentral",
      "canadaeast",
      "brazilsouth",
      "northeurope",
      "westeurope",
      "uksouth",
      "ukwest",
      "francecentral",
      "francesouth",
      "switzerlandnorth",
      "switzerlandwest",
      "germanywestcentral",
      "norwayeast",
      "norwaywest",
      "swedencentral",
      "eastasia",
      "southeastasia",
      "japaneast",
      "japanwest",
      "australiaeast",
      "australiasoutheast",
      "australiacentral",
      "koreacentral",
      "koreasouth",
      "southafricanorth",
      "southafricawest",
      "uaenorth",
      "uaecentral",
      "centralindia",
      "southindia",
      "westindia",
      "qatarcentral",
      "polandcentral",
      "italynorth",
    ]);

    function visit(node: ts.Node): void {
      if (ts.isStringLiteral(node)) {
        const value = node.text.toLowerCase();
        if (azureLocations.has(value)) {
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          diagnostics.push({
            file: sourceFile.fileName,
            line: line + 1,
            column: character + 1,
            ruleId: "AZR001",
            severity: "warning",
            message: `Hardcoded location "${node.text}" detected. Use Azure.ResourceGroupLocation instead.`,
          });
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return diagnostics;
  },
};
