/**
 * WFW113: Conflicting Schemas Across Environments
 *
 * Detects when two environments share the same JDBC `url` but have different
 * `schemas` arrays. This is usually a misconfiguration that can lead to
 * migrations running against unexpected schemas.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseFlywayTOML, forEachEnvironment } from "./flyway-helpers";

function schemasKey(schemas: unknown): string {
  if (!Array.isArray(schemas)) return "";
  return [...schemas].sort().join(",");
}

export const wfw113: PostSynthCheck = {
  id: "WFW113",
  description: "Conflicting schemas across environments sharing the same URL",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [name, output] of ctx.outputs) {
      const config = parseFlywayTOML(output);

      // Collect environments grouped by URL
      const byUrl = new Map<string, { envName: string; schemas: unknown }[]>();

      forEachEnvironment(config, (envName, env) => {
        const url = env.url;
        if (typeof url !== "string") return;

        const entry = { envName, schemas: env.schemas };
        const existing = byUrl.get(url);
        if (existing) {
          existing.push(entry);
        } else {
          byUrl.set(url, [entry]);
        }
      });

      // Check for conflicts within each URL group
      for (const [url, envs] of byUrl) {
        if (envs.length < 2) continue;

        const schemaGroups = new Map<string, string[]>();
        for (const env of envs) {
          const key = schemasKey(env.schemas);
          const group = schemaGroups.get(key);
          if (group) {
            group.push(env.envName);
          } else {
            schemaGroups.set(key, [env.envName]);
          }
        }

        if (schemaGroups.size > 1) {
          const envNames = envs.map((e) => e.envName).join(", ");
          diagnostics.push({
            checkId: "WFW113",
            severity: "warning",
            message: `Environments [${envNames}] share URL "${url}" but have different schemas — this may cause unexpected migration behavior`,
            entity: name,
            lexicon: "flyway",
          });
        }
      }
    }

    return diagnostics;
  },
};
