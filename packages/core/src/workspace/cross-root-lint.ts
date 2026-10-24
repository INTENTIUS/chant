/**
 * The disagreement lint (#2549, #2524 D6): `chant workspace lint --cross-root`.
 *
 * A member link is written down once, on the consumer. The members' graphs
 * can surface the same relation on their own: a consumer's parameter that
 * joins another member's output by name, or any relation a lexicon puts in
 * its IR. The lint reports where the two disagree.
 *
 * It uses #1939's cross-build-root mode. Each composed member is one build
 * root, read under the member's own toolchain as `chant workspace graph`
 * reads it (`crossRootInputs` in `./workspace-run.ts`), and the composed
 * graph's link table goes to every check as `ctx.links`. The checks are:
 *
 * - LNK001, core's own: the consumer declares a link to one member's output
 *   while its graph joins a parameter of the same name to another member's.
 * - every cross-root check a lexicon ships through `crossRootChecks()`, for
 *   the lexicons the members' graphs name. A lexicon applies its own rule
 *   once it surfaces the relation in its IR. One that can't be loaded here
 *   is reported and skipped.
 *
 * Nothing runs unless `--cross-root` asks, so a plain `workspace lint`, and
 * level 0, pay nothing for it.
 */

import { joinKey } from "../join-key";
import type { CrossRootCheck, CrossRootLink, PostSynthCheck, PostSynthDiagnostic } from "../lint/post-synth";
import { runCrossRootChecks } from "../lint/post-synth";
import type { WorkspaceGraph } from "./compose-graph";
import { crossRootInputs } from "./workspace-run";

export const LNK001_ID = "LNK001";

/** The links of the composed graph, as a cross-root check reads them. Ambiguous rows and record links are left out. */
export function crossRootLinks(links: WorkspaceGraph["links"]): CrossRootLink[] {
  const out: CrossRootLink[] = [];
  for (const row of links) {
    const r = row as { consumer?: unknown; producer?: unknown; output?: unknown; origin?: unknown; input?: unknown; status?: unknown; kind?: unknown };
    if (typeof r.consumer !== "string" || typeof r.producer !== "string" || typeof r.output !== "string" || typeof r.origin !== "string") continue;
    out.push({
      consumer: r.consumer,
      producer: r.producer,
      output: r.output,
      origin: r.origin,
      ...(typeof r.input === "string" || r.input === null ? { input: r.input as string | null } : {}),
      ...(typeof r.status === "string" ? { status: r.status } : {}),
    });
  }
  return out;
}

/**
 * LNK001: a declared link and a join the graph surfaces name different
 * producers for the same handle. The consumer must be one of the run's roots,
 * so its graph was read.
 */
export const lnk001: CrossRootCheck = {
  id: LNK001_ID,
  description: "A declared member link and the join the members' graphs surface name different producers for the same output",
  scope: "cross-root",
  check(ctx) {
    const links = ctx.links ?? [];
    const findings: PostSynthDiagnostic[] = [];
    const declared = links.filter((l) => l.origin === "declared" && l.status !== "invalid");
    for (const inferred of links) {
      if (!inferred.origin.startsWith("inferred:") || inferred.status !== "resolved") continue;
      if (!ctx.root(inferred.consumer)) continue;
      const keys = new Set([joinKey(inferred.output), ...(inferred.input ? [joinKey(inferred.input)] : [])]);
      for (const d of declared) {
        if (d.consumer !== inferred.consumer || d.producer === inferred.producer) continue;
        if (!keys.has(joinKey(d.output))) continue;
        findings.push({
          checkId: LNK001_ID,
          severity: "warning",
          message:
            `${d.consumer} declares a link to ${d.producer}'s output ${d.output}, but its graph joins ` +
            `${inferred.input ? `parameter ${inferred.input}` : "a parameter"} to ${inferred.producer}'s output ${inferred.output}. ` +
            `Point the link at the member the graph reads from, or rename the parameter so it joins the declared output.`,
          root: d.consumer,
          entity: inferred.input ?? undefined,
        });
      }
    }
    return findings;
  },
};

/** What a cross-root lint run found. */
export interface CrossRootLintResult {
  findings: PostSynthDiagnostic[];
  /** The checks that ran, by id. */
  checks: string[];
  /** Lexicons whose cross-root checks could not be loaded here, and why. */
  unloaded: { lexicon: string; reason: string }[];
}

/** Loads a lexicon's cross-root checks; the plugin loader by default. */
export type CrossRootCheckLoader = (lexicon: string) => Promise<ReadonlyArray<CrossRootCheck | PostSynthCheck>>;

async function pluginChecks(lexicon: string): Promise<ReadonlyArray<CrossRootCheck | PostSynthCheck>> {
  const { loadPlugin } = await import("../cli/plugins");
  const plugin = await loadPlugin(lexicon);
  return plugin.crossRootChecks?.() ?? [];
}

/**
 * Run the disagreement lint over a composed graph: one root per composed
 * member, LNK001, and the cross-root checks of every lexicon the roots name.
 */
export async function crossRootLint(graph: WorkspaceGraph, opts: { env?: string; load?: CrossRootCheckLoader } = {}): Promise<CrossRootLintResult> {
  const roots = crossRootInputs(graph, opts.env);
  const lexicons = [...new Set(roots.flatMap((r) => [...r.buildResult.entities.values()].map((e) => e.lexicon)))]
    .filter((l) => typeof l === "string" && l !== "chant")
    .sort();
  const checks: Array<CrossRootCheck | PostSynthCheck> = [lnk001];
  const unloaded: CrossRootLintResult["unloaded"] = [];
  for (const lexicon of lexicons) {
    try {
      checks.push(...(await (opts.load ?? pluginChecks)(lexicon)));
    } catch (err) {
      unloaded.push({ lexicon, reason: err instanceof Error ? err.message.split("\n")[0]! : String(err) });
    }
  }
  const findings = runCrossRootChecks(checks, roots, { ...(opts.env ? { env: opts.env } : {}), links: crossRootLinks(graph.links) });
  const ran = checks.filter((c) => (c as CrossRootCheck).scope === "cross-root").map((c) => c.id);
  return { findings, checks: ran, unloaded };
}
