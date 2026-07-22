/**
 * `chant carve bridge` — the boundary-bridging step of the strangler-fig carve
 * (#197). Generates the edits to the surviving Terraform (data sources +
 * rewired references), records the deferred deploy-time inputs, and writes a
 * reversible handoff runbook.
 *
 * Safe by default: writes proposed files to an output directory for review.
 * `--apply-rewrites` writes the rewritten survivor `.tf` back in place — an
 * opt-in mutation of your Terraform, never the default.
 */

import { existsSync, statSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join, basename } from "path";
import { parseTerraformDir, Hcl2JsonNotInstalled } from "../../terraform/parse";
import { boundaryReport } from "../../terraform/carve";
import { generateBridge, type BridgePlan, type CarvedIdentity } from "../../terraform/bridge";
import { IDENTITY_ATTR } from "../../terraform/tier-map";

export interface CarveBridgeOptions {
  from?: string;
  select?: string;
  statePath?: string;
  /** Output directory for proposed files (default `<from>/carveout`). */
  output?: string;
  /** Write rewritten survivor `.tf` back in place instead of to the output dir. */
  applyRewrites?: boolean;
}

export interface CarveBridgeResult {
  ok: boolean;
  error?: string;
  plan?: BridgePlan;
  /** Absolute paths written. */
  written?: string[];
  /** True if survivor files were edited in place. */
  appliedInPlace?: boolean;
}

function listTfFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".tf"))
    .map((f) => join(dir, f))
    .sort();
}

export async function carveBridge(opts: CarveBridgeOptions): Promise<CarveBridgeResult> {
  if (!opts.from) return { ok: false, error: "chant carve bridge requires --from <terraform-dir>" };
  if (!opts.select) return { ok: false, error: "chant carve bridge requires --select <tf-address>" };
  if (!existsSync(opts.from) || !statSync(opts.from).isDirectory()) {
    return { ok: false, error: `Not a directory: ${opts.from}` };
  }

  let plan: BridgePlan;
  try {
    const graph = await parseTerraformDir(opts.from, { statePath: opts.statePath });
    const report = boundaryReport(graph, opts.select);
    if (!report) return { ok: false, error: `${opts.select} not found in ${opts.from}` };

    // Physical identities for the carved resources, for the data sources.
    const identities = new Map<string, CarvedIdentity>();
    for (const node of graph.nodes) {
      if (node.type && node.identity) {
        identities.set(node.address, { attr: IDENTITY_ATTR[node.type], value: node.identity });
      }
    }

    const files = listTfFiles(opts.from).map((path) => ({ path, content: readFileSync(path, "utf-8") }));
    plan = generateBridge(report, files, identities);
  } catch (err) {
    if (err instanceof Hcl2JsonNotInstalled) return { ok: false, error: err.message };
    return { ok: false, error: `Failed to build the bridge: ${err instanceof Error ? err.message : String(err)}` };
  }

  const slug = opts.select.replace(/[^A-Za-z0-9_]+/g, "-");
  const outDir = opts.output ?? join(opts.from, "carveout");
  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];

  // Runbook.
  const runbookPath = join(outDir, `${slug}-runbook.md`);
  writeFileSync(runbookPath, plan.runbook + "\n");
  written.push(runbookPath);

  // Data sources for the survivors to read.
  if (plan.dataSources.length) {
    const dsPath = join(outDir, `${slug}-datasources.tf`);
    writeFileSync(dsPath, plan.dataSources.map((d) => d.hcl).join("\n\n") + "\n");
    written.push(dsPath);
  }

  // Rewritten survivors: in place (opt-in) or proposed into the output dir.
  const changed = plan.rewrites.filter((r) => r.changed);
  for (const r of changed) {
    if (opts.applyRewrites) {
      writeFileSync(r.path, r.rewritten);
      written.push(r.path);
    } else {
      const proposed = join(outDir, basename(r.path));
      writeFileSync(proposed, r.rewritten);
      written.push(proposed);
    }
  }

  return { ok: true, plan, written, appliedInPlace: opts.applyRewrites && changed.length > 0 };
}

export function formatCarveBridge(result: CarveBridgeResult): string {
  if (!result.ok || !result.plan) return result.error ?? "carve bridge failed";
  const p = result.plan;
  const L: string[] = [];
  L.push(`Boundary bridge for ${p.target}:`);
  if (p.dataSources.length) {
    L.push(`  ${p.dataSources.length} data source(s) for survivors to read:`);
    for (const d of p.dataSources) L.push(`    data.${d.type}.${d.name}  (was ${d.address})`);
  } else {
    L.push("  no inbound edges — no survivor patch needed.");
  }
  const changed = p.rewrites.filter((r) => r.changed);
  if (changed.length) {
    L.push(`  ${changed.length} survivor file(s) rewired: ${changed.map((r) => basename(r.path)).join(", ")}`);
  }
  if (p.deferredInputs.length) {
    L.push(`  ${p.deferredInputs.length} deferred deploy-time input(s) (wired at apply):`);
    for (const d of p.deferredInputs) L.push(`    - ${d.note}`);
  }
  L.push("");
  if (result.appliedInPlace) {
    L.push("Rewritten survivor Terraform in place. Review with `git diff`, then `terraform plan`.");
  } else {
    L.push(`Wrote proposals to ${result.written?.[0] ? result.written[0].replace(/[^/]+$/, "") : "the output dir"} — review, then apply. Nothing in your Terraform changed.`);
  }
  L.push("See the runbook for the reversible, observe-first handoff steps.");
  return L.join("\n");
}
