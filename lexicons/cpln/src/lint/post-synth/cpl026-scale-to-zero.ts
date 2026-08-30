import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { readNumber, readPath, readString } from "../../entity-props";
import { WORKLOAD, autoscalingOf, entitiesOfType, workloadType } from "./helpers";

/** Strategies that let a workload scale to zero, by workload type. */
const SCALE_TO_ZERO: Record<string, string[]> = {
  serverless: ["rps", "concurrency"],
  standard: ["keda"],
  stateful: ["keda"],
};

/**
 * CPL026: scale-to-zero that will not happen.
 *
 * `minScale: 0` is accepted on any workload type. It only *takes effect* for
 * serverless with `rps` or `concurrency`, or for standard/stateful under KEDA.
 * Everywhere else the workload holds at one replica and the cost saving that
 * motivated the setting never arrives — with nothing reported.
 */
export const scaleToZeroCheck: PostSynthCheck = {
  id: "CPL026",
  description: "minScale 0 must pair with a strategy that can actually scale to zero",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [name, entity] of entitiesOfType(ctx.entities, WORKLOAD)) {
      const scaling = autoscalingOf(entity);
      if (!scaling || typeof scaling !== "object") continue;
      if (readNumber(scaling, "minScale") !== 0) continue;

      const type = workloadType(entity);
      const metric = readString(scaling, "metric") ?? (type === "serverless" ? "concurrency" : undefined);

      if (type === "cron") {
        diagnostics.push({
          checkId: "CPL026",
          severity: "error",
          message: `Cron workload "${name}" sets minScale 0. Cron workloads cannot scale to zero.`,
          entity: name,
          lexicon: "cpln",
        });
        continue;
      }

      const allowed = SCALE_TO_ZERO[type] ?? [];
      const usingKeda = metric === "keda" || readPath(scaling, "keda") !== undefined;
      if (allowed.includes(metric ?? "") || (allowed.includes("keda") && usingKeda)) continue;

      diagnostics.push({
        checkId: "CPL026",
        severity: "warning",
        message:
          `Workload "${name}" (type "${type}") sets minScale 0 with metric "${metric ?? "unset"}", which ` +
          `cannot scale to zero. ` +
          (type === "serverless"
            ? `Serverless scales to zero only with "rps" or "concurrency".`
            : `Standard and stateful workloads scale to zero only under KEDA, which must be enabled on the GVC.`) +
          ` As written the workload holds at one replica with no error.`,
        entity: name,
        lexicon: "cpln",
      });
    }

    return diagnostics;
  },
};
