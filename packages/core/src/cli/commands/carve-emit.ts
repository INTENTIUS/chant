/**
 * `chant carve emit` — the first strangler-fig emit step (#197).
 *
 * Given a resource selected from a Terraform estate, it:
 *  1. classifies the boundary (which edges the carve cuts),
 *  2. adopts the live resource into typed chant source via live import
 *     (`chant import --from <env>` machinery — cloud→code, read-only export),
 *  3. writes a boundary report.
 *
 * It does not patch the surviving Terraform or apply anything — that is the
 * boundary-bridging and apply-graduation work (later PRs). This lands the
 * resource at the observe position: emitted, reversible, nothing mutated.
 */

import { existsSync, statSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { parseTerraformDir, Hcl2JsonNotInstalled } from "../../terraform/parse";
import { boundaryReport, type CarveReport } from "../../terraform/carve";
import { resolveTier } from "../../terraform/tier-map";
import { readStateResource } from "../../terraform/state";
import { adoptFromState, canAdoptFromState } from "../../terraform/adopt-state";
import type { LexiconPlugin, ResourceSelector } from "../../lexicon";
import type { ImportResult, LiveImportOptions } from "./import";

export interface CarveEmitOptions {
  /** Terraform estate directory (`--from`). */
  from?: string;
  /** Terraform address to carve, e.g. `aws_s3_bucket.assets` (`--select`). */
  select?: string;
  /** Live environment to adopt from (`--env`). */
  env?: string;
  /** Opt-in `.tfstate` for instance counts (`--state`). */
  statePath?: string;
  /** Output directory for the emitted source (`--output`). */
  output?: string;
  /** Write the boundary report JSON here (`--report`). */
  reportFile?: string;
}

/** Injected so tests exercise emit without cloud calls. */
export interface CarveEmitDeps {
  plugins: LexiconPlugin[];
  liveImport: (plugins: LexiconPlugin[], options: LiveImportOptions) => Promise<ImportResult>;
}

export interface CarveEmitResult {
  ok: boolean;
  error?: string;
  report?: CarveReport;
  emit?: ImportResult;
  /** The selector used for the live adoption, for transparency (cloud path). */
  selector?: ResourceSelector;
  /** How the resource was adopted. */
  source?: "tfstate" | "live";
  /** Emitted file path(s). */
  emittedFiles?: string[];
}

export async function carveEmit(opts: CarveEmitOptions, deps: CarveEmitDeps): Promise<CarveEmitResult> {
  if (!opts.from) return { ok: false, error: "chant carve emit requires --from <terraform-dir>" };
  if (!opts.select) return { ok: false, error: "chant carve emit requires --select <tf-address>" };
  // Adoption source: --state adopts offline from tfstate (correct for a
  // Terraform-managed resource); --env adopts via the live cloud import path.
  if (!opts.statePath && !opts.env) {
    return { ok: false, error: "chant carve emit requires --state <tfstate> (offline, recommended) or --env <environment>" };
  }
  if (!existsSync(opts.from) || !statSync(opts.from).isDirectory()) {
    return { ok: false, error: `Not a directory: ${opts.from}` };
  }

  let report: CarveReport | null;
  let identity: string | undefined;
  let tfType: string | undefined;
  try {
    const graph = await parseTerraformDir(opts.from, { statePath: opts.statePath });
    report = boundaryReport(graph, opts.select);
    const node = graph.nodes.find((n) => n.address === opts.select);
    identity = node?.identity;
    tfType = node?.type;
  } catch (err) {
    if (err instanceof Hcl2JsonNotInstalled) return { ok: false, error: err.message };
    return { ok: false, error: `Failed to parse Terraform in ${opts.from}: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!report) return { ok: false, error: `${opts.select} not found in ${opts.from}` };

  const tier = tfType ? resolveTier(tfType) : null;
  if (!tier) {
    return {
      ok: false,
      error: `${opts.select} (${tfType ?? "unknown type"}) has no known native mapping, so it cannot be emitted. Advisor bands it "leave in Terraform".`,
    };
  }

  if (opts.reportFile) writeFileSync(opts.reportFile, JSON.stringify(report, null, 2));

  // ── Adoption path 1: from .tfstate (offline, correct for TF-managed) ──
  if (opts.statePath) {
    if (!canAdoptFromState(tfType!)) {
      return { ok: false, error: `${tfType} cannot be adopted from state yet (no native constructor mapping).` };
    }
    const stateResource = readStateResource(opts.statePath, opts.select);
    if (!stateResource) {
      return { ok: false, error: `${opts.select} not found in state ${opts.statePath} (or is a data source / module-nested).` };
    }
    const adopted = adoptFromState(stateResource);
    if (!adopted) return { ok: false, error: `Could not adopt ${opts.select} from state.` };

    const outDir = opts.output ?? join(opts.from, "carveout");
    mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, adopted.fileName);
    writeFileSync(outPath, adopted.content);

    return { ok: true, report, source: "tfstate", emittedFiles: [outPath] };
  }

  // ── Adoption path 2: live import (cloud→code) ──
  // Build the live-import selector: native type from the tier map, physical
  // name from the HCL identity attribute (falling back to the TF logical name).
  const name = identity ?? opts.select!.split(".").slice(1).join(".");
  const selector: ResourceSelector = { type: tier.mapsTo, name };

  const emit = await deps.liveImport(deps.plugins, {
    environment: opts.env!,
    selector,
    output: opts.output,
    lexicon: tier.mapsTo.split("::")[0]?.toLowerCase() === "aws" ? "aws" : undefined,
  });

  return { ok: true, report, emit, selector, source: "live", emittedFiles: emit.generatedFiles };
}

/** Human-readable emit summary: what was adopted and what boundary work remains. */
export function formatCarveEmit(result: CarveEmitResult): string {
  if (!result.ok || !result.report) return result.error ?? "carve emit failed";
  const r = result.report;
  const lines: string[] = [];
  lines.push(`Carved ${r.target} (peelability ${r.peelability}) — observe position, reversible.`);
  if (result.source === "tfstate") {
    lines.push("  Adopted from Terraform state (offline).");
  } else if (result.selector) {
    lines.push(`  Adopted live as ${result.selector.type} "${result.selector.name}".`);
  }
  if (result.emittedFiles?.length) {
    lines.push(`  Emitted: ${result.emittedFiles.join(", ")}`);
  }
  if (r.carveSet.length > 1) {
    const folded = r.carveSet.filter((m) => m.foldedInto).map((m) => m.address);
    lines.push(`  Folded in: ${folded.join(", ")}`);
  }
  lines.push("");
  lines.push("Boundary (not yet patched — that is `carve bridge`, the next step):");
  if (r.inbound.length === 0 && r.outbound.length === 0) {
    lines.push("  none — a clean leaf, nothing depends on it and it depends on nothing.");
  }
  for (const e of r.inbound) {
    lines.push(`  inbound   ${e.survivor} reads ${e.attrs.join(", ")} → rewrite to a data source (required immediately)`);
  }
  for (const e of r.outbound) {
    lines.push(`  outbound  ${e.carved} reads ${e.survivor}.${e.attrs.join(", ")} → deferred deploy-time input (at apply)`);
  }
  if (r.diagnostics.length) {
    lines.push("");
    for (const d of r.diagnostics) lines.push(`  ! ${d}`);
  }
  return lines.join("\n");
}
