import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { readPath, readString } from "../../entity-props";
import { WORKLOAD, entitiesOfType, exposedPorts, workloadType } from "./helpers";

/**
 * CPL021: a cron workload needs a schedule and must expose no ports.
 *
 * Cron cannot serve traffic, so a port on one is always a misunderstanding —
 * usually a workload converted from serverless with the ports left behind. A
 * missing `spec.job.schedule` is the other half: `spec.job` is *required* for
 * cron and forbidden for every other type.
 */
export const cronJobShapeCheck: PostSynthCheck = {
  id: "CPL021",
  description: "Cron workloads must declare a schedule and expose no ports",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [name, entity] of entitiesOfType(ctx.entities, WORKLOAD)) {
      const type = workloadType(entity);
      const job = readPath(entity, "spec", "job");
      const schedule = readString(entity, "spec", "job", "schedule");

      if (type === "cron") {
        if (!schedule) {
          diagnostics.push({
            checkId: "CPL021",
            severity: "error",
            message: `Cron workload "${name}" has no spec.job.schedule. A cron workload requires one.`,
            entity: name,
            lexicon: "cpln",
          });
        }

        const ports = exposedPorts(entity);
        if (ports.length > 0) {
          diagnostics.push({
            checkId: "CPL021",
            severity: "error",
            message:
              `Cron workload "${name}" exposes ${ports.length} port(s) (${ports.join(", ")}). Cron workloads ` +
              `cannot serve traffic — remove the ports, or use a standard workload.`,
            entity: name,
            lexicon: "cpln",
          });
        }
        continue;
      }

      if (job !== undefined) {
        diagnostics.push({
          checkId: "CPL021",
          severity: "error",
          message: `Workload "${name}" is type "${type}" but sets spec.job. Only cron workloads may declare one.`,
          entity: name,
          lexicon: "cpln",
        });
      }
    }

    return diagnostics;
  },
};
