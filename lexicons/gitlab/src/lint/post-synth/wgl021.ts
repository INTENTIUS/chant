/**
 * WGL021: Unused Variables
 *
 * Detects global `variables:` that are not referenced by any job script.
 * Unused variables add noise and may indicate stale configuration.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractGlobalVariables } from "./yaml-helpers";

export function checkUnusedVariables(yaml: string): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  const globalVars = extractGlobalVariables(yaml);
  if (globalVars.size === 0) return diagnostics;

  // Get the rest of the YAML (everything after the global variables block)
  // to search for references
  for (const [varName] of globalVars) {
    // Check if $VARNAME or ${VARNAME} appears anywhere in the YAML (outside the variables block)
    const refPattern = new RegExp(`\\$\\{?${varName}\\}?`);
    // Also check for uses in extends, needs, etc. — search all sections
    const sections = yaml.split("\n\n");
    let found = false;

    for (const section of sections) {
      // Skip the global variables section itself
      if (section.trimStart().startsWith("variables:")) continue;

      if (refPattern.test(section)) {
        found = true;
        break;
      }
    }

    if (!found) {
      diagnostics.push({
        checkId: "WGL021",
        severity: "warning",
        message: `Global variable "${varName}" is not referenced in any job script`,
        entity: varName,
        lexicon: "gitlab",
      });
    }
  }

  return diagnostics;
}

export const wgl021: PostSynthCheck = {
  id: "WGL021",
  description: "Unused variables — global variables not referenced by any job",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      diagnostics.push(...checkUnusedVariables(yaml));
    }
    return diagnostics;
  },
};
