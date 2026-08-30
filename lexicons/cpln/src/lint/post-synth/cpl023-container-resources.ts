import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { propsOf, readArray, readString } from "../../entity-props";
import { WORKLOAD, entitiesOfType, parseCpuMillicores, parseMemoryMib } from "./helpers";

/** The tag that raises the memory-to-CPU ceiling from 8 to 32. */
const RELAX_RATIO_TAG = "cpln/relaxMemoryToCpuRatio";

const CPU_MIN_MILLICORES = 25;
const MEMORY_MIN_MIB = 32;
const RATIO_MAX = 8;
const RATIO_MAX_RELAXED = 32;

/**
 * CPL023: CPU and memory floors, and the memory-to-CPU ratio.
 *
 * The ratio is the non-obvious one. `memory(MiB) / cpu(millicores)` must be
 * ≤ 8, so `2Gi` of memory needs at least 256 millicores of CPU — a workload
 * asking for lots of memory and a little CPU is rejected, which surprises
 * people coming from Kubernetes where the two are independent. The
 * `cpln/relaxMemoryToCpuRatio` tag raises the ceiling to 32.
 */
export const containerResourcesCheck: PostSynthCheck = {
  id: "CPL023",
  description: "Container CPU and memory must clear the platform floors and the memory-to-CPU ratio",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [name, entity] of entitiesOfType(ctx.entities, WORKLOAD)) {
      const tags = propsOf(entity).tags;
      const relaxed = !!tags && typeof tags === "object" && RELAX_RATIO_TAG in (tags as Record<string, unknown>);
      const ceiling = relaxed ? RATIO_MAX_RELAXED : RATIO_MAX;

      for (const container of readArray(entity, "spec", "containers")) {
        const containerName = readString(container, "name") ?? "?";
        // Control Plane's defaults, so an omitted value is checked as what it
        // will actually become rather than skipped.
        const cpu = parseCpuMillicores(readString(container, "cpu") ?? "50m");
        const memory = parseMemoryMib(readString(container, "memory") ?? "128Mi");

        if (cpu !== undefined && cpu < CPU_MIN_MILLICORES) {
          diagnostics.push({
            checkId: "CPL023",
            severity: "error",
            message:
              `Workload "${name}" container "${containerName}" requests ${cpu}m CPU; the minimum is ` +
              `${CPU_MIN_MILLICORES}m.`,
            entity: name,
            lexicon: "cpln",
          });
        }

        if (memory !== undefined && memory < MEMORY_MIN_MIB) {
          diagnostics.push({
            checkId: "CPL023",
            severity: "error",
            message:
              `Workload "${name}" container "${containerName}" requests ${Math.round(memory)}Mi memory; ` +
              `the minimum is ${MEMORY_MIN_MIB}Mi.`,
            entity: name,
            lexicon: "cpln",
          });
        }

        if (cpu !== undefined && memory !== undefined && cpu > 0) {
          const ratio = memory / cpu;
          if (ratio > ceiling) {
            const needed = Math.ceil(memory / ceiling);
            diagnostics.push({
              checkId: "CPL023",
              severity: "error",
              message:
                `Workload "${name}" container "${containerName}" has a memory-to-CPU ratio of ` +
                `${ratio.toFixed(1)} (${Math.round(memory)}Mi / ${cpu}m), above the limit of ${ceiling}. ` +
                `Raise CPU to at least ${needed}m` +
                (relaxed ? "." : `, or add the \`${RELAX_RATIO_TAG}\` tag to raise the ceiling to ${RATIO_MAX_RELAXED}.`),
              entity: name,
              lexicon: "cpln",
            });
          }
        }
      }
    }

    return diagnostics;
  },
};
