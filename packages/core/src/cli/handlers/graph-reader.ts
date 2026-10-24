/**
 * `chant graph` over a graph reader module (#4413).
 *
 * A kind's `graph.reader` names a module in the package that supplies the
 * kind; `chant workspace graph` writes a reader project whose
 * `graph.reader.module` is that module, and the member's own `chant graph`
 * runs here. Because the member's chant loads it, the reader runs under the
 * member's toolchain, as a lexicon reader does. The module's default export
 * is `(input: { dir, config }) => GraphIR`, sync or async. It reads files and
 * returns data; chant gives it no write handle, and nothing it returns is
 * run.
 */

import { pathToFileURL } from "node:url";
import { isAbsolute } from "node:path";
import type { GraphIR } from "../../graph-ir";

export interface GraphReaderInput {
  /** The member's directory, absolute, as the kind's config placed it in `config.dir` (or the reader project when it didn't). */
  dir: string;
  /** The kind's `graph.config`, placeholders substituted. */
  config: Record<string, unknown>;
}

/** Load the module and call it, or say why not. Never throws. */
export async function readGraphWithModule(
  module: string,
  config: Record<string, unknown>,
  projectPath: string,
): Promise<{ ir: GraphIR } | { error: string }> {
  if (!isAbsolute(module)) return { error: `graph.reader.module must be an absolute path, got ${module}` };
  let read: unknown;
  try {
    read = ((await import(pathToFileURL(module).href)) as { default?: unknown }).default;
  } catch (err) {
    return { error: `graph reader ${module} could not be loaded: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (typeof read !== "function") return { error: `graph reader ${module} has no default export function` };
  let out: unknown;
  try {
    const dir = typeof config.dir === "string" ? config.dir : projectPath;
    out = await (read as (input: GraphReaderInput) => unknown)({ dir, config });
  } catch (err) {
    return { error: `graph reader ${module} failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const ir = out as Partial<GraphIR> | null;
  if (ir === null || typeof ir !== "object" || !Array.isArray(ir.nodes) || !Array.isArray(ir.edges)) {
    return { error: `graph reader ${module} returned something with no nodes and edges` };
  }
  return { ir: { ...ir, nodes: ir.nodes, edges: ir.edges, groups: ir.groups ?? {} } as GraphIR };
}
