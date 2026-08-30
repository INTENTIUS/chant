import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { readArray, readString } from "../../entity-props";
import { WORKLOAD, entitiesOfType } from "./helpers";

/** `cpln://secret/NAME.FIELD` — the field qualifier is the part that matters. */
const SECRET_REF = /^cpln:\/\/secret\/([^/.\s]+)(?:\.([^/\s]+))?$/;

/**
 * CPL014: a secret reference with no field qualifier.
 *
 * `cpln://secret/db` resolves to nothing for every secret type except `gcp`,
 * which is conventionally mounted as a whole JSON file. The field name is not
 * optional: `opaque` needs `.payload`, `userpass` needs `.username`/`.password`,
 * `tls` needs `.cert`/`.key`, and a `dictionary` needs one of its keys.
 *
 * Volume mounts are exempt — mounting a secret as a directory is the documented
 * way to consume a `dictionary` or a `gcp` credential file.
 */
export const qualifiedSecretRefCheck: PostSynthCheck = {
  id: "CPL014",
  description: "Secret references in environment variables must name a field",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [name, entity] of entitiesOfType(ctx.entities, WORKLOAD)) {
      for (const container of readArray(entity, "spec", "containers")) {
        const containerName = readString(container, "name") ?? "?";
        for (const env of readArray(container, "env")) {
          const envName = readString(env, "name") ?? "?";
          const value = readString(env, "value");
          if (!value) continue;

          const match = SECRET_REF.exec(value);
          if (!match || match[2]) continue;

          diagnostics.push({
            checkId: "CPL014",
            severity: "error",
            message:
              `Workload "${name}" container "${containerName}" sets env "${envName}" to "${value}", which ` +
              `names no field. Use \`cpln://secret/${match[1]}.FIELD\` — \`.payload\` for opaque, ` +
              `\`.username\`/\`.password\` for userpass, \`.cert\`/\`.key\` for tls, a key name for a ` +
              `dictionary. An unqualified reference resolves to nothing at runtime.`,
            entity: name,
            lexicon: "cpln",
          });
        }
      }
    }

    return diagnostics;
  },
};
