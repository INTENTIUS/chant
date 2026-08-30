import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { readArray, readString } from "../../entity-props";
import { WORKLOAD, entitiesOfType, exposedPorts, workloadType } from "./helpers";

/**
 * CPL020: a serverless workload must expose exactly one HTTP port.
 *
 * Not "at least one" and not "any number" — exactly one, and it must be HTTP.
 * Zero is the more common mistake and the more confusing one, because the
 * workload deploys and reports healthy while serving nothing.
 */
export const serverlessSinglePortCheck: PostSynthCheck = {
  id: "CPL020",
  description: "Serverless workloads must expose exactly one HTTP port",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [name, entity] of entitiesOfType(ctx.entities, WORKLOAD)) {
      if (workloadType(entity) !== "serverless") continue;

      const ports = exposedPorts(entity);
      if (ports.length !== 1) {
        diagnostics.push({
          checkId: "CPL020",
          severity: "error",
          message:
            `Serverless workload "${name}" exposes ${ports.length} ports; exactly one HTTP port is required. ` +
            (ports.length === 0
              ? `It will deploy and serve nothing.`
              : `Use a standard workload if it genuinely needs several.`),
          entity: name,
          lexicon: "cpln",
        });
        continue;
      }

      // The single port must be HTTP. `tcp` and `grpc` need a standard workload.
      for (const container of readArray(entity, "spec", "containers")) {
        for (const port of readArray(container, "ports")) {
          const protocol = readString(port, "protocol") ?? "http";
          if (protocol === "http" || protocol === "http2") continue;
          diagnostics.push({
            checkId: "CPL020",
            severity: "error",
            message:
              `Serverless workload "${name}" exposes a "${protocol}" port. Serverless supports only http ` +
              `and http2 — use a standard workload for ${protocol}.`,
            entity: name,
            lexicon: "cpln",
          });
        }
      }
    }

    return diagnostics;
  },
};
