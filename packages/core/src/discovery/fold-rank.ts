import { relative } from "node:path";
import { buildProjectImportEdges } from "./fold-import";
import type { FoldDecision } from "./index";

/**
 * chant #1083 — rank fold blockers by dominator retained-count over the
 * import graph discovery already builds.
 *
 * ## Why dominators, not a flat "files downstream of X" count
 *
 * The import graph is a DAG (occasionally cyclic, when project source
 * itself has an import cycle), not a tree: a file can be reachable through
 * several paths, so naively summing "files that import X, transitively"
 * double-counts every diamond and the totals stop meaning anything. The
 * fix is the same one heap snapshot tools use for object retained sizes
 * (Cooper–Harvey–Kennedy immediate dominators, prior art: spicypath's
 * `src/heap-dominators.js`, cited on chant #1083): file `d` dominates file
 * `n` when every causal path to `n`'s failure passes through `d`. A file's
 * retained count is then the size of its dominator subtree — the number of
 * files that would fold if `d` folded — and every node lands in exactly one
 * dominator subtree, so retained counts are conserved: they sum to the
 * total across the tree's top-level blockers, with nothing counted twice
 * through a diamond, and a file with two INDEPENDENT blockers (no common
 * ancestor besides the synthetic root) inflates neither.
 *
 * ## One direction only
 *
 * This models FORWARD contagion only: file `n` fails to fold because one of
 * its own imports, `d`, also fails — an unresolved cross-file reference.
 * The edge direction for dominance purposes is therefore `d -> n` (the
 * blocker points at what it blocks), which is the REVERSE of the literal
 * import edge `n -> d` (n imports d).
 *
 * Fold has a second, opposite-direction rule (chant #1044, implemented in
 * {@link import("./fold-import").planFoldTaint}): a file that WOULD fold
 * fine in isolation is forced back to run anyway because some file that
 * imports it (directly or transitively) itself runs — folding it
 * independently would create a second, non-identical instance. That is
 * contagion from importER to importEE, the opposite of the direction this
 * tree models, and a dominator tree over import edges cannot express it: a
 * fix to the "blocker" here wouldn't actually unblock the reverse-tainted
 * file (it was never broken on its own terms), so crediting it would
 * overstate the fix's blast radius. Every file discovery marked
 * {@link FoldDecision.reverseTainted} is therefore excluded from the tree
 * entirely and reported in {@link FoldRankResult.reverseTainted} instead —
 * see chant #1083's re-scope comment.
 */

/** Sentinel "file path" for the synthetic dominator-tree root. Never a real file — file paths never contain NUL. */
const ROOT = "\0chant-fold-rank-root\0";

/** One node in the forward-contagion dominator tree — a `"run"`, non-reverse-tainted file. */
export interface FoldBlocker {
  /** Absolute source file path (matches {@link FoldDecision.file}). */
  file: string;
  /** Why THIS file itself falls back to run (its own {@link FoldDecision.reason}). */
  reason?: string;
  /**
   * Number of files — including this one — that would fold if this file's
   * own fold problem were fixed: this node's dominator-subtree size.
   * Conserved: summing this field over every blocker with no closer
   * dominator ({@link topLevel}) equals {@link FoldRankResult.totalBlocked}.
   */
  retained: number;
  /** True when nothing else in the tree dominates this file more closely than the synthetic root — i.e. this file's own fold failure isn't explained by importing another blocker already in the tree. */
  topLevel: boolean;
  /** This file's immediate dominator's file path, or `undefined` for a {@link topLevel} blocker. */
  dominatedBy?: string;
}

/** A `"run"` file held back only by the chant #1044 reverse rule — never part of the forward dominator tree (see this module's doc). */
export interface FoldReverseTaintedFile {
  file: string;
  reason?: string;
}

export interface FoldRankResult {
  /**
   * Every forward-contagion blocker (a `"run"`, non-reverse-tainted file),
   * sorted by {@link FoldBlocker.retained} descending, ties broken by file
   * path for determinism. Includes every node in the tree, not just
   * top-level ones — an intermediate hub file (e.g. a `params.ts` many
   * others funnel through) is itself a meaningful blocker to rank.
   */
  blockers: FoldBlocker[];
  /** `"run"` files excluded from the tree by the reverse rule (chant #1044) — see this module's doc. */
  reverseTainted: FoldReverseTaintedFile[];
  /** Total forward-blocked files considered ({@link blockers}.length). Top-level blockers' retained counts sum to exactly this. */
  totalBlocked: number;
}

/**
 * Compute immediate dominators for `nodes` over `edges` (blocker -> blocked,
 * i.e. flowing in the CAUSAL direction, not the import direction), rooted at
 * a synthetic {@link ROOT}. Handles a cyclic/irreducible graph correctly —
 * Cooper–Harvey–Kennedy's iterative algorithm converges on any graph, not
 * just reducible ones (this is exactly why it's the right tool here: an
 * import graph can have cycles).
 *
 * `rootChildren` must already guarantee every node in `nodes` is reachable
 * from {@link ROOT} via `rootChildren` + `edges` — see `rankFoldBlockers`'s
 * two-phase root-selection below.
 */
function computeImmediateDominators(
  nodes: readonly string[],
  edges: ReadonlyMap<string, ReadonlySet<string>>,
  rootChildren: ReadonlySet<string>,
): Map<string, string> {
  const succ = (n: string): ReadonlySet<string> => (n === ROOT ? rootChildren : edges.get(n) ?? new Set());

  // Predecessors, including the synthetic ROOT edge into every root child.
  const preds = new Map<string, Set<string>>();
  for (const n of nodes) preds.set(n, new Set());
  for (const [from, targets] of edges) {
    for (const to of targets) {
      if (!preds.has(to)) preds.set(to, new Set());
      preds.get(to)!.add(from);
    }
  }
  for (const rc of rootChildren) preds.get(rc)?.add(ROOT);

  // Reverse-postorder numbering via one DFS from ROOT — every node in
  // `nodes` must be reached (guaranteed by the caller's root selection).
  const postorderNumber = new Map<string, number>();
  const visited = new Set<string>([ROOT]);
  let counter = 0;
  const visitStack: Array<{ node: string; iter: Iterator<string> }> = [
    { node: ROOT, iter: succ(ROOT).values() },
  ];
  while (visitStack.length > 0) {
    const top = visitStack[visitStack.length - 1];
    const next = top.iter.next();
    if (next.done) {
      postorderNumber.set(top.node, counter++);
      visitStack.pop();
      continue;
    }
    const child = next.value;
    if (!visited.has(child)) {
      visited.add(child);
      visitStack.push({ node: child, iter: succ(child).values() });
    }
  }

  const rpo = [...nodes, ROOT].filter((n) => postorderNumber.has(n));
  rpo.sort((a, b) => postorderNumber.get(b)! - postorderNumber.get(a)!); // reverse postorder: highest number first

  const idom = new Map<string, string>();
  idom.set(ROOT, ROOT);

  const intersect = (a: string, b: string): string => {
    let finger1 = a;
    let finger2 = b;
    while (finger1 !== finger2) {
      while (postorderNumber.get(finger1)! < postorderNumber.get(finger2)!) finger1 = idom.get(finger1)!;
      while (postorderNumber.get(finger2)! < postorderNumber.get(finger1)!) finger2 = idom.get(finger2)!;
    }
    return finger1;
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (const node of rpo) {
      if (node === ROOT) continue;
      let newIdom: string | undefined;
      for (const p of preds.get(node) ?? []) {
        if (!idom.has(p)) continue; // not yet processed this pass
        newIdom = newIdom === undefined ? p : intersect(newIdom, p);
      }
      if (newIdom !== undefined && idom.get(node) !== newIdom) {
        idom.set(node, newIdom);
        changed = true;
      }
    }
  }

  idom.delete(ROOT);
  return idom;
}

/**
 * Rank fold blockers by dominator retained-count over the (forward-only)
 * import graph among this build's `"run"`-mode files. See this module's doc
 * for the model. `decisions` is expected to be a `--fold` build's complete
 * {@link FoldDecision}[] — every discovered file, fold or run.
 */
export async function rankFoldBlockers(decisions: readonly FoldDecision[]): Promise<FoldRankResult> {
  const allFiles = decisions.map((d) => d.file);
  const reverseTainted = decisions
    .filter((d) => d.mode === "run" && d.reverseTainted === true)
    .map((d) => ({ file: d.file, reason: d.reason }))
    .sort((a, b) => a.file.localeCompare(b.file));

  const nodeDecisions = decisions.filter((d) => d.mode === "run" && d.reverseTainted !== true);
  const reasonByFile = new Map(nodeDecisions.map((d) => [d.file, d.reason] as const));
  const nodes = nodeDecisions.map((d) => d.file).sort((a, b) => a.localeCompare(b));
  const nodeSet = new Set(nodes);

  // file -> the OTHER discovered files it imports (real import direction).
  const importEdges = await buildProjectImportEdges(allFiles);

  // Cause graph, blocker -> blocked: importee -> importer, restricted to
  // both endpoints being forward-tree nodes (a fold-mode or reverse-tainted
  // file is neither a blocker nor blocked in this tree).
  const causeEdges = new Map<string, Set<string>>();
  for (const n of nodes) causeEdges.set(n, new Set());
  for (const [importer, targets] of importEdges) {
    if (!nodeSet.has(importer)) continue;
    for (const target of targets) {
      if (!nodeSet.has(target)) continue;
      causeEdges.get(target)!.add(importer);
    }
  }

  // Predecessor count, to find true root causes (a blocked file that is
  // itself never blocked by another tree node).
  const predCount = new Map<string, number>();
  for (const n of nodes) predCount.set(n, 0);
  for (const targets of causeEdges.values()) {
    for (const t of targets) predCount.set(t, (predCount.get(t) ?? 0) + 1);
  }

  // Two-phase root selection, so every node is reachable from ROOT even
  // across an import cycle with no external entry point (chant #1083's doc
  // cites spicypath's dominators working over a graph that is "cyclic and
  // irreducible" as the precedent this needs to match).
  const rootChildren = new Set<string>();
  const reached = new Set<string>();
  const expandFrom = (start: string): void => {
    if (reached.has(start)) return;
    const stack = [start];
    reached.add(start);
    while (stack.length > 0) {
      const cur = stack.pop()!;
      for (const next of causeEdges.get(cur) ?? []) {
        if (!reached.has(next)) {
          reached.add(next);
          stack.push(next);
        }
      }
    }
  };
  for (const n of nodes) {
    if (predCount.get(n) === 0) {
      rootChildren.add(n);
      expandFrom(n);
    }
  }
  for (const n of nodes) {
    if (!reached.has(n)) {
      rootChildren.add(n);
      expandFrom(n);
    }
  }

  const idom = computeImmediateDominators(nodes, causeEdges, rootChildren);

  // Dominator-tree children, to compute retained (subtree size) bottom-up.
  const domChildren = new Map<string, string[]>();
  for (const n of nodes) domChildren.set(n, []);
  for (const [n, parent] of idom) {
    if (parent !== ROOT) domChildren.get(parent)!.push(n);
  }

  const retained = new Map<string, number>();
  const computeRetained = (n: string): number => {
    const cached = retained.get(n);
    if (cached !== undefined) return cached;
    let size = 1;
    for (const child of domChildren.get(n) ?? []) size += computeRetained(child);
    retained.set(n, size);
    return size;
  };
  for (const n of nodes) computeRetained(n);

  const blockers: FoldBlocker[] = nodes.map((file) => {
    const parent = idom.get(file);
    const topLevel = parent === undefined || parent === ROOT;
    return {
      file,
      reason: reasonByFile.get(file),
      retained: retained.get(file)!,
      topLevel,
      dominatedBy: topLevel ? undefined : parent,
    };
  });
  blockers.sort((a, b) => b.retained - a.retained || a.file.localeCompare(b.file));

  return { blockers, reverseTainted, totalBlocked: nodes.length };
}

/** `file -> dominatedBy` lookup built from a {@link FoldRankResult}, for reconstructing a blocker's dominator-chain (used by {@link toCollapsedFormat}). */
function dominatorChain(result: FoldRankResult, file: string): string[] {
  const dominatedByFile = new Map(result.blockers.map((b) => [b.file, b.dominatedBy] as const));
  const chain: string[] = [file];
  let current: string | undefined = file;
  const guard = new Set<string>([file]);
  for (;;) {
    const parent = dominatedByFile.get(current!);
    if (parent === undefined) break;
    if (guard.has(parent)) break; // defensive: never trust a cycle in the tree itself
    chain.push(parent);
    guard.add(parent);
    current = parent;
  }
  return chain.reverse(); // top-level ancestor first, `file` last
}

/** A collapsed-format frame may not contain `;` (the frame separator) or a newline; sanitize rather than silently mis-render. */
function sanitizeFrame(label: string): string {
  return label.replace(/[\n\r]/g, " ").replace(/;/g, ",");
}

/**
 * Export the dominator tree in Brendan Gregg collapsed stack format
 * (`frame;frame;...;frame count`), weighted by retained count, so it opens
 * in any flame or icicle graph viewer with no chant-specific tooling (the
 * seam is the file format, per chant #1083's original scope).
 *
 * One line per blocker, `count` always `1`: each file's stack is the chain
 * of dominators from the top-level blocker down to itself. Folding
 * identical prefixes — what every collapsed-format consumer does — then
 * reproduces each blocker's retained count as that prefix's total weight,
 * with nothing double-counted through a diamond. `rootLabel` is a single
 * synthetic top frame (default `"fold"`) so every top-level blocker renders
 * under one shared root instead of the viewer showing several disconnected
 * trees; pass `relativeTo` (typically the build's infra path) to shorten
 * frame labels to project-relative paths.
 */
export function toCollapsedFormat(
  result: FoldRankResult,
  options?: { rootLabel?: string; relativeTo?: string },
): string[] {
  const rootLabel = options?.rootLabel ?? "fold";
  const toLabel = (file: string): string =>
    sanitizeFrame(options?.relativeTo ? relative(options.relativeTo, file) || file : file);

  return result.blockers
    .slice()
    .sort((a, b) => a.file.localeCompare(b.file))
    .map((blocker) => {
      const chain = dominatorChain(result, blocker.file).map(toLabel);
      return `${sanitizeFrame(rootLabel)};${chain.join(";")} 1`;
    });
}
