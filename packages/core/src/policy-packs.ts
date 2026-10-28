/**
 * Policy packs read at base (#4613): the CrossGuard packs a Pulumi preview
 * runs, copied out of the commit the change is measured from, as the Rego of
 * `ci.policy` is (`./components/pr-policy.ts`). A pull request cannot loosen
 * or delete a pack that judges it, nor its `--policy-pack-config` file.
 *
 * Two lists meet here:
 *
 * - `ci.policy.packs` in the declaration at base: each `dir` relative to the
 *   declaration's directory, or to the top of `ci.policy.source` when one is
 *   set. A listed pack that is not there is an error, and the preview does
 *   not run: a pack the base requires is never skipped.
 * - The step's own packs (`pulumi-up`'s `policyPacks`), from the step input
 *   the head's component file gives. Each one inside the repository is
 *   copied from base. One the base does not have was added by the change and
 *   runs once it merges; one that differs on the head runs as the base has
 *   it. Each case is a note. A pack outside the repository (an install the
 *   job's image holds) is no part of the change and runs where it is.
 *
 * A copy holds the files git tracks. A pack's installed dependencies are
 * not policy, so when the checkout's pack directory has `node_modules`,
 * `venv` or `.venv`, the copy links to it.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { GatePolicyPack } from "./gate-policy";
import type { ResolvedGatePolicySource } from "./policy-source";
import { gitTop, gitTree, resolveCommit, type WorkspaceTree } from "./workspace/tree";

/** One pack as the preview runs it: copied from base, or outside the repository as it stands. */
export interface PolicyPackAtBase {
  /** The directory the engine reads. */
  dir: string;
  /** The `--policy-pack-config` file the engine reads. */
  config?: string;
  /** Where the pack came from, for notes and the plan: `ci.policy.packs` or the step. */
  from: "declaration" | "step";
  /** The pack as named: its path in the repository or the source, or the absolute path outside it. */
  name: string;
}

/** The packs a preview runs, the lines saying what changed hands, and how to remove the copies. */
export interface PolicyPacksAtBase {
  /** The commit the packs were read at. */
  base: string;
  packs: PolicyPackAtBase[];
  /** One line per step pack that was left out or read from base in place of the head's copy. */
  notes: string[];
  /** The shared source `ci.policy.packs` was read from, with its commit. */
  source?: ResolvedGatePolicySource;
  /** The scratch directory holding the copies. */
  scratch: string;
  cleanup: () => void;
}

export interface PolicyPacksAtBaseOptions {
  /** Where the step runs: the stack's directory. The workspace and its repository are found from here. */
  cwd: string;
  /** The commit the caller reads policy at, `DeployContext.policyBase`. */
  base: string;
  /** The step's packs, each `dir` and `config` absolute or relative to `cwd`. */
  stepPacks?: readonly GatePolicyPack[];
  /** Where the scratch directory goes, such as the step's own scratch, which then removes the copies with it. Default the OS temp dir. */
  tmp?: string;
}

const posix = (p: string): string => p.split("\\").join("/");
const LINKED = ["node_modules", "venv", ".venv"];

/** Whether the working tree's `rel` (under `top`) differs from `commit`'s, tracked or untracked. */
function differsOnHead(top: string, commit: string, rel: string): boolean {
  const diff = spawnSync("git", ["-C", top, "diff", "--quiet", commit, "--", rel], { stdio: "ignore" });
  if (diff.status !== 0) return true;
  try {
    return execFileSync("git", ["-C", top, "ls-files", "--others", "--exclude-standard", "--", rel], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim() !== "";
  } catch {
    return true;
  }
}

/** Link the installs a checkout's pack directory holds into its copy. */
function linkInstalls(copy: string, checkoutDir: string | undefined): void {
  if (!checkoutDir) return;
  for (const name of LINKED) {
    const there = join(checkoutDir, name);
    if (existsSync(there) && !existsSync(join(copy, name))) {
      try {
        symlinkSync(there, join(copy, name), "dir");
      } catch {
        // A pack that cannot see its installs fails in the engine, which names it.
      }
    }
  }
}

let copied = 0;

/** Copy directory `from` of `tree` to `to` on disk. */
function copyTree(tree: WorkspaceTree, from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of tree.list(from) ?? []) {
    const src = from === "" ? entry.name : `${from}/${entry.name}`;
    const dest = join(to, entry.name);
    if (entry.type === "dir") copyTree(tree, src, dest);
    else writeFileSync(dest, tree.bytes ? tree.bytes(src) : tree.read(src));
  }
}

/** Copy one file out of `tree` into `dir`, keeping its name. */
function copyFile(tree: WorkspaceTree, path: string, dir: string): string {
  const out = join(dir, `${copied++}-${path.split("/").pop()!}`);
  writeFileSync(out, tree.bytes ? tree.bytes(path) : tree.read(path));
  return out;
}

/**
 * The packs a preview at `cwd` runs, read at `base`: `ci.policy.packs` from
 * the declaration (or its source) and the step's own, each copied from
 * there. Returns why none can be read when the base or the source cannot
 * be, or a pack `ci.policy.packs` lists is missing.
 */
export async function policyPacksAtBase(options: PolicyPacksAtBaseOptions): Promise<PolicyPacksAtBase | { error: string }> {
  const cwd = resolve(options.cwd);
  const top = gitTop(cwd);
  if (!top) return { error: `policy packs are read at base ${options.base.slice(0, 12)}, and ${cwd} is not in a git repository` };
  const commit = resolveCommit(top, options.base);
  if (!commit) return { error: `policy packs are read at base, and ${options.base} names no commit in ${top}` };
  const scratch = mkdtempSync(join(options.tmp ?? tmpdir(), "chant-policy-packs-"));
  const cleanup = (): void => rmSync(scratch, { recursive: true, force: true });
  const fail = (error: string): { error: string } => {
    cleanup();
    return { error };
  };
  const packs: PolicyPackAtBase[] = [];
  const notes: string[] = [];
  const realCwd = realpathSync(cwd);
  const whole = gitTree(top, commit);
  const export1 = (tree: WorkspaceTree, path: string): string | { error: string } => {
    const into = join(scratch, `pack-${packs.length}-${path.split("/").pop() || "root"}`);
    try {
      copyTree(tree, path, into);
    } catch (err) {
      return { error: `the policy pack ${path} could not be read: ${err instanceof Error ? err.message : String(err)}` };
    }
    return into;
  };

  // ci.policy.packs, from the declaration at base or its source.
  let source: ResolvedGatePolicySource | undefined;
  const taken = new Set<string>();
  try {
    const { prLoopPolicyAt } = await import("./components/pr-policy");
    const read = prLoopPolicyAt(cwd, commit);
    const declared = read.settings?.packs ?? [];
    if (declared.length > 0) {
      if (read.error !== undefined) return fail(read.error);
      if (!read.tree) return fail(`ci.policy.packs at ${commit.slice(0, 12)} could not be read`);
      source = read.source;
      const { locateWorkspace } = await import("./workspace/which-chant");
      const located = locateWorkspace(cwd, commit);
      const where = source ? `${source.repo}@${source.ref} (${source.commit.slice(0, 12)})` : `the declaration at ${commit.slice(0, 12)}`;
      for (const p of declared) {
        const dir = p.dir.replace(/^\.\/+/, "").replace(/\/+$/, "");
        if (read.tree.stat(dir) !== "dir") return fail(`ci.policy.packs names ${p.dir}, which is not a directory in ${where}`);
        const copy = export1(read.tree, dir);
        if (typeof copy !== "string") return fail(copy.error);
        let config: string | undefined;
        if (p.config) {
          if (read.tree.stat(p.config) !== "file") return fail(`ci.policy.packs names the config ${p.config}, which is not a file in ${where}`);
          config = copyFile(read.tree, p.config, scratch);
        }
        // A pack in the workspace links the checkout's installs; one from the source has none here.
        const checkoutDir = source ? undefined : join(located.rootOnDisk, dir);
        linkInstalls(copy, checkoutDir);
        if (!source) taken.add(posix(join(located.root === "." ? "" : located.root, dir)));
        packs.push({ dir: copy, ...(config ? { config } : {}), from: "declaration", name: dir });
      }
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  // The step's own packs, each from base when it is in the repository.
  for (const p of options.stepPacks ?? []) {
    const abs = isAbsolute(p.dir) ? p.dir : resolve(cwd, p.dir);
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      real = abs;
    }
    const rel = posix(relative(top, real));
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      packs.push({ dir: abs, ...(p.config ? { config: isAbsolute(p.config) ? p.config : resolve(cwd, p.config) } : {}), from: "step", name: abs });
      continue;
    }
    if (taken.has(rel)) continue;
    const shown = posix(relative(realCwd, real)) || ".";
    if (whole.stat(rel) !== "dir") {
      notes.push(`the policy pack ${shown} is not at base ${commit.slice(0, 12)}, so it runs once this change merges`);
      continue;
    }
    if (differsOnHead(top, commit, rel)) notes.push(`the policy pack ${shown} differs on this change; the copy at base ${commit.slice(0, 12)} runs`);
    const copy = export1(whole, rel);
    if (typeof copy !== "string") return fail(copy.error);
    linkInstalls(copy, real);
    let config: string | undefined;
    if (p.config) {
      const cabs = isAbsolute(p.config) ? p.config : resolve(cwd, p.config);
      let creal: string;
      try {
        creal = realpathSync(cabs);
      } catch {
        creal = cabs;
      }
      const crel = posix(relative(top, creal));
      if (crel.startsWith("..") || isAbsolute(crel)) config = cabs;
      else if (whole.stat(crel) !== "file") notes.push(`the policy pack config ${posix(relative(realCwd, creal))} is not at base ${commit.slice(0, 12)}, so ${shown} runs with its own defaults`);
      else {
        if (differsOnHead(top, commit, crel)) notes.push(`the policy pack config ${posix(relative(realCwd, creal))} differs on this change; the copy at base ${commit.slice(0, 12)} runs`);
        config = copyFile(whole, crel, scratch);
      }
    }
    packs.push({ dir: copy, ...(config ? { config } : {}), from: "step", name: rel });
  }
  return { base: commit, packs, notes, ...(source ? { source } : {}), scratch, cleanup };
}
