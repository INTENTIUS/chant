/**
 * A shared policy source (#4613): `ci.policy.source`, a git repository and
 * ref that several workspaces read one rule set from.
 *
 * The source is named in the declaration, which the jobs read at base, so a
 * pull request cannot point its own policy at another repository or ref.
 * The ref is fetched once per job into a scratch repository under the OS
 * temp dir, never the working tree, and the commit it named is kept, so the
 * report and the wave's decision name the rules a verdict used.
 *
 * A tag or branch is fetched alone, at depth 1. A commit the server does not
 * hand out by itself is found after fetching every branch and tag. The
 * job's own git credentials, if any, reach the repository; a URL's user and
 * password are left out of every message and record.
 *
 * Like `./gate-policy.ts`, this module imports only node built-ins and the
 * git tree reader, so a product can bundle it.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitTree, type WorkspaceTree } from "./workspace/tree";
import type { GatePolicySource, ResolvedGatePolicySource } from "./gate-policy";

// The source's shape and its check live in `./gate-policy.ts`, so the gate
// policy bundles alone (#4294) without this module's git fetch.
export { assertGatePolicySource, type GatePolicySource, type ResolvedGatePolicySource } from "./gate-policy";

/** The first chant that reads `ci.policy.source` and `ci.policy.packs`; a declaration that sets either needs this `minReader`. */
export const CI_POLICY_SOURCE_FLOOR = "0.124.55";

/** A fetched source: its record, and its tree at the commit, rooted at the repository's top. */
export interface FetchedGatePolicySource {
  source: ResolvedGatePolicySource;
  tree: WorkspaceTree;
  /** Removes the scratch repository. The tree reads nothing after it. */
  cleanup: () => void;
}

/** The repository URL with its user and password left out. */
export function shownPolicyRepo(url: string): string {
  return url.replace(/^([a-z+]+:\/\/)[^/@]*@/, "$1");
}

function gitIn(dir: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("git", ["-C", dir, "-c", "init.defaultBranch=main", "-c", "advice.detachedHead=false", ...args], {
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? "", stderr: `${r.stderr ?? ""}${r.error ? r.error.message : ""}` };
}

/**
 * Fetch `source` at its ref into a scratch repository. Returns its tree at
 * the commit the ref named, or why it could not be read. A missing Rego
 * directory is not an error here: the caller decides whether it needs one.
 */
export function fetchGatePolicySource(source: GatePolicySource, opts: { tmp?: string } = {}): FetchedGatePolicySource | { error: string } {
  const repo = shownPolicyRepo(source.repo);
  const shown = `${repo}@${source.ref}`;
  const dest = mkdtempSync(join(opts.tmp ?? tmpdir(), "chant-policy-source-"));
  const cleanup = (): void => rmSync(dest, { recursive: true, force: true });
  const fail = (why: string): { error: string } => {
    cleanup();
    return { error: `ci.policy.source: could not read ${shown}: ${why.split(source.repo).join(repo)}` };
  };
  if (gitIn(dest, ["init", "-q", "--bare"]).status !== 0) return fail("git init failed");
  let fetched = gitIn(dest, ["fetch", "-q", "--no-tags", "--depth", "1", "--", source.repo, source.ref]);
  let commit = fetched.status === 0 ? gitIn(dest, ["rev-parse", "--verify", "--quiet", "FETCH_HEAD^{commit}"]).stdout.trim() : "";
  if (!commit) {
    fetched = gitIn(dest, ["fetch", "-q", "--", source.repo, "+refs/heads/*:refs/remotes/source/*", "+refs/tags/*:refs/tags/*"]);
    if (fetched.status !== 0) return fail(fetched.stderr.trim().split("\n").pop() || `git fetch exited ${fetched.status}`);
    commit = gitIn(dest, ["rev-parse", "--verify", "--quiet", `${source.ref}^{commit}`]).stdout.trim();
    if (!commit) commit = gitIn(dest, ["rev-parse", "--verify", "--quiet", `refs/remotes/source/${source.ref}^{commit}`]).stdout.trim();
    if (!commit) return fail(`${source.ref} is not a tag, branch or commit there`);
  }
  let tree: WorkspaceTree;
  try {
    tree = gitTree(dest, commit);
  } catch (err) {
    return fail(`could not list ${commit.slice(0, 12)}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const path = (source.path ?? "policy").replace(/^\.\/+/, "").replace(/\/+$/, "");
  return { source: { repo, ref: source.ref, commit, path }, tree, cleanup };
}

const fetchedOnce = new Map<string, FetchedGatePolicySource | { error: string }>();
let exitHooked = false;

/**
 * {@link fetchGatePolicySource}, once per repository and ref in this
 * process: a job that judges many runs, or plans many stacks, fetches the
 * source one time. The scratch repositories go when the process exits.
 */
export function fetchGatePolicySourceOnce(source: GatePolicySource): FetchedGatePolicySource | { error: string } {
  const key = `${source.repo}\0${source.ref}\0${source.path ?? ""}`;
  const known = fetchedOnce.get(key);
  if (known) return known;
  const got = fetchGatePolicySource(source);
  fetchedOnce.set(key, got);
  if (!exitHooked) {
    exitHooked = true;
    process.once("exit", () => {
      for (const f of fetchedOnce.values()) if ("cleanup" in f) f.cleanup();
    });
  }
  return got;
}
