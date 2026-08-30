import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { readArray, readPath, readString } from "../../entity-props";
import { WORKLOAD, entitiesOfType } from "./helpers";

/** The four mutually exclusive probe handlers. */
const PROBE_HANDLERS = ["exec", "grpc", "tcpSocket", "httpGet"] as const;

/**
 * CPL024: a probe must set exactly one handler.
 *
 * Zero is the interesting case: a `readinessProbe` with only
 * `initialDelaySeconds` and `periodSeconds` set looks configured and probes
 * nothing.
 */
export const probeHandlerCheck: PostSynthCheck = {
  id: "CPL024",
  description: "Each health-check probe must set exactly one of exec, grpc, tcpSocket, httpGet",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [name, entity] of entitiesOfType(ctx.entities, WORKLOAD)) {
      for (const container of readArray(entity, "spec", "containers")) {
        const containerName = readString(container, "name") ?? "?";

        for (const probeName of ["readinessProbe", "livenessProbe"]) {
          const probe = readPath(container, probeName);
          if (!probe || typeof probe !== "object") continue;

          const set = PROBE_HANDLERS.filter((handler) => readPath(probe, handler) !== undefined);
          if (set.length === 1) continue;

          diagnostics.push({
            checkId: "CPL024",
            severity: "error",
            message:
              set.length === 0
                ? `Workload "${name}" container "${containerName}" declares a ${probeName} with no handler. ` +
                  `Set exactly one of ${PROBE_HANDLERS.join(", ")} — as written the probe checks nothing.`
                : `Workload "${name}" container "${containerName}" ${probeName} sets ${set.length} handlers ` +
                  `(${set.join(", ")}). They are mutually exclusive; keep one.`,
            entity: name,
            lexicon: "cpln",
          });
        }
      }
    }

    return diagnostics;
  },
};
