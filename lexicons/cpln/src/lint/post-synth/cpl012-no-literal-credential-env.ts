import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { readArray, readString } from "../../entity-props";
import { WORKLOAD, entitiesOfType } from "./helpers";

/** `cpln://secret/NAME.FIELD` — the field qualifier is the part that matters. */
const SECRET_REF = /^cpln:\/\/secret\/([^/.\s]+)(?:\.([^/\s]+))?$/;

/** Env var names that read as credentials. */
const CREDENTIAL_NAME = /(password|passwd|secret|token|apikey|api_key|access_key|private_key|credential)/i;

/**
 * Values that look like a deliberate non-secret rather than a leaked one: an
 * empty string, an obvious placeholder, or another `cpln://` reference.
 */
const PLACEHOLDER = /^(|changeme|placeholder|todo|xxx+|\*+|<[^>]*>|\$\{[^}]*\})$/i;

/**
 * CPL012: a credential-shaped env var carrying a literal value.
 *
 * The alternative is one string change — `cpln://secret/db.password` — so a
 * literal here is almost always an oversight rather than a decision. Env values
 * end up in the workload spec, which is readable by anyone with `get` on the
 * workload, and in every diff of the manifest.
 */
export const noLiteralCredentialEnvCheck: PostSynthCheck = {
  id: "CPL012",
  description: "Credential-shaped environment variables must reference a secret, not a literal",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [name, entity] of entitiesOfType(ctx.entities, WORKLOAD)) {
      for (const container of readArray(entity, "spec", "containers")) {
        const containerName = readString(container, "name") ?? "?";
        for (const env of readArray(container, "env")) {
          const envName = readString(env, "name");
          const value = readString(env, "value");
          if (!envName || value === undefined) continue;
          if (!CREDENTIAL_NAME.test(envName)) continue;
          if (value.startsWith("cpln://") || PLACEHOLDER.test(value)) continue;

          diagnostics.push({
            checkId: "CPL012",
            severity: "error",
            message:
              `Workload "${name}" container "${containerName}" sets env "${envName}" to a literal value. ` +
              `Reference a secret instead — \`cpln://secret/NAME.FIELD\` — so the value is not stored in ` +
              `the workload spec or its diffs.`,
            entity: name,
            lexicon: "cpln",
          });
        }
      }
    }

    return diagnostics;
  },
};
