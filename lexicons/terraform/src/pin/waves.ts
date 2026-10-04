/**
 * The wave plan for a pin-bump rollout (#3189): which roots move in which PR.
 *
 * Two sources give the same shape, an ordered list of root lists:
 *
 * - **Declared canaries, then dependency order.** The canaries form wave 1.
 *   Every other root lands in the earliest wave after every root it depends
 *   on. That is the Kahn layering `chant components fan-out` uses
 *   (`resolveComponentGraph`, `@intentius/chant/components/layers`), and the
 *   order #3049 gives its gated waves. A canary that depends on a root outside
 *   the canaries is refused, since wave 1 would apply before what it reads.
 * - **choudoufu's wave planner** (`choudoufu live-waves -json`, choudoufu#1754).
 *   It reads cross-estate references from the estates' own configuration, puts
 *   `-canary` roots in wave 1, and emits each wave's roots on their own, so
 *   {@link wavesFromChoudoufu} takes its document as it is.
 *
 * A root's dependencies come from the caller (`dependsOn`) and, for a
 * Terragrunt unit, from its `dependency` and `dependencies` blocks
 * ({@link terragruntDependencies}). A dependency on a root outside the
 * rollout orders nothing: it is not moving.
 */

import { posix } from "node:path";
import type { Hcl2Json } from "@intentius/chant/terraform/parse";
import { kahnLayers } from "@intentius/chant/components/layers";

/** One root in a rollout. `root` is its directory, relative to the repository, with `/` separators. */
export interface PinRoot {
  root: string;
  /** Roots this one reads, by directory. They land in an earlier wave. */
  dependsOn?: string[];
  /**
   * The TypeScript file a generated root is built from. The pin edit then
   * goes to the module declaration there rather than to the `.tf` chant
   * writes (`./edit-ts.ts`).
   */
  tsSource?: string;
}

/** One wave: its number from 1, whether the declared canaries form it, and its roots, sorted. */
export interface PinWave {
  wave: number;
  canary: boolean;
  roots: string[];
}

/** Thrown when the roots cannot be split into waves. The message names the roots. */
export class PinWavePlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PinWavePlanError";
  }
}

/** Canaries first, then dependency order. */
export function planPinWaves(roots: readonly PinRoot[], canaries: readonly string[] = []): PinWave[] {
  const names = new Set(roots.map((r) => r.root));
  for (const c of canaries) {
    if (!names.has(c)) throw new PinWavePlanError(`canary ${c} is not a root of this rollout (roots: ${[...names].sort().join(", ") || "none"})`);
  }
  const canarySet = new Set(canaries);
  const deps = new Map<string, Set<string>>();
  for (const r of roots) deps.set(r.root, new Set((r.dependsOn ?? []).filter((d) => names.has(d) && d !== r.root)));

  for (const c of canarySet) {
    const outside = [...deps.get(c)!].filter((d) => !canarySet.has(d));
    if (outside.length > 0) throw new PinWavePlanError(`canary ${c} depends on ${outside.join(", ")}, which is not a canary, so wave 1 would move it first`);
  }

  const waves: PinWave[] = [];
  if (canarySet.size > 0) waves.push({ wave: 1, canary: true, roots: [...canarySet].sort() });
  const rest = new Map([...deps].filter(([n]) => !canarySet.has(n)).map(([n, d]) => [n, new Set([...d].filter((x) => !canarySet.has(x)))]));
  const layered = kahnLayers(rest);
  if (layered.cycle) throw new PinWavePlanError(`dependency cycle among roots: ${layered.cycle.join(", ")}`);
  for (const roots of layered.waves) waves.push({ wave: waves.length + 1, canary: false, roots });
  return waves;
}

/**
 * The waves of a `choudoufu live-waves -json` document (format version 1).
 * `prefix` is the directory choudoufu ran in, relative to the repository,
 * when its roots are named relative to that rather than to the repository.
 */
export function wavesFromChoudoufu(doc: unknown, prefix = ""): PinWave[] {
  const d = doc as { format_version?: unknown; waves?: unknown };
  if (d?.format_version !== "1") throw new PinWavePlanError(`not a choudoufu live-waves document of format version 1 (format_version: ${JSON.stringify(d?.format_version)})`);
  if (!Array.isArray(d.waves)) throw new PinWavePlanError("the live-waves document has no waves");
  return d.waves.map((w: { wave?: unknown; canary?: unknown; roots?: unknown }, i) => {
    if (w.wave !== i + 1 || !Array.isArray(w.roots) || w.roots.some((r) => typeof r !== "string")) {
      throw new PinWavePlanError(`live-waves wave ${i + 1} is malformed`);
    }
    return { wave: i + 1, canary: w.canary === true, roots: (w.roots as string[]).map((r) => (prefix ? posix.join(prefix, r) : posix.normalize(r))).sort() };
  });
}

/**
 * Keep only the roots in `keep`, renumbering the waves and dropping any left
 * empty. A wave plan from choudoufu covers every root it was given; the
 * rollout moves only the roots that call the module at the old or new pin.
 */
export function restrictWaves(waves: readonly PinWave[], keep: ReadonlySet<string>): PinWave[] {
  const out: PinWave[] = [];
  for (const w of waves) {
    const roots = w.roots.filter((r) => keep.has(r));
    if (roots.length > 0) out.push({ wave: out.length + 1, canary: w.canary, roots });
  }
  return out;
}

/**
 * The roots a Terragrunt unit depends on: each `dependency` block's
 * `config_path` and the `dependencies` block's `paths`, resolved against the
 * unit's directory. A path that is an expression is skipped, since it names
 * no directory until Terragrunt evaluates it.
 */
export async function terragruntDependencies(root: string, text: string, parser: Hcl2Json): Promise<string[]> {
  const tree = (await parser.parse(posix.join(root, "terragrunt.hcl"), text)) as {
    dependency?: Record<string, Array<{ config_path?: unknown }>>;
    dependencies?: Array<{ paths?: unknown }>;
  };
  const paths: string[] = [];
  for (const blocks of Object.values(tree.dependency ?? {})) for (const b of blocks) if (typeof b.config_path === "string") paths.push(b.config_path);
  for (const b of tree.dependencies ?? []) if (Array.isArray(b.paths)) for (const p of b.paths) if (typeof p === "string") paths.push(p);
  return [...new Set(paths.filter((p) => !p.includes("${")).map((p) => posix.normalize(posix.join(root, p))))].sort();
}
