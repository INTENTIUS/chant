/**
 * Reconcile outcome reporting and the shared exit-code policy. Every warden's
 * `runReconcile` returns this structural shape (it comes from the same
 * `@intentius/chant/reconcile` seam), so the rendering and the exit decision
 * live once here.
 *
 * Exit codes: 0 success · 1 guardrail block · 3 errored cycle or failed apply.
 */

export interface OutcomeCycle {
  name: string;
  org: string;
  plan: string;
  guardrailBlocked: boolean;
  guardrails: { ok: true } | { ok: false; diagnostics: { message: string }[] };
  applied: readonly unknown[];
  failed: readonly { entry: { resourceType: string; key: string }; error: string }[];
}

export interface ReconcileOutcome {
  cycles: readonly OutcomeCycle[];
  errored: readonly { name: string; org: string; stage: string; error: string }[];
  deferred: { skippedCycles: readonly string[] };
}

/** Print the outcome (plans to stdout, errors to stderr) and return the exit code. */
export function reportReconcileOutcome(result: ReconcileOutcome, mode: "dry-run" | "apply"): number {
  for (const cr of result.cycles) {
    process.stdout.write(`\n=== ${cr.name} @ ${cr.org} ===\n${cr.plan}\n`);
    if (cr.guardrailBlocked) {
      const diags = cr.guardrails.ok ? [] : cr.guardrails.diagnostics;
      process.stdout.write(`\nGUARDRAIL BLOCK: ${diags.map((d) => d.message).join("; ")}\n`);
    }
    if (mode === "apply" && !cr.guardrailBlocked) {
      process.stdout.write(`Applied: ${cr.applied.length}, Failed: ${cr.failed.length}\n`);
      for (const f of cr.failed) {
        process.stdout.write(`  FAILED [${f.entry.resourceType}] ${f.entry.key}: ${f.error}\n`);
      }
    }
  }
  for (const ce of result.errored) {
    process.stderr.write(`ERROR in ${ce.name} @ ${ce.org} (${ce.stage}): ${ce.error}\n`);
  }
  if (result.deferred.skippedCycles.length > 0) {
    process.stderr.write(`DEFERRED cycles (budget exhausted): ${result.deferred.skippedCycles.join(", ")}\n`);
  }

  if (result.cycles.some((cr) => cr.guardrailBlocked)) return 1;
  if (result.errored.length > 0 || result.cycles.some((cr) => cr.failed.length > 0)) return 3;
  return 0;
}

/** Resolve `--cycles` names against a registry; throws listing what exists. */
export function selectCycles<C>(registry: Record<string, C>, names: readonly string[]): C[] {
  if (names.length === 0) return Object.values(registry);
  return names.map((name) => {
    const cycle = registry[name];
    if (!cycle) {
      throw new Error(
        `unknown cycle: "${name}". Known cycles: ${Object.keys(registry).join(", ") || "(none yet)"}`,
      );
    }
    return cycle;
  });
}
