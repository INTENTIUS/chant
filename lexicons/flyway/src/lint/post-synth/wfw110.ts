/**
 * WFW110: Schema Mismatch
 *
 * Detects environments where flyway.schemas differs from the schemas
 * defined in a parent environment (if the environment extends another).
 * Schema mismatches between environments can cause migrations to target
 * different schemas unexpectedly.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseFlywayTOML, forEachEnvironment } from "./flyway-helpers";

function schemasEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((val, i) => val === b[i]);
  }
  return false;
}

export const wfw110: PostSynthCheck = {
  id: "WFW110",
  description: "Environment schemas differ from parent environment schemas — potential schema mismatch",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [name, output] of ctx.outputs) {
      const config = parseFlywayTOML(output);

      // Collect schemas per environment
      const envSchemas = new Map<string, unknown>();
      forEachEnvironment(config, (envName, env) => {
        if (env.schemas !== undefined) {
          envSchemas.set(envName, env.schemas);
        }
      });

      // Check for environments that extend another and have different schemas
      forEachEnvironment(config, (envName, env) => {
        const extendsEnv = env.extends as string | undefined;
        if (typeof extendsEnv !== "string") return;

        const childSchemas = envSchemas.get(envName);
        const parentSchemas = envSchemas.get(extendsEnv);

        if (
          childSchemas !== undefined &&
          parentSchemas !== undefined &&
          !schemasEqual(childSchemas, parentSchemas)
        ) {
          diagnostics.push({
            checkId: "WFW110",
            severity: "warning",
            message: `Environment "${envName}" has different schemas than parent environment "${extendsEnv}" — this may cause migrations to target different schemas`,
            entity: name,
            lexicon: "flyway",
          });
        }
      });
    }

    return diagnostics;
  },
};
