/**
 * Selective change-set scoping — which stacks does a change affect?
 *
 * "Affected" is two distinct things, because chant serializes cross-stack
 * references symbolically:
 *   1. **Directly changed** — the stack's built artifact differs between base
 *      and head. Caught by artifact diff over deterministic builds, so it
 *      ignores comment-only / refactor-with-no-output-change edits.
 *   2. **Operationally affected (dependents)** — a stack whose own artifact is
 *      unchanged but which consumes an upstream export whose value changed. Its
 *      bytes don't move, yet it may need re-apply. Caught by walking the
 *      cross-stack graph (#200) from the directly-changed set; opt-in.
 *
 * A stack whose inputs come from outside synthesis (deploy-time params) cannot
 * be judged from a source diff — reported as **indeterminate**, not silently
 * included or excluded.
 *
 * ## What "stack" means here depends on the project
 *
 * A project that declares `stacks` in `chant.config.ts` gets each declared
 * stack's own source built, and the answer names stacks. A single-root project
 * has no such partition to build, so its answer names lexicon partitions, which
 * is the only granularity it has. The difference matters downstream: a
 * component's deploy step names a stack, so only the first kind of answer can
 * be joined to components (#2420).
 *
 * This returns the set; it does not act. `chant components fan-out`
 * (../cli/handlers/fan-out.ts) is the command that acts on it, and fanning
 * `lifecycle plan` / `ApplyOp` over it by hand is still an Op the user
 * composes.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, existsSync, symlinkSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { build, type StackGraph } from "../build";
import { getPrimaryOutput } from "../lint/post-synth";
import type { Serializer } from "../serializer";
import type { Declarable } from "../declarable";

const execFileAsync = promisify(execFile);

export interface AffectedResult {
  /** Stacks whose built artifact differs between base and head. */
  changed: string[];
  /** Downstream consumers of changed stacks (only when `includeDependents`). */
  dependents: string[];
  /** Stacks with deploy-time inputs — cannot be confirmed from a source diff. */
  indeterminate: string[];
}

// ── Pure model ──────────────────────────────────────────────────────────────

/** Stacks whose serialized output differs between the two builds (added/removed count). */
export function changedStacks(
  base: Map<string, string>,
  head: Map<string, string>,
): string[] {
  const names = new Set([...base.keys(), ...head.keys()]);
  const changed: string[] = [];
  for (const name of names) {
    if (base.get(name) !== head.get(name)) changed.push(name);
  }
  return changed.sort();
}

/**
 * Walk the cross-stack graph backwards from `changed` to find every stack that
 * (transitively) consumes a changed stack. Edge `from → to` means `from`
 * depends on `to`, so a changed `to` makes `from` a dependent.
 */
export function dependentStacks(changed: string[], graph: StackGraph): string[] {
  const consumersOf = new Map<string, string[]>();
  for (const { from, to } of graph.edges) {
    (consumersOf.get(to) ?? consumersOf.set(to, []).get(to)!).push(from);
  }
  const seen = new Set(changed);
  const queue = [...changed];
  const dependents = new Set<string>();
  while (queue.length > 0) {
    const node = queue.shift()!;
    for (const consumer of consumersOf.get(node) ?? []) {
      if (seen.has(consumer)) continue;
      seen.add(consumer);
      dependents.add(consumer);
      queue.push(consumer);
    }
  }
  return [...dependents].sort();
}

/**
 * Compute the affected set from two per-stack artifact maps and the cross-stack
 * graph. Pure — no builds, no git — so the model is independently testable.
 */
export function computeAffected(
  base: Map<string, string>,
  head: Map<string, string>,
  graph: StackGraph,
  opts: { includeDependents?: boolean; externalInput?: string[] } = {},
): AffectedResult {
  const changed = changedStacks(base, head);
  const dependents = opts.includeDependents ? dependentStacks(changed, graph) : [];
  const indeterminate = [...(opts.externalInput ?? [])].sort();
  return { changed, dependents, indeterminate };
}

// ── Build + git plumbing ──────────────────────────────────────────────────────

/** A built BuildResult's per-stack (lexicon) primary output, keyed by stack. */
export function artifactMap(outputs: Map<string, string | { primary: string }>): Map<string, string> {
  const map = new Map<string, string>();
  for (const [stack, output] of outputs) map.set(stack, getPrimaryOutput(output as string));
  return map;
}

/** Stacks (lexicons) that declare a deploy-time parameter — external input. */
export function externalInputStacks(entities: Map<string, Declarable>): string[] {
  const stacks = new Set<string>();
  for (const [, entity] of entities) {
    if ("parameterType" in entity && typeof (entity as { parameterType?: unknown }).parameterType === "string") {
      stacks.add(entity.lexicon);
    }
  }
  return [...stacks].sort();
}

async function gitTopLevel(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd });
  return stdout.trim();
}

/**
 * Check out `ref` into a throwaway worktree, symlink the repo's node_modules so
 * lexicon imports resolve, run `fn`, then remove the worktree. At most one
 * worktree exists at a time.
 */
async function withWorktree<T>(repoRoot: string, ref: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "chant-affected-"));
  await execFileAsync("git", ["worktree", "add", "--detach", dir, ref], { cwd: repoRoot });
  try {
    const nm = join(repoRoot, "node_modules");
    const linked = join(dir, "node_modules");
    if (existsSync(nm) && !existsSync(linked)) symlinkSync(nm, linked, "dir");
    return await fn(dir);
  } finally {
    await execFileAsync("git", ["worktree", "remove", "--force", dir], { cwd: repoRoot }).catch(() => {
      rmSync(dir, { recursive: true, force: true });
    });
  }
}

/** One independently-deployed stack, as `ChantConfig.stacks` declares it. */
export interface StackSource {
  /** The deployed stack name — what a component's deploy step names. */
  name: string;
  /** Source directory to build for this stack, relative to the project root. */
  src: string;
}

/**
 * Build each declared stack's own source directory and key the result by
 * **stack name**.
 *
 * Without this, one build of the project root produces a map keyed by lexicon
 * partition, so an aws-only estate of fifteen stacks answers "aws changed" no
 * matter which one moved. That answer cannot be joined to anything: a
 * component's deploy step names a stack, not a lexicon, so
 * `componentsForUnits` (../components/fan-out.ts) would claim none of it and
 * a fan-out derived from it would be empty. The two halves have to speak the
 * same names for either to be worth having.
 *
 * A stack that serializes through more than one lexicon folds its partitions
 * into one artifact, because the unit being deployed is the stack.
 */
async function stackArtifacts(
  root: string,
  serializers: Serializer[],
  stacks: readonly StackSource[],
  /**
   * Whether a missing `src` is an error. True for the head side, where every
   * declared stack must exist; false for the base side, where a stack added
   * since then legitimately has no source yet and reads as an empty artifact,
   * which is what makes it `changed`.
   */
  requireSrc: boolean,
): Promise<{ artifacts: Map<string, string>; externalInput: string[] }> {
  const artifacts = new Map<string, string>();
  const externalInput: string[] = [];
  for (const stack of stacks) {
    const src = resolve(root, stack.src);
    // `build()` on a directory that is not there returns empty outputs rather
    // than throwing, so a typo in `src` would make both sides build nothing,
    // match, and report the stack as unchanged forever. A silent answer of
    // exactly that shape is what this whole path exists to prevent.
    if (requireSrc && !existsSync(src)) {
      throw new Error(
        `stack "${stack.name}" declares src "${stack.src}", which does not exist under ${root}. ` +
          `Fix chant.config.ts's stacks[] entry: a source directory that is not there builds to nothing, ` +
          `and a stack that builds to nothing can never be reported as changed.`,
      );
    }
    const built = await build(src, serializers);
    artifacts.set(
      stack.name,
      [...built.outputs.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([lexicon, output]) => `${lexicon}\n${getPrimaryOutput(output as string)}`)
        .join("\n"),
    );
    if (externalInputStacks(built.entities).length > 0) externalInput.push(stack.name);
  }
  return { artifacts, externalInput: externalInput.sort() };
}

export interface AffectedStacksOptions {
  /** Project source directory to scope (the head/working-tree build root). */
  projectPath: string;
  serializers: Serializer[];
  /**
   * The project's independently-deployed stacks (`ChantConfig.stacks`). With
   * them, each stack's own source is built and the answer names stacks; without
   * them, one build of `projectPath` answers by lexicon partition, which is the
   * only granularity a single-root project has.
   *
   * `dependents` is always empty in this mode, and that is not an omission: the
   * build holds cross-*lexicon* edges, and the relation between two deployed
   * stacks is stated by a component's `dependsOn` and `stackOutput`, which
   * `chant components fan-out` walks for itself. Inventing stack edges from
   * lexicon ones would be a guess dressed as a graph.
   *
   * Each `src` resolves against `projectPath`, so in this mode `projectPath`
   * has to be the project root that `ChantConfig.stacks` is written relative
   * to. A `sourceDir` that narrows the build root does not apply here: the
   * stacks already say which source belongs to which of them, which is the
   * narrowing, and applying both would look for `<sourceDir>/<stack.src>`.
   */
  stacks?: readonly StackSource[];
  /** Base git ref to diff against (built in a throwaway worktree). */
  baseRef?: string;
  /** Head git ref. Defaults to the working tree (built in place — no worktree). */
  headRef?: string;
  /**
   * Caller-supplied base source directory (already on disk). Takes precedence
   * over `baseRef` — no worktree is created. Use for a build cache or two dist
   * trees you already have.
   */
  baseDir?: string;
  includeDependents?: boolean;
}

/**
 * Compute the affected stacks for a change. Head is built in place (the working
 * tree); base is built from `baseDir` if supplied, else from `baseRef` via a
 * single throwaway worktree. Builds are deterministic, so a cached/supplied base
 * is as trustworthy as a rebuild.
 */
export async function affectedStacks(opts: AffectedStacksOptions): Promise<AffectedResult> {
  const projectPath = resolve(opts.projectPath);
  const needsWorktree = Boolean(opts.headRef) || Boolean(opts.baseRef && !opts.baseDir);
  const repoRoot = needsWorktree ? await gitTopLevel(projectPath) : projectPath;
  // Canonicalize via realpath so the worktree-relative path is correct even when
  // the temp dir is a symlink (macOS /var → /private/var) and `git
  // rev-parse --show-toplevel` reports the real path.
  const relProject = needsWorktree ? relative(repoRoot, realpathSync(projectPath)) : "";

  // Head: the in-place build of the working tree, unless an explicit headRef is
  // given (then a throwaway worktree — removed before the base worktree, so at
  // most one exists at a time).
  const perStack = opts.stacks && opts.stacks.length > 0 ? opts.stacks : undefined;
  // No cross-stack graph in per-stack mode, by construction: see `stacks` above.
  const EMPTY_GRAPH: StackGraph = { nodes: [], edges: [], order: [], waves: [], cycles: [] };
  /** One build root in, its artifact map and external-input set out, at whichever granularity applies. */
  const readArtifacts = async (
    root: string,
    isHead: boolean,
  ): Promise<{ artifacts: Map<string, string>; externalInput: string[]; graph: StackGraph }> => {
    if (perStack) return { ...(await stackArtifacts(root, opts.serializers, perStack, isHead)), graph: EMPTY_GRAPH };
    const built = await build(root, opts.serializers);
    return {
      artifacts: artifactMap(built.outputs),
      externalInput: externalInputStacks(built.entities),
      graph: built.manifest.stackGraph,
    };
  };

  const head = opts.headRef
    ? await withWorktree(repoRoot, opts.headRef, (dir) => readArtifacts(join(dir, relProject), true))
    : await readArtifacts(projectPath, true);

  // Base: caller-supplied dir (cheapest), else a single worktree at baseRef.
  let baseMap: Map<string, string>;
  if (opts.baseDir) {
    baseMap = (await readArtifacts(resolve(opts.baseDir), false)).artifacts;
  } else if (opts.baseRef) {
    baseMap = await withWorktree(repoRoot, opts.baseRef, async (dir) => (await readArtifacts(join(dir, relProject), false)).artifacts);
  } else {
    throw new Error("affectedStacks requires either baseDir or baseRef");
  }

  return computeAffected(baseMap, head.artifacts, head.graph, {
    includeDependents: opts.includeDependents,
    externalInput: head.externalInput,
  });
}
