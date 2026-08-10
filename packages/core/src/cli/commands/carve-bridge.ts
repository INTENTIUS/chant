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
import { join, basename, relative, resolve } from "path";
import { parseTerraformDir, Hcl2JsonNotInstalled } from "../../terraform/parse";
import { boundaryReport, type CarveReport } from "../../terraform/carve";
import { generateBridge, type BridgePlan, type CarvedIdentity } from "../../terraform/bridge";
import { IDENTITY_ATTR } from "../../terraform/tier-map";
import { resolveCarveManifest, writeCarveManifest, type CarveManifest } from "../../terraform/manifest";
import { newFileDiff, unifiedDiff } from "../../terraform/unified-diff";

export interface CarveBridgeOptions {
  from?: string;
  /** Optional when the output dir holds a single carve manifest from `carve emit`. */
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
  /** The git-applyable `.patch` carrying the whole survivor edit. */
  patchPath?: string;
  /** The carve state manifest this bridge composed with / recorded into. */
  manifestPath?: string;
  /** True when the target came from the manifest, not --select. */
  selectFromManifest?: boolean;
}

function listTfFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".tf"))
    .map((f) => join(dir, f))
    .sort();
}

export async function carveBridge(opts: CarveBridgeOptions): Promise<CarveBridgeResult> {
  if (!opts.from) return { ok: false, error: "chant carve bridge requires --from <terraform-dir>" };
  if (!existsSync(opts.from) || !statSync(opts.from).isDirectory()) {
    return { ok: false, error: `Not a directory: ${opts.from}` };
  }

  // Compose with the carve state manifest `carve emit` persisted: without
  // --select it supplies the target (and tfstate), with it it is updated below.
  const outDir = opts.output ?? join(opts.from, "carveout");
  const resolved = resolveCarveManifest(outDir, opts.select);
  if (!opts.select && resolved.error) return { ok: false, error: resolved.error };
  const select = opts.select ?? resolved.manifest!.target;
  const statePath = opts.statePath ?? resolved.manifest?.statePath;

  let plan: BridgePlan;
  let report: CarveReport;
  try {
    const graph = await parseTerraformDir(opts.from, { statePath });
    const found = boundaryReport(graph, select);
    if (!found) return { ok: false, error: `${select} not found in ${opts.from}` };
    report = found;

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

  const slug = select.replace(/[^A-Za-z0-9_]+/g, "-");
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

  // The whole survivor edit as one git-applyable patch: the data-source file as
  // a new file, plus the rewired references — `cd <from> && git apply <patch>`.
  let patchPath: string | undefined;
  if (plan.dataSources.length || changed.length) {
    const chunks: string[] = [];
    if (plan.dataSources.length) {
      chunks.push(newFileDiff(`${slug}-datasources.tf`, plan.dataSources.map((d) => d.hcl).join("\n\n") + "\n"));
    }
    for (const r of changed) {
      chunks.push(unifiedDiff(relative(opts.from, r.path), r.original, r.rewritten));
    }
    patchPath = join(outDir, `${slug}-bridge.patch`);
    writeFileSync(patchPath, chunks.join(""));
    written.push(patchPath);
  }

  // Record the bridge into the manifest (create one on a standalone bridge),
  // so `carve apply` composes with this step too.
  const applied = Boolean(opts.applyRewrites) && changed.length > 0;
  const manifest: CarveManifest = resolved.manifest ?? {
    version: 1,
    target: select,
    from: resolve(opts.from),
    statePath: statePath ? resolve(statePath) : undefined,
    boundary: report,
  };
  manifest.boundary = report;
  manifest.bridge = {
    written: written.map((w) => resolve(w)),
    appliedInPlace: applied,
    patch: patchPath ? resolve(patchPath) : undefined,
    excised: plan.excised.length ? plan.excised : undefined,
    at: new Date().toISOString(),
  };
  const manifestPath = writeCarveManifest(outDir, manifest);

  return {
    ok: true,
    plan,
    written,
    appliedInPlace: applied,
    patchPath,
    manifestPath,
    selectFromManifest: !opts.select,
  };
}

export function formatCarveBridge(result: CarveBridgeResult): string {
  if (!result.ok || !result.plan) return result.error ?? "carve bridge failed";
  const p = result.plan;
  const L: string[] = [];
  L.push(`Boundary bridge for ${p.target}${result.selectFromManifest ? " (target from the carve manifest)" : ""}:`);
  if (p.dataSources.length) {
    L.push(`  ${p.dataSources.length} data source(s) for survivors to read:`);
    for (const d of p.dataSources) L.push(`    data.${d.type}.${d.name}  (was ${d.address})`);
  } else {
    L.push("  no inbound edges — nothing reads the carved resource, no data source needed.");
  }
  if (p.excised.length) {
    L.push(`  carved block(s) excised from the survivor source: ${p.excised.join(", ")}`);
  }
  const changed = p.rewrites.filter((r) => r.changed);
  if (changed.length) {
    L.push(`  ${changed.length} survivor file(s) rewired: ${changed.map((r) => basename(r.path)).join(", ")}`);
  }
  if (p.outputRewrites.length) {
    L.push(`  ${p.outputRewrites.length} output block(s) repointed at the data source: ${p.outputRewrites.join(", ")}`);
  }
  if (p.deferredInputs.length) {
    L.push(`  ${p.deferredInputs.length} deferred deploy-time input(s) (wired at apply):`);
    for (const d of p.deferredInputs) L.push(`    - ${d.note}`);
  }
  L.push("");
  if (result.patchPath && !result.appliedInPlace) {
    L.push(`One git-applyable patch carries the whole edit: git apply --directory=<terraform-dir> ${resolve(result.patchPath)}`);
    L.push("  (--directory is the Terraform dir relative to your repo root; plain `git apply` from the dir works outside a repo.)");
  }
  if (result.appliedInPlace) {
    L.push("Rewritten survivor Terraform in place. Review with `git diff`, then `terraform plan`.");
  } else {
    L.push(`Wrote proposals to ${result.written?.[0] ? result.written[0].replace(/[^/]+$/, "") : "the output dir"} — review, then apply. Nothing in your Terraform changed.`);
  }
  L.push("See the runbook for the reversible, observe-first handoff steps.");
  return L.join("\n");
}
