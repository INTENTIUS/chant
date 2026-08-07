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
import { basename, join, resolve } from "path";
import { parseTerraformDir, Hcl2JsonNotInstalled } from "../../terraform/parse";
import { boundaryReport, type CarveReport } from "../../terraform/carve";
import { resolveTier } from "../../terraform/tier-map";
import { readStateResource } from "../../terraform/state";
import { writeCarveManifest, type CarveManifest } from "../../terraform/manifest";
import { adoptFromState, canAdoptFromState, supportedStateAdoptionTypes } from "../../terraform/adopt-state";
import { getChantVersion } from "./init";
import type { LexiconPlugin, ResourceSelector } from "../../lexicon";
import type { ImportResult, LiveImportOptions } from "./import";

export interface CarveEmitOptions {
  /** Terraform estate directory (`--from`). */
  from?: string;
  /** Terraform address to carve, e.g. `aws_s3_bucket.assets` (`--select`). */
  select?: string;
  /** Live environment to adopt from (`--env`). */
  env?: string;
  /**
   * CloudFormation logical ID to adopt on the live path (`--live-name`). The
   * live import filters a stack's template by logical ID, which is not the
   * Terraform physical name — so the live selector is by native type by
   * default, and this narrows it when a stack has several of that type.
   */
  liveName?: string;
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
  /** Project files scaffolded around the emitted source (config, package.json). */
  scaffolded?: string[];
  /** The persisted carve state manifest bridge/apply compose with. */
  manifestPath?: string;
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
  let tfType: string | undefined;
  try {
    const graph = await parseTerraformDir(opts.from, { statePath: opts.statePath });
    report = boundaryReport(graph, opts.select);
    tfType = graph.nodes.find((n) => n.address === opts.select)?.type;
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
      return {
        ok: false,
        error:
          `${tfType} cannot be adopted from state yet (no native constructor mapping).\n` +
          `Supported types: ${supportedStateAdoptionTypes().join(", ")}. ` +
          `Coverage is expanding — see chant issue #1001.`,
      };
    }
    const stateResource = readStateResource(opts.statePath, opts.select);
    if (!stateResource) {
      return { ok: false, error: `${opts.select} not found in state ${opts.statePath} (or is a data source / module-nested).` };
    }
    const adopted = adoptFromState(stateResource);
    if (!adopted) return { ok: false, error: `Could not adopt ${opts.select} from state.` };

    // The output dir is a buildable chant project: source in src/, plus the
    // config + package.json scaffold (written once, never overwritten).
    const outDir = opts.output ?? join(opts.from, "carveout");
    const srcDir = join(outDir, "src");
    mkdirSync(srcDir, { recursive: true });
    const outPath = join(srcDir, adopted.fileName);
    writeFileSync(outPath, adopted.content);
    const lexicon = tier.mapsTo.split("::")[0]?.toLowerCase() ?? "aws";
    const scaffolded = scaffoldProject(outDir, lexicon);

    const manifestPath = persistManifest(outDir, opts, report, tfType, "tfstate", [outPath]);
    return { ok: true, report, source: "tfstate", emittedFiles: [outPath], scaffolded, manifestPath };
  }

  // ── Adoption path 2: live import (cloud→code) ──
  // The live import filters a CloudFormation stack's template by logical ID, not
  // the Terraform physical name — so select by native type, narrowing to a
  // logical ID only when the caller passes --live-name (a stack with several of
  // that type). `identity` (the TF physical name) is not a valid CFN selector.
  const selector: ResourceSelector = opts.liveName
    ? { type: tier.mapsTo, name: opts.liveName }
    : { type: tier.mapsTo };

  const emit = await deps.liveImport(deps.plugins, {
    environment: opts.env!,
    selector,
    output: opts.output,
    lexicon: tier.mapsTo.split("::")[0]?.toLowerCase() === "aws" ? "aws" : undefined,
  });

  const outDir = opts.output ?? join(opts.from, "carveout");
  const manifestPath = persistManifest(outDir, opts, report, tfType, "live", emit.generatedFiles ?? []);
  return { ok: true, report, emit, selector, source: "live", emittedFiles: emit.generatedFiles, manifestPath };
}

/**
 * Scaffold the emitted source into a buildable chant project: chant.config.ts,
 * package.json, tsconfig.json — same shape `chant init` produces, so
 * `npm install && npm run build` works in the output dir as-is. Existing files
 * are never overwritten (re-emits and user edits survive).
 */
function scaffoldProject(outDir: string, lexicon: string): string[] {
  const ver = getChantVersion();
  const packageJson = {
    name: "chant-carveout",
    version: "0.1.0",
    type: "module" as const,
    scripts: {
      build: `chant build src --lexicon ${lexicon}`,
      lint: "chant lint src",
    },
    dependencies: {
      "@intentius/chant": `^${ver}`,
      [`@intentius/chant-lexicon-${lexicon}`]: `^${ver}`,
    },
    devDependencies: {
      typescript: "^5.0.0",
    },
  };
  const tsconfig = {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
    },
    include: ["src"],
    exclude: ["node_modules"],
  };
  const files: Array<[string, string]> = [
    ["package.json", JSON.stringify(packageJson, null, 2) + "\n"],
    ["chant.config.ts", `import type { ChantConfig } from "@intentius/chant";\n\nexport default {\n  lexicons: ["${lexicon}"],\n} satisfies ChantConfig;\n`],
    ["tsconfig.json", JSON.stringify(tsconfig, null, 2) + "\n"],
  ];

  const written: string[] = [];
  for (const [name, content] of files) {
    const path = join(outDir, name);
    if (existsSync(path)) continue;
    writeFileSync(path, content);
    written.push(path);
  }
  return written;
}

/** Persist the carve state manifest so bridge/apply compose with this emit. */
function persistManifest(
  outDir: string,
  opts: CarveEmitOptions,
  report: CarveReport,
  tfType: string | undefined,
  source: "tfstate" | "live",
  files: string[],
): string {
  const manifest: CarveManifest = {
    version: 1,
    target: report.target,
    tfType,
    from: resolve(opts.from!),
    statePath: opts.statePath ? resolve(opts.statePath) : undefined,
    boundary: report,
    emit: { source, files: files.map((f) => resolve(f)), at: new Date().toISOString() },
  };
  return writeCarveManifest(outDir, manifest);
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
    const named = result.selector.name ? ` (logical id "${result.selector.name}")` : "";
    lines.push(`  Adopted live as ${result.selector.type}${named}.`);
  }
  if (result.emittedFiles?.length) {
    lines.push(`  Emitted: ${result.emittedFiles.join(", ")}`);
  }
  if (result.scaffolded?.length) {
    lines.push(`  Scaffolded a buildable chant project: ${result.scaffolded.map((f) => basename(f)).join(", ")} (npm install && npm run build).`);
  }
  if (result.manifestPath) {
    lines.push(`  State manifest: ${result.manifestPath} — carve bridge/apply pick the target up from here.`);
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
