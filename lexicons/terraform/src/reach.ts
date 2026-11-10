/**
 * What a change reaches (#4984), beside ./changed-roots.ts: the roots,
 * Terragrunt units, Atmos instances or synthesized roots a change from
 * `from` to `to` reaches, read from git alone. Moved from terragucci's
 * `reachedRoots`, `reachedUnits`, `reachedInstances` and
 * `reachedSynthesized` (comment-apply.ts), for a product's reach line
 * (`productPlan.reach`, #4979): the lock job and the decision before merge
 * run it at the target branch's commit, so none of the change's code runs.
 *
 * Each follows what reads a reached target: a root that reads a reached
 * root's state, a unit that names a reached unit in a `dependency` or
 * `dependencies` block, an instance that depends on a reached one, followed
 * through. The product hands the reads it knows (terragucci's
 * `terraform_remote_state` edges and `waves.after`, Atmos's dependencies);
 * the Terragrunt unit reads are parsed here, at both ends of the range.
 * Markdown files reach nothing. When a change can reach anything, or git
 * cannot diff the range, every target is reached and `every` says why.
 */

import { posix } from "node:path";
import { changedRoots } from "./changed-roots";

/** Git in a checkout: an argv after `git`, and what it answered. */
export type ReachGit = (args: string[]) => { status: number | null; stdout: string; stderr: string };

/** What a change reaches, sorted, and why it is every target when it is. */
export interface Reach {
  targets: string[];
  every?: string;
}

/** The targets each target reads, so a change to one of those reaches it too. */
export type ReachReads = ReadonlyMap<string, ReadonlySet<string>>;

/** Changed files that reach nothing: documentation. */
export const READS_NOTHING = /\.md$/i;

/** The files the change from `from` to `to` changes (`git diff --name-only from...to`), or undefined when git cannot say. */
export function changedFilesBetween(git: ReachGit, from: string, to: string): string[] | undefined {
  const diff = git(["diff", "--name-only", "--no-renames", `${from}...${to}`]);
  if (diff.status !== 0) return undefined;
  return diff.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** Add to `selected` every target that reads a selected one, followed through. */
export function followReads(selected: Set<string>, reads: ReachReads | undefined): void {
  if (!reads) return;
  for (let grew = true; grew; ) {
    grew = false;
    for (const [target, from] of reads) {
      if (!selected.has(target) && [...from].some((d) => selected.has(d))) {
        selected.add(target);
        grew = true;
      }
    }
  }
}

const sorted = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

/**
 * The plain roots a change reaches: the roots whose files it changes, by
 * chant's path rules (./changed-roots.ts: a root's directory, the local
 * modules it calls, its var files), and every root that reads one of those.
 * Every root when git cannot diff the range.
 */
export function reachedRoots(repo: string, git: ReachGit, from: string, to: string, roots: readonly string[], reads?: ReachReads): Reach {
  const all = sorted(roots);
  const files = changedFilesBetween(git, from, to);
  if (files === undefined) return { targets: all, every: "git could not list the files it changes" };
  const selected = new Set(changedRoots(repo, Object.fromEntries(all.map((r) => [r, { dir: r }])), files));
  followReads(selected, reads);
  return { targets: [...selected].filter((r) => all.includes(r)).sort() };
}

/** The body of each top-level `<keyword> ... {` block in HCL text, braces matched, strings skipped. */
function hclBlocks(text: string, keyword: string): string[] {
  const out: string[] = [];
  const head = new RegExp(`^\\s*${keyword}\\b[^{\\n]*\\{`, "gm");
  for (let m = head.exec(text); m; m = head.exec(text)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (let quoted = false; i < text.length && depth > 0; i++) {
      const c = text[i];
      if (quoted) {
        if (c === "\\") i++;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
    }
    out.push(text.slice(start, i - 1));
    head.lastIndex = i;
  }
  return out;
}

/**
 * The paths a unit's `terragrunt.hcl` names in its `dependency` blocks'
 * `config_path` and its `dependencies` block's `paths`, when each is a plain
 * string. A path built with a function or an interpolation is not read:
 * only Terragrunt can evaluate it, and no Terragrunt runs on a change's
 * files before a review.
 */
export function literalTerragruntDependencies(text: string): string[] {
  const clean = text.replace(/(^|[^:"$])(#|\/\/).*$/gm, "$1");
  const plain = /^"([^"$]*)"$/;
  const out: string[] = [];
  for (const b of hclBlocks(clean, "dependency")) {
    const m = /^\s*config_path\s*=\s*("[^"\n]*")\s*$/m.exec(b);
    const p = m && plain.exec(m[1]!);
    if (p) out.push(p[1]!);
  }
  for (const b of hclBlocks(clean, "dependencies")) {
    const m = /\bpaths\s*=\s*\[([^\]]*)\]/.exec(b);
    for (const item of m ? m[1]!.split(",").map((x) => x.trim()).filter(Boolean) : []) {
      const p = plain.exec(item);
      if (p) out.push(p[1]!);
    }
  }
  return out;
}

/**
 * The Terragrunt units a change reaches. A unit is reached when a file
 * under its directory changes (the deepest unit holding the file), and so
 * is every unit that names a reached one with a plain path, at either end
 * of the range. A changed file under no unit's directory (`root.hcl`, a
 * module, a stack template) may change any unit, so it reaches every one.
 */
export function reachedUnits(git: ReachGit, from: string, to: string, units: readonly string[]): Reach {
  const all = sorted(units);
  const files0 = changedFilesBetween(git, from, to);
  if (files0 === undefined) return { targets: all, every: "git could not list the files it changes" };
  const files = files0.filter((f) => !READS_NOTHING.test(f));
  const deepest = [...all].sort((a, b) => b.length - a.length);
  const selected = new Set<string>();
  for (const f of files) {
    const u = deepest.find((d) => f.startsWith(`${d}/`));
    if (!u) return { targets: all, every: `it changes \`${f}\`, which is in no unit's directory` };
    selected.add(u);
  }
  const reads = new Map<string, Set<string>>();
  for (const u of all) {
    const deps = new Set<string>();
    for (const ref of [from, to]) {
      const shown = git(["show", `${ref}:${u}/terragrunt.hcl`]);
      if (shown.status !== 0) continue;
      for (const p of literalTerragruntDependencies(shown.stdout)) deps.add(posix.normalize(posix.join(u, p)).replace(/\/+$/, ""));
    }
    reads.set(u, deps);
  }
  followReads(selected, reads);
  return { targets: [...selected].sort() };
}

/**
 * The Atmos instances a change reaches. `componentOf` names each instance's
 * component directory. A changed file under one reaches that component's
 * instances; any other file (a stack manifest, a catalog, `atmos.yaml`) can
 * change any instance's vars or backend, so it reaches every instance.
 * Instances that read a reached one follow.
 */
export function reachedInstances(git: ReachGit, from: string, to: string, instances: readonly string[], componentOf: ReadonlyMap<string, string | undefined>, reads?: ReachReads): Reach {
  const all = sorted(instances);
  const files0 = changedFilesBetween(git, from, to);
  if (files0 === undefined) return { targets: all, every: "git could not list the files it changes" };
  const files = files0.filter((f) => !READS_NOTHING.test(f));
  const selected = new Set<string>();
  for (const f of files) {
    const owners = all.filter((r) => {
      const c = componentOf.get(r)?.replace(/\/+$/, "");
      return c !== undefined && f.startsWith(`${c}/`);
    });
    if (owners.length === 0) return { targets: all, every: `it changes \`${f}\`, which can change any Atmos instance` };
    for (const r of owners) selected.add(r);
  }
  followReads(selected, reads);
  return { targets: [...selected].sort() };
}

/**
 * The roots a change reaches when a command writes them (`synth`, CDK
 * Terrain's stacks). The roots are not in git, so no diff names them, and
 * the command is the change's own code: any changed file that is not
 * Markdown can change any root.
 */
export function reachedSynthesized(git: ReachGit, from: string, to: string, roots: readonly string[]): Reach {
  const all = sorted(roots);
  const files = changedFilesBetween(git, from, to);
  if (files === undefined) return { targets: all, every: "git could not list the files it changes" };
  const file = files.find((f) => !READS_NOTHING.test(f));
  if (file === undefined) return { targets: [] };
  return { targets: all, every: `it changes \`${file}\`, and the synth command writes every root from the repo's files` };
}
