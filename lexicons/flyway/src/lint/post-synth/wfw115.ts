/**
 * WFW115: Provisioner Without Matching Environment
 *
 * Detects when an environment references a `provisioner` value that does not
 * correspond to any defined environment name. This typically indicates a typo
 * or missing environment definition.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseFlywayTOML, forEachEnvironment } from "./flyway-helpers";

export const wfw115: PostSynthCheck = {
  id: "WFW115",
  description: "Environment references a provisioner that does not match any defined environment",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [name, output] of ctx.outputs) {
      const config = parseFlywayTOML(output);

      // Collect all defined environment names
      const envNames = new Set<string>();
      forEachEnvironment(config, (envName) => {
        envNames.add(envName);
      });

      // Check each environment for a provisioner reference
      forEachEnvironment(config, (envName, env) => {
        const provisioner = env.provisioner;
        if (typeof provisioner !== "string") return;

        if (!envNames.has(provisioner)) {
          diagnostics.push({
            checkId: "WFW115",
            severity: "warning",
            message: `Environment "${envName}" references provisioner "${provisioner}" which is not a defined environment`,
            entity: name,
            lexicon: "flyway",
          });
        }
      });
    }

    return diagnostics;
  },
};
