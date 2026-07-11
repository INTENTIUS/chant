import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import * as ts from "typescript";

/**
 * Known Fly.io region codes.
 *
 * Sourced from the representative region list mudflaps serves at
 * `GET /v1/platform/regions` (mudflaps `internal/server/regions.go`), which
 * mirrors fly-go's `GetRegions` wire shape. The generated Fly types (#737)
 * type `region` as a plain `string`, so there is no generated enum to import;
 * this static set is the closest stable list a unit test can check without a
 * live platform. It is representative, not exhaustive — add codes as Fly adds
 * regions.
 */
const KNOWN_REGIONS = new Set<string>([
  "ams", "atl", "bog", "bos", "cdg", "den", "dfw", "ewr", "fra", "gru",
  "hkg", "iad", "jnb", "lax", "lhr", "mad", "mia", "nrt", "ord", "scl",
  "sea", "sin", "sjc", "syd", "yyz",
]);

/**
 * FLY001: Valid Fly region
 *
 * A machine (or volume/IP) `region` must be a known Fly region code. An unknown
 * region is rejected at apply time; catch it at build with a clearer message.
 */
export const validRegionRule: LintRule = {
  id: "FLY001",
  severity: "error",
  category: "correctness",
  description: "A region must be a known Fly region code",

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];

    function visit(node: ts.Node): void {
      if (ts.isPropertyAssignment(node) && node.name.getText(sourceFile) === "region") {
        const init = node.initializer;
        if (ts.isStringLiteral(init) && init.text.length > 0 && !KNOWN_REGIONS.has(init.text)) {
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(init.getStart(sourceFile));
          diagnostics.push({
            file: sourceFile.fileName,
            line: line + 1,
            column: character + 1,
            ruleId: "FLY001",
            severity: "error",
            message: `Unknown Fly region "${init.text}". Use a known region code, e.g. iad, lhr, sjc, fra, syd.`,
          });
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return diagnostics;
  },
};
