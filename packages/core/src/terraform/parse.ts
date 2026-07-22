/**
 * Thin wasm glue for the carve-out advisor (#214 T1): read a Terraform estate's
 * `.tf` files, run them through `@cdktf/hcl2json`, merge into one tree, and hand
 * off to the pure `buildGraph`.
 *
 * `@cdktf/hcl2json` is NOT a chant dependency — it carries a ~1.8 MB wasm blob
 * and only carve-out users need it. It is lazy-loaded here and, if absent, the
 * advisor fails with an install hint (the `carve` skill automates the install).
 */

import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { buildGraph } from "./graph";
import type { Hcl2JsonTree, TfGraph } from "./types";

/** Minimal shape of the parser export we depend on. */
type Hcl2JsonParse = (filename: string, hcl: string) => Promise<Hcl2JsonTree>;

export class Hcl2JsonNotInstalled extends Error {
  constructor(cause: unknown) {
    super(
      "Terraform carve-out needs the HCL parser, which is not installed.\n" +
        "  Install it once:  npm install -D @cdktf/hcl2json\n" +
        "  or let the agent do it:  run the `carve` skill\n" +
        `(underlying error: ${cause instanceof Error ? cause.message : String(cause)})`,
    );
    this.name = "Hcl2JsonNotInstalled";
  }
}

/**
 * Lazy-load the optional HCL parser. Throws `Hcl2JsonNotInstalled` with an
 * install hint when the package is missing, rather than a raw MODULE_NOT_FOUND.
 */
export async function loadHcl2json(): Promise<Hcl2JsonParse> {
  try {
    const mod = (await import("@cdktf/hcl2json")) as { parse: Hcl2JsonParse };
    return mod.parse;
  } catch (err) {
    throw new Hcl2JsonNotInstalled(err);
  }
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

/**
 * Parse a Terraform directory into a dependency graph. Reads only `.tf` (state
 * is a separate opt-in, #214 T2). Pure `.tf` estates parse fully; `count`/
 * `for_each` blocks report a single instance and are flagged `hasDynamic`.
 */
export async function parseTerraformDir(dir: string): Promise<TfGraph> {
  const parse = await loadHcl2json();
  const files = listTfFiles(dir);
  const merged: Hcl2JsonTree = {};
  for (const file of files) {
    const tree = await parse(file, readFileSync(file, "utf-8"));
    mergeTrees(merged, tree);
  }
  return buildGraph(merged);
}
