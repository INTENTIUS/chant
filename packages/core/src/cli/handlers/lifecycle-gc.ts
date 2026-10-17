/**
 * `chant lifecycle gc [--yes] [--push] [--json] [--verbose]` (#4036): prune
 * stored change sets, releases and their templates from `chant/lifecycle`, and
 * run event files from this host, by the retention policy.
 *
 * Without `--yes` it is a dry run: it prints what it would remove and changes
 * nothing. With `--yes` it writes one commit to the local `chant/lifecycle`
 * that removes those files, and deletes the run event files. It pushes only
 * with `--push`. History is never rewritten, so a pruned file stays in the
 * branch's earlier commits. The rules are in ../../lifecycle/retention.ts.
 *
 * The policy is the defaults, overridden by the `retention` block of the
 * workspace declaration at base when the checkout is a workspace. The prune
 * covers the whole branch, every member, from wherever in the repository it
 * runs.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { formatError, formatSuccess, formatWarning } from "../format";
import type { CommandContext } from "../registry";
import type { RetentionPolicy } from "../../lifecycle/retention-policy";

const USAGE = "chant lifecycle gc [--yes] [--push] [--json] [--verbose]";

function tryGit(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/** Whether a workspace declaration sits in `cwd` or a directory above it, up to the repository's top. */
function inWorkspace(cwd: string, top: string): boolean {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "chant.workspace.json")) || existsSync(join(dir, "chant.workspace.jsonc"))) return true;
    if (dir === top || dirname(dir) === dir) return false;
  }
}

/** Every commit with a `ci/revoked/<sha>` tag, counted as `chant release cut` counts it. */
async function revokedCommits(cwd: string, top: string, green: import("../../workspace/declaration").CiGreen | null, workspace: boolean): Promise<Set<string>> {
  if (workspace) {
    const { readCiTags } = await import("../../workspace/ci-green");
    const base = green
      ? (tryGit(top, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${green.branch}^{commit}`]) ??
        tryGit(top, ["rev-parse", "--verify", "--quiet", `refs/heads/${green.branch}^{commit}`]) ??
        tryGit(top, ["rev-parse", "HEAD"]))
      : null;
    return new Set(readCiTags(top, green, base).revoked.keys());
  }
  // With no declaration every tag counts, as readCiTags counts them without `ci.green`.
  const out = tryGit(cwd, ["for-each-ref", "--format=%(refname:lstrip=4)", "refs/tags/ci/revoked/"]) ?? "";
  return new Set(out.split("\n").filter((s) => /^[0-9a-f]{40,64}$/.test(s)));
}

const kb = (bytes: number): string => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`);

export async function runLifecycleGc(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  if (args.extraPositional) {
    console.error(formatError({ message: `lifecycle gc takes no argument, and was given "${args.extraPositional}"`, hint: USAGE }));
    return 1;
  }
  const cwd = resolve(".");
  const top = tryGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top) {
    console.error(formatError({ message: "lifecycle gc prunes the chant/lifecycle branch, and this directory is not in a git repository", hint: USAGE }));
    return 1;
  }
  const dryRun = args.yes !== true;

  const { resolveRetention } = await import("../../lifecycle/retention-policy");
  let policy: RetentionPolicy = resolveRetention(null);
  let green: import("../../workspace/declaration").CiGreen | null = null;
  const workspace = inWorkspace(cwd, top);
  if (workspace) {
    const { scopeSource } = await import("../../workspace/write-scope");
    const source = scopeSource(cwd);
    if (!source.declaration) {
      console.error(formatError({ message: `the workspace declaration can't be read, so its retention policy is unknown and nothing is pruned: ${source.failure?.message ?? "no declaration"}` }));
      return 1;
    }
    policy = resolveRetention(source.declaration.retention);
    green = source.declaration.ci?.green ?? null;
  }

  // Read the remote's facts first: a prune planned on a stale branch could
  // remove what a newer gate binds, and a forked branch must not be pushed over.
  const { fetchLifecycleStatus } = await import("../../lifecycle/git");
  const fetched = await fetchLifecycleStatus({ cwd });
  if (fetched.status === "diverged" || fetched.status === "unreachable") {
    const why = fetched.status === "diverged" ? `the local chant/lifecycle and ${fetched.remote}'s have forked` : `${fetched.remote} did not answer: ${fetched.stderr}`;
    if (!dryRun) {
      console.error(formatError({ message: `nothing was pruned: ${why}`, hint: "Bring chant/lifecycle up to date with its remote, then run again." }));
      return 1;
    }
    if (!args.json) console.error(formatWarning({ message: `planned on the local branch only: ${why}` }));
  }

  const { runLifecycleGc: run } = await import("../../lifecycle/retention");
  const report = await run({
    cwd,
    policy,
    now: new Date(),
    revokedCommits: await revokedCommits(cwd, top, green, workspace),
    dryRun,
    push: args.push === true,
  });

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }

  const lc = report.lifecycle;
  const count = (list: ReadonlyArray<{ kind: string }>, kind: string) => list.filter((f) => f.kind === kind).length;
  const bytes = lc.remove.reduce((n, f) => n + f.bytes, 0);
  const verb = dryRun ? "would remove" : "removed";
  if (!lc.tip) {
    console.error("No chant/lifecycle branch: nothing stored to prune.");
  } else {
    console.log(
      `chant/lifecycle at ${lc.tip.slice(0, 12)}: ${verb} ${count(lc.remove, "change-set")} change set(s), ${count(lc.remove, "release")} release(s) and ${count(lc.remove, "template")} template(s), ${kb(bytes)}; ` +
        `keeps ${count(lc.keep, "change-set")}, ${count(lc.keep, "release")} and ${count(lc.keep, "template")}`,
    );
    console.log(`  tree at the tip: ${lc.before.files} file(s), ${kb(lc.before.bytes)} before; ${lc.after.files} file(s), ${kb(lc.after.bytes)} after. The ledgers (${kb(lc.before.ledgers.bytes)}) are never pruned, and history keeps every removed file.`);
    if (args.verbose) for (const f of lc.remove) console.log(`  - ${f.path}`);
  }
  const ev = report.runEvents;
  if (ev.dir) {
    console.log(`  run events in ${ev.dir}: ${verb} ${ev.remove.length} file(s), ${kb(ev.remove.reduce((n, f) => n + f.bytes, 0))}; keeps ${ev.kept.files}`);
    if (args.verbose) for (const f of ev.remove) console.log(`  - ${f.file}`);
  }
  if (dryRun) {
    console.error("Dry run: nothing was removed. Run again with --yes to prune.");
  } else if (lc.commit) {
    console.error(formatSuccess(`Pruned in commit ${lc.commit.slice(0, 12)} on chant/lifecycle`));
    if (lc.pushed) console.error("  pushed");
    else if (lc.pushWarning) console.error(formatWarning({ message: lc.pushWarning }));
    else console.error("  not pushed: run with --push, or push chant/lifecycle yourself");
  }
  return 0;
}
