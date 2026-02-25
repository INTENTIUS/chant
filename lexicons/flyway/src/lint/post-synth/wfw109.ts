/**
 * WFW109: Provisioner Config Mismatch
 *
 * Detects backup or snapshot provisioners that are missing a filePath
 * property. Backup and snapshot provisioners require a filePath to know
 * where to store or read the database backup/snapshot.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseFlywayTOML, forEachEnvironment } from "./flyway-helpers";

const PROVISIONERS_REQUIRING_FILEPATH = new Set(["backup", "snapshot"]);

export const wfw109: PostSynthCheck = {
  id: "WFW109",
  description: "Backup/snapshot provisioner without filePath property — filePath is required for these provisioner types",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [name, output] of ctx.outputs) {
      const config = parseFlywayTOML(output);

      forEachEnvironment(config, (envName, env) => {
        const provisioner = env.provisioner as Record<string, unknown> | undefined;
        if (!provisioner || typeof provisioner !== "object") return;

        const provisionerType = provisioner.type as string | undefined;
        if (
          typeof provisionerType === "string" &&
          PROVISIONERS_REQUIRING_FILEPATH.has(provisionerType)
        ) {
          const filePath = provisioner.filePath;
          if (filePath === undefined || filePath === null || (typeof filePath === "string" && filePath.trim() === "")) {
            diagnostics.push({
              checkId: "WFW109",
              severity: "error",
              message: `Environment "${envName}" has a "${provisionerType}" provisioner without a filePath property — filePath is required`,
              entity: name,
              lexicon: "flyway",
            });
          }
        }
      });
    }

    return diagnostics;
  },
};
