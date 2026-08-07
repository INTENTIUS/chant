import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { readArray, readNumber, readString } from "../../entity-props";
import { WORKLOAD, autoscalingOf, entitiesOfType, workloadType } from "./helpers";

/** Which strategies each workload type supports at all. */
const SUPPORTED_METRICS: Record<string, string[]> = {
  serverless: ["concurrency", "rps", "cpu", "memory", "disabled"],
  standard: ["rps", "cpu", "memory", "latency", "keda", "disabled"],
  stateful: ["rps", "cpu", "memory", "latency", "keda", "disabled"],
};

/**
 * CPL025: mutually exclusive autoscaling fields, and the `target` ceiling.
 *
 * `metric` and `multi` are alternatives, not layers; `target` belongs to the
 * single-metric form and is rejected alongside `multi`; and with cpu or memory
 * as the metric, `target` is a utilization percentage, so above 100 it is not
 * an aggressive setting but an invalid one.
 */
export const autoscalingShapeCheck: PostSynthCheck = {
  id: "CPL025",
  description: "Autoscaling `metric`, `multi` and `target` must form a valid combination",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [name, entity] of entitiesOfType(ctx.entities, WORKLOAD)) {
      const scaling = autoscalingOf(entity);
      if (!scaling || typeof scaling !== "object") continue;

      const metric = readString(scaling, "metric");
      const multi = readArray(scaling, "multi");
      const target = readNumber(scaling, "target");
      const type = workloadType(entity);

      if (metric && multi.length > 0) {
        diagnostics.push({
          checkId: "CPL025",
          severity: "error",
          message:
            `Workload "${name}" sets both autoscaling.metric ("${metric}") and autoscaling.multi. ` +
            `They are mutually exclusive — multi is the multi-metric form and replaces metric.`,
          entity: name,
          lexicon: "cpln",
        });
      }

      if (target !== undefined && multi.length > 0) {
        diagnostics.push({
          checkId: "CPL025",
          severity: "error",
          message:
            `Workload "${name}" sets autoscaling.target alongside autoscaling.multi. ` +
            `Each entry in multi carries its own target.`,
          entity: name,
          lexicon: "cpln",
        });
      }

      if (target !== undefined && (metric === "cpu" || metric === "memory") && target > 100) {
        diagnostics.push({
          checkId: "CPL025",
          severity: "error",
          message:
            `Workload "${name}" sets autoscaling.target ${target} with metric "${metric}", which is a ` +
            `utilization percentage capped at 100.`,
          entity: name,
          lexicon: "cpln",
        });
      }

      const supported = SUPPORTED_METRICS[type];
      if (metric && supported && !supported.includes(metric)) {
        diagnostics.push({
          checkId: "CPL025",
          severity: "error",
          message:
            `Workload "${name}" is type "${type}" and uses autoscaling metric "${metric}", which that type ` +
            `does not support. Available: ${supported.join(", ")}.`,
          entity: name,
          lexicon: "cpln",
        });
      }

      if (multi.length > 0 && type === "serverless") {
        diagnostics.push({
          checkId: "CPL025",
          severity: "error",
          message:
            `Workload "${name}" is serverless and uses multi-metric autoscaling, which is available only ` +
            `on standard and stateful workloads.`,
          entity: name,
          lexicon: "cpln",
        });
      }
    }

    return diagnostics;
  },
};
