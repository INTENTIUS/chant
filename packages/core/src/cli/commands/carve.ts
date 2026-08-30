/**
 * `chant carve advise` — the read-only peelability advisor (#214, #1056).
 *
 * Points at foreign infrastructure and reports which pieces are cheap to carve
 * into native chant later and which should stay where they are. It emits
 * nothing, patches nothing, and touches no live resource — pure analysis. The
 * emit/boundary/apply phases (`carve emit|bridge|apply`, #197) read Terraform
 * only, and refuse a cloud assembly by name.
 *
 * Two sources, one report. A Terraform estate is parsed from `.tf`; a CDK cloud
 * assembly is read from `cdk.out` (#1056). Which one is in `--from` is decided
 * by looking, not by a second flag: a directory holding `manifest.json` plus a
 * synthesized `*.template.json` is an assembly. Both produce the same bands,
 * the same score arithmetic, and the same JSON shape.
 */

import { existsSync, statSync, writeFileSync } from "fs";
import { adviseCloudAssembly, CDK_DIALECT } from "../../cdk/advise";
import { isCloudAssembly } from "../../cdk/assembly";
import { parseTerraformDir, Hcl2JsonNotInstalled } from "../../terraform/parse";
import { scoreEstate, type Peelability, type PeelabilityBand, type ScoreOptions } from "../../terraform/score";
import { boundaryReport, type BoundaryEdge, type CarveDialect } from "../../terraform/carve";
import type { TfGraph } from "../../terraform/types";

export interface CarveAdviseOptions {
  /** Terraform estate directory or CDK cloud assembly (from `--from`). */
  from?: string;
  /** Opt-in `.tfstate` path (from `--state`): accurate fan-out instance counts. */
  statePath?: string;
  /** Write the full JSON report to this path (from `--report <path>`). */
  reportFile?: string;
}

/**
 * Which source the ranking came from. Terraform addresses and CDK construct
 * paths are different namespaces, and the bridge patches have different names,
 * so a report says which it is rather than leaving a reader to guess from the
 * shape of an address.
 */
export type CarveSource = "terraform" | "cdk";

export interface CarveAdviseResult {
  ok: boolean;
  error?: string;
  from?: string;
  source?: CarveSource;
  results?: Peelability[];
  /**
   * The parsed dependency graph the scores came from. Kept so the JSON report
   * can carry the boundary edge lists (#1636) rather than only their counts.
   * Not part of the JSON payload — `carveJson` derives from it.
   */
  graph?: TfGraph;
  /** The hooks the scores were produced with, so the boundary pass agrees. */
  scoreOptions?: ScoreOptions;
  /** Anything about the read itself worth saying out loud. */
  diagnostics?: string[];
}

const BAND_ORDER: PeelabilityBand[] = ["clean leaf", "carvable w/ edits", "leave in Terraform"];

export async function carveAdvise(opts: CarveAdviseOptions): Promise<CarveAdviseResult> {
  if (!opts.from) {
    return { ok: false, error: "chant carve advise requires --from <terraform-dir | cdk.out>" };
  }
  if (!existsSync(opts.from) || !statSync(opts.from).isDirectory()) {
    return { ok: false, error: `Not a directory: ${opts.from}` };
  }

  const result = isCloudAssembly(opts.from) ? adviseCdk(opts) : await adviseTerraform(opts);
  if (result.ok && opts.reportFile) {
    writeFileSync(opts.reportFile, JSON.stringify(carveJson(result), null, 2));
  }
  return result;
}

/** Rank a CDK cloud assembly. No parser to install, no state file to read. */
function adviseCdk(opts: CarveAdviseOptions): CarveAdviseResult {
  if (opts.statePath) {
    return {
      ok: false,
      error:
        `${opts.from} is a CDK cloud assembly, and --state is a Terraform option. ` +
        "A synthesized template already carries its own instance counts.",
    };
  }
  try {
    const advice = adviseCloudAssembly(opts.from!);
    return {
      ok: true,
      from: opts.from,
      source: "cdk",
      results: advice.results,
      graph: advice.graph,
      scoreOptions: advice.scoreOptions,
      diagnostics: advice.diagnostics,
    };
  } catch (err) {
    return {
      ok: false,
      error: `Failed to read the CDK cloud assembly in ${opts.from}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function adviseTerraform(opts: CarveAdviseOptions): Promise<CarveAdviseResult> {
  if (opts.statePath && !existsSync(opts.statePath)) {
    return { ok: false, error: `State file not found: ${opts.statePath}` };
  }
  try {
    const graph = await parseTerraformDir(opts.from!, { statePath: opts.statePath });
    return { ok: true, from: opts.from, source: "terraform", results: scoreEstate(graph), graph };
  } catch (err) {
    if (err instanceof Hcl2JsonNotInstalled) return { ok: false, error: err.message };
    return { ok: false, error: `Failed to parse Terraform in ${opts.from}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * The schema version of the `--json` / `--report` payload (#1636).
 *
 * The report is a cross-tool contract — behold renders it as a graph — so it
 * says which shape it is. The promise attached to this number:
 *
 *  - **Additive within a version.** New top-level fields, new per-resource
 *    fields, new kinds of entry in an existing list, and new values in an
 *    open-ended enum (a `bridge` kind, say) may appear in any release. A
 *    reader must ignore keys and values it does not know.
 *  - **A removal, a rename, or a changed meaning bumps it.** So does narrowing
 *    a field's type (an optional becoming required is additive; the reverse is
 *    not).
 *  - A reader that does not know the version it is handed should refuse the
 *    report rather than half-read it.
 *
 * The CDK source (#1056) stays inside that promise and does not bump the
 * version. Every field an existing reader keys on keeps its type and meaning:
 * `address` is still an opaque string identifier (a construct path instead of a
 * Terraform address), `kind` is still `"resource"` or `"module"` (an L3
 * construct subtree is a Composite candidate, which is what `module` already
 * means), `score`/`band`/`breakdown` are the same arithmetic. What is new is
 * additive and ignorable: the top-level `source` discriminator, per-resource
 * `notes` and `members`, and two more `bridge` values in a list that was
 * already declared open-ended.
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
   * An inbound edge's survivor can be an `output.<name>` pseudo-address
   * (#1638), carrying `bridge: "tf-output-rewrite"` and `via: ["value"]`. It
   * is counted in `breakdown.outputs`, not `breakdown.inbound`.
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
  /**
   * Which source was read (#1056). `terraform` — addresses are Terraform
   * addresses, bridges are `data` sources. `cdk` — addresses are construct
   * paths and bridges are reimports. Absent on a chant that predates the CDK
   * advisor, which a reader should take as `terraform`.
   */
  source: CarveSource;
  advisory: string;
  count: number;
  /** Band name -> how many resources landed in it. */
  bands: Record<string, number>;
  /**
   * Anything about the read the scores alone do not say — a missing `tree.json`,
   * an assembly synthesized from unresolved context lookups. Present only when
   * there is something to report.
   */
  diagnostics?: string[];
  resources: CarveJsonResource[];
}

/** Build the `--json` / `--report` payload. */
export function carveJson(result: CarveAdviseResult): CarveJsonReport {
  const results = result.results ?? [];
  const counts = Object.fromEntries(
    BAND_ORDER.map((b) => [b, results.filter((r) => r.band === b).length]),
  );
  const source = result.source ?? "terraform";
  const dialect: CarveDialect = source === "cdk" ? CDK_DIALECT : "terraform";
  return {
    version: CARVE_REPORT_VERSION,
    from: result.from,
    source,
    advisory: "read-only — emits nothing, patches nothing, touches no live resource",
    count: results.length,
    bands: counts,
    ...(result.diagnostics?.length ? { diagnostics: result.diagnostics } : {}),
    resources: results.map((r) => withBoundary(r, result.graph, dialect, result.scoreOptions)),
  };
}

/** A scored resource plus its carve boundary, when the graph is at hand (#1636). */
function withBoundary(
  r: Peelability,
  graph: TfGraph | undefined,
  dialect: CarveDialect,
  score: ScoreOptions | undefined,
): CarveJsonResource {
  if (!graph) return r;
  const report = boundaryReport(graph, r.address, { dialect, score });
  if (!report) return r;
  return { ...r, boundary: { inbound: report.inbound, outbound: report.outbound } };
}

/** Human-readable banded, ranked summary. */
export function formatCarveReport(result: CarveAdviseResult): string {
  const results = result.results ?? [];
  const source = result.source ?? "terraform";
  const cdk = source === "cdk";

  if (results.length === 0) {
    return cdk
      ? `No carvable constructs found in ${result.from}\n(the assembly synthesized no infrastructure beyond CDK's own scaffolding).`
      : `No carvable resources found in ${result.from}\n(only data sources, providers, or unsupported types were present).`;
  }

  const lines: string[] = [];
  lines.push(`${cdk ? "CDK cloud-assembly" : "Terraform"} carve-out advisory for ${result.from}`);
  lines.push(
    `  ${results.length} ${cdk ? "construct(s)" : "resource(s)/module(s)"} scored. ` +
      "Advises only — nothing is emitted or changed.",
  );
  for (const note of result.diagnostics ?? []) lines.push(`  ! ${note}`);
  lines.push("");

  for (const band of BAND_ORDER) {
    const inBand = results.filter((r) => r.band === band);
    if (inBand.length === 0) continue;
    lines.push(`${bandLabel(band, cdk)}  (${inBand.length})`);
    for (const r of inBand) {
      const target = r.mapsTo ? ` -> ${r.mapsTo}` : "";
      lines.push(`  ${String(r.score).padStart(3)}  ${r.address}${target}`);
      lines.push(`       ${reasons(r, cdk)}`);
      for (const note of r.notes ?? []) lines.push(`       ${note}`);
    }
    lines.push("");
  }

  lines.push(
    `Bands: 80-100 carve now | 50-79 carve with boundary edits | 0-49 leave in ${cdk ? "CDK" : "Terraform"}`,
  );
  return lines.join("\n").trimEnd();
}

function bandLabel(band: PeelabilityBand, cdk: boolean): string {
  switch (band) {
    case "clean leaf":
      return "CLEAN LEAF — carve now";
    case "carvable w/ edits":
      return "CARVABLE — has boundary work";
    case "leave in Terraform":
      // The band's name is part of the JSON contract and does not change per
      // source; only the heading a person reads does.
      return cdk ? "LEAVE IN CDK" : "LEAVE IN TERRAFORM";
  }
}

/** One-line explanation of what drove a score, from its breakdown. */
function reasons(r: Peelability, cdk = false): string {
  const b = r.breakdown;
  if (b.tier === null) {
    return cdk ? "no chant AWS lexicon target for this type" : "no known native mapping (unsupported provider/type)";
  }
  // A node that scored 0 with every penalty at 0 was disqualified outright, not
  // scored down. Reciting the arithmetic would credit terms that never applied;
  // the stated reason follows on the next line.
  if (r.score === 0 && Object.values(b.penalties).every((p) => p === 0)) return "not carvable as it stands";
  const parts: string[] = [];
  if (b.inbound) parts.push(`${b.inbound} inbound (${cdk ? "a reimport each" : "data-source patch each"})`);
  if (b.outputs) parts.push(`${b.outputs} ${cdk ? "stack output(s)" : "output block(s)"} reading it (one-line rewrite each)`);
  if (b.outbound) parts.push(`${b.outbound} outbound (deferred input each)`);
  if (b.tier > 1) parts.push(`tier ${b.tier} map`);
  if (b.hasDynamic) parts.push(cdk ? "condition/parameter present" : "count/for_each/data present");
  if (b.instances > 1) parts.push(`${b.instances} instances`);
  if (b.penalties.asset) parts.push("asset-backed");
  return parts.length ? parts.join(", ") : "clean 1:1 native map, no boundary edges";
}
