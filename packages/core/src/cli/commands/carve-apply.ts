/**
 * `chant carve apply` — apply graduation for the strangler-fig carve (#197).
 *
 * The dial-turn from observe to apply: resolve the ownership marker that makes
 * the carved resource chant-owned and finalize the ordered apply runbook.
 *
 * BYOL-honest: it does not call the cloud. It computes the marker + graduation
 * plan and (with `--write`) emits a graduation doc. The apply is whatever
 * lifecycle you brought.
 */

import { existsSync, statSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { parseTerraformDir, Hcl2JsonNotInstalled } from "../../terraform/parse";
import { boundaryReport } from "../../terraform/carve";
import { graduationPlan, type GraduationPlan } from "../../terraform/graduate";

export interface CarveApplyOptions {
  from?: string;
  select?: string;
  env?: string;
  stack?: string;
  statePath?: string;
  output?: string;
  /** Write the graduation doc to the output dir. */
  write?: boolean;
}

export interface CarveApplyResult {
  ok: boolean;
  error?: string;
  plan?: GraduationPlan;
  written?: string;
}

export async function carveApply(opts: CarveApplyOptions): Promise<CarveApplyResult> {
  if (!opts.from) return { ok: false, error: "chant carve apply requires --from <terraform-dir>" };
  if (!opts.select) return { ok: false, error: "chant carve apply requires --select <tf-address>" };
  if (!existsSync(opts.from) || !statSync(opts.from).isDirectory()) {
    return { ok: false, error: `Not a directory: ${opts.from}` };
  }

  let plan: GraduationPlan;
  try {
    const graph = await parseTerraformDir(opts.from, { statePath: opts.statePath });
    const report = boundaryReport(graph, opts.select);
    if (!report) return { ok: false, error: `${opts.select} not found in ${opts.from}` };
    plan = graduationPlan(report, { stack: opts.stack, env: opts.env });
  } catch (err) {
    if (err instanceof Hcl2JsonNotInstalled) return { ok: false, error: err.message };
    return { ok: false, error: `Failed to plan graduation: ${err instanceof Error ? err.message : String(err)}` };
  }

  let written: string | undefined;
  if (opts.write) {
    const outDir = opts.output ?? join(opts.from, "carveout");
    mkdirSync(outDir, { recursive: true });
    const slug = opts.select.replace(/[^A-Za-z0-9_]+/g, "-");
    written = join(outDir, `${slug}-graduation.md`);
    writeFileSync(written, renderGraduationDoc(plan) + "\n");
  }

  return { ok: true, plan, written };
}

function renderGraduationDoc(plan: GraduationPlan): string {
  const L: string[] = [];
  L.push(`# Apply graduation: ${plan.target}`);
  L.push("");
  L.push(`Ownership marker: stack=${plan.marker.stack}${plan.marker.env ? `, env=${plan.marker.env}` : ""}`);
  L.push("");
  L.push("## Ownership tags (stamped on apply so chant owns the resource)");
  for (const [k, v] of Object.entries(plan.ownershipTags)) L.push(`- ${k} = ${v}`);
  L.push("");
  L.push("## Steps");
  for (const s of plan.steps) L.push(s);
  if (plan.warnings.length) {
    L.push("");
    L.push("## Before you apply");
    for (const w of plan.warnings) L.push(`- ${w}`);
  }
  return L.join("\n");
}

export function formatCarveApply(result: CarveApplyResult): string {
  if (!result.ok || !result.plan) return result.error ?? "carve apply failed";
  const p = result.plan;
  const L: string[] = [];
  L.push(`Apply graduation for ${p.target} (dial-turn: observe → apply).`);
  L.push(`  Ownership marker: stack=${p.marker.stack}${p.marker.env ? `, env=${p.marker.env}` : ""}`);
  L.push("  Ownership tags (stamped on apply):");
  for (const [k, v] of Object.entries(p.ownershipTags)) L.push(`    ${k} = ${v}`);
  L.push("");
  for (const s of p.steps) L.push(`  ${s}`);
  if (p.warnings.length) {
    L.push("");
    for (const w of p.warnings) L.push(`  ! ${w}`);
  }
  L.push("");
  if (result.written) {
    L.push(`Wrote graduation doc: ${result.written}`);
  } else {
    L.push("Plan only — no cloud call, nothing written. The apply is your lifecycle (BYOL). Add --write to save this as a doc.");
  }
  return L.join("\n");
}
