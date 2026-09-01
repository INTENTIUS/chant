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

import { existsSync, statSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { cdkNotSupported, isCloudAssembly } from "../../cdk/assembly";
import { parseTerraformDir, Hcl2JsonNotInstalled } from "../../terraform/parse";
import { boundaryReport } from "../../terraform/carve";
import { graduationPlan, stampOwnershipIntoSource, type GraduationPlan } from "../../terraform/graduate";
import { resolveCarveManifest, resolveManifestFilePath, updateCarveManifest } from "../../terraform/manifest";
import { resolveEmitProvider } from "../../terraform/carve-provider";

export interface CarveApplyOptions {
  from?: string;
  /** Optional when the output dir holds a single carve manifest from `carve emit`. */
  select?: string;
  env?: string;
  stack?: string;
  statePath?: string;
  output?: string;
  /** Write the graduation doc to the output dir. */
  write?: boolean;
  /** Stamp the ownership marker into the emitted chant source. */
  writeSource?: boolean;
}

export interface CarveApplyResult {
  ok: boolean;
  error?: string;
  plan?: GraduationPlan;
  written?: string;
  /** Emitted source files the ownership marker was stamped into. */
  stamped?: string[];
  /** The carve state manifest this graduation was recorded into. */
  manifestPath?: string;
  /** True when the target came from the manifest, not --select. */
  selectFromManifest?: boolean;
}

export async function carveApply(opts: CarveApplyOptions): Promise<CarveApplyResult> {
  if (!opts.from) return { ok: false, error: "chant carve apply requires --from <terraform-dir>" };
  if (!existsSync(opts.from) || !statSync(opts.from).isDirectory()) {
    return { ok: false, error: `Not a directory: ${opts.from}` };
  }
  if (isCloudAssembly(opts.from)) return { ok: false, error: cdkNotSupported(opts.from, "apply") };

  // Compose with the manifest emit/bridge persisted: it supplies the target
  // (and tfstate) when --select is absent, and its persisted boundary stands in
  // when the carved block is already excised from the estate.
  const outDir = opts.output ?? join(opts.from, "carveout");
  const resolved = resolveCarveManifest(outDir, opts.select);
  if (!opts.select && resolved.error) return { ok: false, error: resolved.error };
  const select = opts.select ?? resolved.manifest!.target;
  const statePath = opts.statePath ?? resolved.manifest?.statePath;

  let plan: GraduationPlan;
  try {
    const graph = await parseTerraformDir(opts.from, { statePath });
    const report = boundaryReport(graph, select) ?? resolved.manifest?.boundary ?? null;
    if (!report) return { ok: false, error: `${select} not found in ${opts.from}` };
    // The carved type decides what the apply step even looks like: a
    // CloudFormation deploy for aws, a cluster apply for k8s (#999). The
    // manifest records the type; the graph has it when there is no manifest.
    const tfType = resolved.manifest?.tfType ?? graph.nodes.find((n) => n.address === select)?.type;
    const lexicon = tfType ? resolveEmitProvider(tfType)?.lexicon : undefined;
    plan = graduationPlan(report, { stack: opts.stack, env: opts.env, lexicon });
  } catch (err) {
    if (err instanceof Hcl2JsonNotInstalled) return { ok: false, error: err.message };
    return { ok: false, error: `Failed to plan graduation: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Stamp the marker into the emitted source (`--write-source`) — the emitted
  // files are known from the manifest, so the tags the plan promises are the
  // tags the source actually carries into the apply.
  let stamped: string[] | undefined;
  if (opts.writeSource) {
    // Manifest paths are relative to the manifest's own directory (#2039);
    // resolve them back to real files (absolute version-1 entries pass through).
    const files = (resolved.manifest?.emit?.files ?? []).map((f) => resolveManifestFilePath(outDir, f));
    if (files.length === 0) {
      return {
        ok: false,
        error: "--write-source needs the emitted source recorded in the carve manifest — run `chant carve emit` first.",
      };
    }
    stamped = [];
    for (const file of files) {
      if (!existsSync(file)) return { ok: false, error: `Emitted source not found: ${file}` };
      const result = stampOwnershipIntoSource(readFileSync(file, "utf-8"), plan.ownershipTags);
      if (!result) {
        return {
          ok: false,
          error:
            `No constructor to stamp in ${file}. Tag-based ownership is a property of a native constructor call; ` +
            `on a Kubernetes object the marker is a label the k8s build merges in (defaultLabels), not a tag in the ` +
            `emitted source. Re-run without --write-source to get the marker and the graduation plan.`,
        };
      }
      if (result.changed) writeFileSync(file, result.content);
      stamped.push(file);
    }
  }

  let written: string | undefined;
  if (opts.write) {
    mkdirSync(outDir, { recursive: true });
    const slug = select.replace(/[^A-Za-z0-9_]+/g, "-");
    written = join(outDir, `${slug}-graduation.md`);
    writeFileSync(written, renderGraduationDoc(plan) + "\n");
  }

  // Record the graduation into an existing manifest; never create one here —
  // plan-only stays plan-only unless a carve flow is already in progress.
  const manifestPath = updateCarveManifest(outDir, select, {
    apply: { marker: plan.marker, ownershipTags: plan.ownershipTags, stampedFiles: stamped, at: new Date().toISOString() },
  });

  return { ok: true, plan, written, stamped, manifestPath, selectFromManifest: !opts.select };
}

function renderGraduationDoc(plan: GraduationPlan): string {
  const L: string[] = [];
  L.push(`# Apply graduation: ${plan.target}`);
  L.push("");
  L.push(`Ownership marker: stack=${plan.marker.stack}${plan.marker.env ? `, env=${plan.marker.env}` : ""}`);
  L.push("");
  L.push(`## Ownership ${plan.markerKind} (stamped on apply so chant owns the resource)`);
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
  L.push(`Apply graduation for ${p.target} (dial-turn: observe → apply)${result.selectFromManifest ? " — target from the carve manifest" : ""}.`);
  L.push(`  Ownership marker: stack=${p.marker.stack}${p.marker.env ? `, env=${p.marker.env}` : ""}`);
  L.push(`  Ownership ${p.markerKind} (stamped on apply):`);
  for (const [k, v] of Object.entries(p.ownershipTags)) L.push(`    ${k} = ${v}`);
  L.push("");
  for (const s of p.steps) L.push(`  ${s}`);
  if (p.warnings.length) {
    L.push("");
    for (const w of p.warnings) L.push(`  ! ${w}`);
  }
  L.push("");
  if (result.stamped?.length) {
    L.push(`Stamped the ownership marker into: ${result.stamped.join(", ")}`);
  }
  if (result.written) {
    L.push(`Wrote graduation doc: ${result.written}`);
  } else if (!result.stamped?.length) {
    L.push("Plan only — no cloud call, nothing written. The apply is your lifecycle (BYOL). Add --write to save this as a doc.");
  }
  if (result.manifestPath) {
    L.push(`Recorded in the carve manifest: ${result.manifestPath}`);
  }
  return L.join("\n");
}
