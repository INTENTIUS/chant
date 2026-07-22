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

  let results: Peelability[];
  try {
    results = scoreEstate(await parseTerraformDir(opts.from, { statePath: opts.statePath }));
  } catch (err) {
    if (err instanceof Hcl2JsonNotInstalled) return { ok: false, error: err.message };
    return { ok: false, error: `Failed to parse Terraform in ${opts.from}: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (opts.reportFile) {
    writeFileSync(opts.reportFile, JSON.stringify(carveJson({ ok: true, from: opts.from, results }), null, 2));
  }

  return { ok: true, from: opts.from, results };
}

/** The `--json` / `--report` payload. */
export function carveJson(result: CarveAdviseResult): unknown {
  const results = result.results ?? [];
  const counts = Object.fromEntries(
    BAND_ORDER.map((b) => [b, results.filter((r) => r.band === b).length]),
  );
  return {
    from: result.from,
    advisory: "read-only — emits nothing, patches nothing, touches no live resource",
    count: results.length,
    bands: counts,
    resources: results,
  };
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
