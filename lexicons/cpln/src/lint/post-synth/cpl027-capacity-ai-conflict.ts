import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { readArray, readBoolean, readPath, readString } from "../../entity-props";
import { WORKLOAD, autoscalingOf, entitiesOfType, workloadType } from "./helpers";

/**
 * CPL027: Capacity AI combined with something it excludes.
 *
 * Capacity AI resizes CPU and memory from observed usage, and it is **on by
 * default** for serverless, standard and cron — so these conflicts are usually
 * reached by adding CPU autoscaling or a GPU to a workload that never opted
 * into Capacity AI in the first place. Each conflict has the same root: the
 * other feature needs a stable resource baseline that Capacity AI is actively
 * moving.
 */
export const capacityAiConflictCheck: PostSynthCheck = {
  id: "CPL027",
  description: "Capacity AI conflicts with CPU-utilization autoscaling, multi-metric autoscaling and GPUs",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [name, entity] of entitiesOfType(ctx.entities, WORKLOAD)) {
      const type = workloadType(entity);
      // Default-on for every type except stateful, so `undefined` means enabled
      // for those — which is exactly how these conflicts get reached unnoticed.
      const declared = readBoolean(entity, "spec", "defaultOptions", "capacityAI");
      const enabled = declared ?? type !== "stateful";
      if (!enabled) continue;

      const implicit = declared === undefined;
      const how = implicit ? "Capacity AI is on by default for this workload type and" : "Capacity AI";

      const scaling = autoscalingOf(entity);
      const metric = scaling && typeof scaling === "object" ? readString(scaling, "metric") : undefined;
      const multi = scaling && typeof scaling === "object" ? readArray(scaling, "multi") : [];

      if (metric === "cpu") {
        diagnostics.push({
          checkId: "CPL027",
          severity: "error",
          message:
            `Workload "${name}": ${how} conflicts with CPU-utilization autoscaling — dynamic CPU allocation ` +
            `moves the baseline the metric scales against. Set defaultOptions.capacityAI false, or scale on ` +
            `rps or memory.`,
          entity: name,
          lexicon: "cpln",
        });
      }

      if (multi.length > 0) {
        diagnostics.push({
          checkId: "CPL027",
          severity: "error",
          message:
            `Workload "${name}": ${how} conflicts with multi-metric autoscaling, which requires stable ` +
            `resource baselines. Set defaultOptions.capacityAI false.`,
          entity: name,
          lexicon: "cpln",
        });
      }

      for (const container of readArray(entity, "spec", "containers")) {
        if (readPath(container, "gpu") === undefined) continue;
        diagnostics.push({
          checkId: "CPL027",
          severity: "error",
          message:
            `Workload "${name}" container "${readString(container, "name") ?? "?"}" requests a GPU, and ` +
            `${how} conflicts with it — GPU allocation is fixed. Set defaultOptions.capacityAI false.`,
          entity: name,
          lexicon: "cpln",
        });
      }
    }

    return diagnostics;
  },
};
