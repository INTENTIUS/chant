/**
 * AZR011: Missing or Invalid API Version
 *
 * Checks that every ARM resource has a valid apiVersion field.
 * The apiVersion must be a non-empty string matching the date format
 * YYYY-MM-DD (optionally with a suffix like -preview).
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseArmTemplate } from "./arm-refs";

const API_VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}(-preview|-privatepreview)?$/;

export const azr011: PostSynthCheck = {
  id: "AZR011",
  description: "Missing or invalid apiVersion — every ARM resource must have a valid apiVersion in YYYY-MM-DD format",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [_lexicon, output] of ctx.outputs) {
      const template = parseArmTemplate(output);
      if (!template?.resources) continue;

      for (const resource of template.resources) {
        const resourceName = typeof resource.name === "string" ? resource.name : String(resource.name);

        if (!resource.apiVersion) {
          diagnostics.push({
            checkId: "AZR011",
            severity: "error",
            message: `Resource "${resourceName}" (${resource.type}) is missing apiVersion`,
            entity: resourceName,
            lexicon: "azure",
          });
        } else if (typeof resource.apiVersion !== "string" || !API_VERSION_PATTERN.test(resource.apiVersion)) {
          diagnostics.push({
            checkId: "AZR011",
            severity: "error",
            message: `Resource "${resourceName}" (${resource.type}) has invalid apiVersion "${resource.apiVersion}" — expected YYYY-MM-DD format`,
            entity: resourceName,
            lexicon: "azure",
          });
        }
      }
    }

    return diagnostics;
  },
};
