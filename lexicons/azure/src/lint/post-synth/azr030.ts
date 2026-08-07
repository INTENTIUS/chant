/**
 * AZR030: Resource deployed at an unsupported template scope
 *
 * Errors when a template contains a resource whose ARM schema does not
 * define it at the template's deployment scope (#1545). The serializer
 * picks the template $schema from the common scope of all resources; a
 * template mixing, say, management groups (tenant-only) with virtual
 * networks (resource-group-only) has no valid single-template scope —
 * split the project so each scope deploys its own template (linked
 * deployments cross scopes).
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseArmTemplate } from "./arm-refs";
import { deployScopesFor, scopeForTemplateSchema } from "../../deploy-scopes";

export const azr030: PostSynthCheck = {
  id: "AZR030",
  description: "Resource deployed at an unsupported template scope — split scopes into separate templates",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [_lexicon, output] of ctx.outputs) {
      const template = parseArmTemplate(output);
      if (!template?.resources) continue;

      const templateScope = scopeForTemplateSchema(
        (template as Record<string, unknown>).$schema,
      );

      for (const resource of template.resources) {
        if (typeof resource.type !== "string") continue;
        const scopes = deployScopesFor(resource.type);
        if (scopes.includes(templateScope)) continue;

        const resourceName = typeof resource.name === "string" ? resource.name : String(resource.name);
        diagnostics.push({
          checkId: "AZR030",
          severity: "error",
          message:
            `Resource "${resourceName}" (${resource.type}) deploys at ` +
            `${scopes.join("/")} scope, but this template targets ${templateScope} scope — ` +
            `move it to a project deployed at a scope its schema supports`,
          entity: resourceName,
          lexicon: "azure",
        });
      }
    }

    return diagnostics;
  },
};
