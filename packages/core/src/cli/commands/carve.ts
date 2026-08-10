/**
 * `chant carve advise` — the read-only Terraform peelability advisor (#214).
 *
 * Points at a Terraform estate and reports which resources/modules are cheap to
 * carve into native chant later and which should stay in Terraform. It emits
 * nothing, patches nothing, and touches no live resource — pure analysis. The
 * emit/boundary/apply phases stay in #197, gated on demand.
 */

import { existsSync, statSync, writeFileSync } from "fs";
import { parseTerraformDir, Hcl2JsonNotInstalled } from "../../terraform/parse";
import { scoreEstate, type Peelability, type PeelabilityBand } from "../../terraform/score";
import { boundaryReport, type BoundaryEdge } from "../../terraform/carve";
import type { TfGraph } from "../../terraform/types";

export interface CarveAdviseOptions {
  /** Terraform estate directory (from `--from`). */
  from?: string;
  /** Opt-in `.tfstate` path (from `--state`): accurate fan-out instance counts. */
  statePath?: string;
  /** Write the full JSON report to this path (from `--report <path>`). */
  reportFile?: string;
}

export interface CarveAdviseResult {
  ok: boolean;
  error?: string;
  from?: string;
  results?: Peelability[];
  /**
   * The parsed dependency graph the scores came from. Kept so the JSON report
   * can carry the boundary edge lists (#1636) rather than only their counts.
   * Not part of the JSON payload — `carveJson` derives from it.
   */
  graph?: TfGraph;
}

const BAND_ORDER: PeelabilityBand[] = ["clean leaf", "carvable w/ edits", "leave in Terraform"];

export async function carveAdvise(opts: CarveAdviseOptions): Promise<CarveAdviseResult> {
  if (!opts.from) {
    return { ok: false, error: "chant carve advise requires --from <terraform-dir>" };
  }
  if (!existsSync(opts.from) || !statSync(opts.from).isDirectory()) {
    return { ok: false, error: `Not a directory: ${opts.from}` };
  }
  if (opts.statePath && !existsSync(opts.statePath)) {
    return { ok: false, error: `State file not found: ${opts.statePath}` };
  }

  let graph: TfGraph;
  let results: Peelability[];
  try {
    graph = await parseTerraformDir(opts.from, { statePath: opts.statePath });
    results = scoreEstate(graph);
  } catch (err) {
    if (err instanceof Hcl2JsonNotInstalled) return { ok: false, error: err.message };
    return { ok: false, error: `Failed to parse Terraform in ${opts.from}: ${err instanceof Error ? err.message : String(err)}` };
  }

  const result: CarveAdviseResult = { ok: true, from: opts.from, results, graph };
  if (opts.reportFile) {
    writeFileSync(opts.reportFile, JSON.stringify(carveJson(result), null, 2));
  }

  return result;
}

/**
 * The schema version of the `--json` / `--report` payload (#1636).
 *
 * The report is a cross-tool contract — behold renders it as a graph — so it
 * says which shape it is. The promise attached to this number:
 *
 *  - **Additive within a version.** New top-level fields, new per-resource
 *    fields, and new entries in an existing list may appear in any release. A
 *    reader must ignore keys it does not know.
 *  - **A removal, a rename, or a changed meaning bumps it.** So does narrowing
 *    a field's type (an optional becoming required is additive; the reverse is
 *    not).
 *  - A reader that does not know the version it is handed should refuse the
 *    report rather than half-read it.
 */
export const CARVE_REPORT_VERSION = 1;

/** One ranked resource in the JSON report: its score, plus the boundary its carve would cut. */
export interface CarveJsonResource extends Peelability {
  /**
   * Every dependency edge carving this resource would cut (#1636), in chant's
   * own `BoundaryEdge` shape — the same classification the emit/bridge path
   * runs on. `inbound` edges need a Terraform `data`-source patch the moment
   * the carve lands; `outbound` edges become deploy-time inputs, deferred
   * until apply.
   *
   * The lists are the *carve set's* boundary, so a folded sub-resource never
   * appears as an endpoint: it carves with its parent, and the parent's edges
   * stand in for it. Edges internal to the carve set are not boundary work and
   * are not listed.
   *
   * Present (possibly with two empty lists) whenever the graph was available;
   * absent means this chant did not compute it — "none" and "not reported" are
   * different claims. `breakdown.inbound`/`outbound` keep the counts.
   */
  boundary?: { inbound: BoundaryEdge[]; outbound: BoundaryEdge[] };
}

/** The `chant carve advise --json` / `--report` payload. Versioned; see {@link CARVE_REPORT_VERSION}. */
export interface CarveJsonReport {
  version: number;
  from?: string;
  advisory: string;
  count: number;
  /** Band name -> how many resources landed in it. */
  bands: Record<string, number>;
  resources: CarveJsonResource[];
}

/** Build the `--json` / `--report` payload. */
export function carveJson(result: CarveAdviseResult): CarveJsonReport {
  const results = result.results ?? [];
  const counts = Object.fromEntries(
    BAND_ORDER.map((b) => [b, results.filter((r) => r.band === b).length]),
  );
  return {
    version: CARVE_REPORT_VERSION,
    from: result.from,
    advisory: "read-only — emits nothing, patches nothing, touches no live resource",
    count: results.length,
    bands: counts,
    resources: results.map((r) => withBoundary(r, result.graph)),
  };
}

/** A scored resource plus its carve boundary, when the graph is at hand (#1636). */
function withBoundary(r: Peelability, graph?: TfGraph): CarveJsonResource {
  if (!graph) return r;
  const report = boundaryReport(graph, r.address);
  if (!report) return r;
  return { ...r, boundary: { inbound: report.inbound, outbound: report.outbound } };
}

/** Human-readable banded, ranked summary. */
export function formatCarveReport(result: CarveAdviseResult): string {
  const results = result.results ?? [];
  if (results.length === 0) {
    return `No carvable resources found in ${result.from}\n(only data sources, providers, or unsupported types were present).`;
  }

  const lines: string[] = [];
  lines.push(`Terraform carve-out advisory for ${result.from}`);
  lines.push(`  ${results.length} resource(s)/module(s) scored. Advises only — nothing is emitted or changed.`);
  lines.push("");

  for (const band of BAND_ORDER) {
    const inBand = results.filter((r) => r.band === band);
    if (inBand.length === 0) continue;
    lines.push(`${bandLabel(band)}  (${inBand.length})`);
    for (const r of inBand) {
      const target = r.mapsTo ? ` -> ${r.mapsTo}` : "";
      lines.push(`  ${String(r.score).padStart(3)}  ${r.address}${target}`);
      lines.push(`       ${reasons(r)}`);
    }
    lines.push("");
  }

  lines.push("Bands: 80-100 carve now | 50-79 carve with boundary edits | 0-49 leave in Terraform");
  return lines.join("\n").trimEnd();
}

function bandLabel(band: PeelabilityBand): string {
  switch (band) {
    case "clean leaf":
      return "CLEAN LEAF — carve now";
    case "carvable w/ edits":
      return "CARVABLE — has boundary work";
    case "leave in Terraform":
      return "LEAVE IN TERRAFORM";
  }
}

/** One-line explanation of what drove a score, from its breakdown. */
function reasons(r: Peelability): string {
  const b = r.breakdown;
  if (b.tier === null) return "no known native mapping (unsupported provider/type)";
  const parts: string[] = [];
  if (b.inbound) parts.push(`${b.inbound} inbound (data-source patch each)`);
  if (b.outbound) parts.push(`${b.outbound} outbound (deferred input each)`);
  if (b.tier > 1) parts.push(`tier ${b.tier} map`);
  if (b.hasDynamic) parts.push("count/for_each/data present");
  if (b.instances > 1) parts.push(`${b.instances} instances`);
  return parts.length ? parts.join(", ") : "clean 1:1 native map, no boundary edges";
}
