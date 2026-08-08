/**
 * Thin wasm glue for the carve-out advisor (#214 T1): read a Terraform estate's
 * `.tf` files, run them through `@cdktf/hcl2json`, merge into one tree, and hand
 * off to the pure `buildGraph`.
 *
 * `@cdktf/hcl2json` is NOT a chant dependency — it carries a ~1.8 MB wasm blob
 * and only carve-out users need it. It is lazy-loaded here and, if absent, the
 * advisor fails with a one-line install hint.
 */

import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { buildGraph, collectExpressions, type ExpressionRefs } from "./graph";
import { readStateInstanceCounts, applyStateCounts } from "./state";
import type { Hcl2JsonTree, TfGraph } from "./types";

/** Minimal shape of the parser exports we depend on. */
export interface Hcl2Json {
  parse: (filename: string, hcl: string) => Promise<Hcl2JsonTree>;
  /** Expression-AST reference extraction (#998) — one traversal accessor per reference. */
  getReferencesInExpression: (filename: string, expression: string) => Promise<Array<{ value: string }>>;
}

export class Hcl2JsonNotInstalled extends Error {
  constructor(cause: unknown) {
    super(
      "Terraform carve-out needs the HCL parser, which is not installed.\n" +
        "  Install it once:  npm install -D @cdktf/hcl2json\n" +
        `(underlying error: ${cause instanceof Error ? cause.message : String(cause)})`,
    );
    this.name = "Hcl2JsonNotInstalled";
  }
}

/**
 * Lazy-load the optional HCL parser. Throws `Hcl2JsonNotInstalled` with an
 * install hint when the package is missing, rather than a raw MODULE_NOT_FOUND.
 */
export async function loadHcl2json(): Promise<Hcl2Json> {
  try {
    return (await import("@cdktf/hcl2json")) as Hcl2Json;
  } catch (err) {
    throw new Hcl2JsonNotInstalled(err);
  }
}

/**
 * Resolve every interpolated string in the merged tree through the parser's
 * expression AST (`getReferencesInExpression`), producing the accessor map
 * `buildGraph` classifies. The AST — not a regex over the expression body —
 * decides what is a reference, so a quoted address used as a map key or an
 * escaped `$${...}` literal yields none. An expression the AST cannot parse in
 * isolation resolves to no references (fewer edges, never a phantom one).
 */
async function resolveExpressionRefs(hcl2json: Hcl2Json, tree: Hcl2JsonTree): Promise<ExpressionRefs> {
  const refs = new Map<string, string[]>();
  for (const expr of collectExpressions(tree)) {
    try {
      const found = await hcl2json.getReferencesInExpression("expression.tf", expr);
      refs.set(
        expr,
        found.map((r) => r.value),
      );
    } catch {
      refs.set(expr, []);
    }
  }
  return refs;
}

/** Deep-merge hcl2json trees across files (resource/module/data namespaces). */
function mergeTrees(into: Hcl2JsonTree, next: Hcl2JsonTree): void {
  for (const section of ["resource", "data"] as const) {
    const src = next[section];
    if (!src) continue;
    const dst = (into[section] ??= {}) as Record<string, Record<string, unknown[]>>;
    for (const [type, named] of Object.entries(src)) {
      dst[type] = { ...(dst[type] ?? {}), ...named };
    }
  }
  if (next.module) into.module = { ...(into.module ?? {}), ...next.module };
}

/** List every `.tf` file directly under `dir` (non-recursive; matches Terraform's own module scoping). */
function listTfFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".tf"))
    .map((f) => join(dir, f))
    .sort();
}

export interface ParseTerraformOptions {
  /** Opt-in `.tfstate` path (#214 T2): overlays state-expanded instance counts. */
  statePath?: string;
}

/**
 * Parse a Terraform directory into a dependency graph. Reads only `.tf` unless
 * `statePath` is given. Pure `.tf` estates parse fully; `count`/`for_each`
 * blocks report a single instance and are flagged `hasDynamic`. With state, the
 * instance counts become accurate (see `state.ts`).
 */
export async function parseTerraformDir(dir: string, opts: ParseTerraformOptions = {}): Promise<TfGraph> {
  const hcl2json = await loadHcl2json();
  const files = listTfFiles(dir);
  const merged: Hcl2JsonTree = {};
  for (const file of files) {
    const tree = await hcl2json.parse(file, readFileSync(file, "utf-8"));
    mergeTrees(merged, tree);
  }
  const graph = buildGraph(merged, await resolveExpressionRefs(hcl2json, merged));
  if (opts.statePath) applyStateCounts(graph, readStateInstanceCounts(opts.statePath));
  return graph;
}
