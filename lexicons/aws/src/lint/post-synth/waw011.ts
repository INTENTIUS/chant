/**
 * WAW011: Deprecated Lambda Runtime
 *
 * Checks Lambda function resources for deprecated or approaching-EOL runtimes.
 * Emits error for "deprecated" runtimes and warning for "approaching_eol".
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import type { Severity } from "@intentius/chant/lint/rule";
import { parseCFTemplate } from "./cf-refs";
import { lambdaRuntimeDeprecations } from "../../codegen/generate-lexicon";

export const waw011: PostSynthCheck = {
  id: "WAW011",
  description: "Deprecated Lambda runtime — flags deprecated or approaching-EOL Lambda runtimes",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    const deprecations = lambdaRuntimeDeprecations();

    for (const [_lexicon, output] of ctx.outputs) {
      const template = parseCFTemplate(output);
      if (!template?.Resources) continue;

      for (const [logicalId, resource] of Object.entries(template.Resources)) {
        if (resource.Type !== "AWS::Lambda::Function") continue;

        const runtime = resource.Properties?.Runtime;
        if (typeof runtime !== "string") continue;

        const status = deprecations[runtime];
        if (!status) continue;

        const severity: Severity = status === "deprecated" ? "error" : "warning";
        const label = status === "deprecated" ? "deprecated" : "approaching end-of-life";

        diagnostics.push({
          checkId: "WAW011",
          severity,
          message: `Lambda "${logicalId}" uses ${label} runtime "${runtime}"`,
          entity: logicalId,
          lexicon: "aws",
        });
      }
    }

    return diagnostics;
  },
};
