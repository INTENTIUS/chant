/**
 * Cutting a release from a workstation as from CI (#4027).
 *
 * `chant release cut` runs the same steps wherever it runs. What differs
 * between a laptop and a CI job is read here, from git and the process
 * environment, so the CLI and its tests resolve it the same way:
 *
 * - trunk: the branch `ci.green.branch` names in the declaration at base,
 *   else the branch `origin/HEAD` points at, else `main`. The commit must be
 *   reachable from `origin/<branch>` as this clone last fetched it, so a
 *   commit that is on the local branch only is refused as not pushed. Nothing
 *   is fetched: a stale `origin/<branch>` can only refuse a commit that was
 *   pushed since, never admit one that wasn't.
 * - a clean tree: no tracked change and no untracked file that git does not
 *   ignore, since the compile reads the directory and a new
 *   `*.component.ts` would be compiled into the release.
 * - the actor: `--actor`, else the principal the signers file at base lists
 *   for the signing key, else the CI's actor, else git's `user.email`, else
 *   `$USER`.
 * - the tag: `release/<label>`, or `release/<member>/<label>` in a workspace
 *   member, an annotated tag on the commit that is created locally and never
 *   pushed by chant.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { Signer } from "../workspace/trust/trust-files";

export type WorkstationCheckCode = "release-commit-not-on-trunk" | "release-commit-not-pushed" | "release-worktree-dirty" | "release-tag-taken" | "release-tag-invalid";

/** A refusal before anything is compiled or written. */
export class WorkstationCheckError extends Error {
  constructor(
    readonly code: WorkstationCheckCode,
    message: string,
    readonly fix?: string,
  ) {
    super(message);
    this.name = "WorkstationCheckError";
  }
}

function tryGit(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

const isAncestor = (cwd: string, a: string, b: string): boolean =>
  spawnSync("git", ["merge-base", "--is-ancestor", a, b], { cwd, stdio: "ignore" }).status === 0;

/** The remote a release's commit must be pushed to. */
export const RELEASE_REMOTE = "origin";

/** The trunk branch, and where its name came from. */
export interface Trunk {
  remote: string;
  branch: string;
  from: "ci.green.branch" | "origin/HEAD" | "default";
}

/** The trunk of the repository at `cwd`: `ci.green.branch` when declared, else what `origin/HEAD` names, else `main`. */
export function resolveTrunk(cwd: string, greenBranch: string | null): Trunk {
  if (greenBranch) return { remote: RELEASE_REMOTE, branch: greenBranch, from: "ci.green.branch" };
  const head = tryGit(cwd, ["symbolic-ref", "--quiet", `refs/remotes/${RELEASE_REMOTE}/HEAD`]);
  const prefix = `refs/remotes/${RELEASE_REMOTE}/`;
  if (head?.startsWith(prefix)) return { remote: RELEASE_REMOTE, branch: head.slice(prefix.length), from: "origin/HEAD" };
  return { remote: RELEASE_REMOTE, branch: "main", from: "default" };
}

/**
 * {@link checkOnTrunk} across the branches `ci.green` judges (#4325): the
 * trunk `commit` is on, `trunk` itself or one of `others` (the declaration's
 * further green branches, which `ci.branches` routes members to). A commit on
 * none of them is refused with the first trunk's error.
 */
export function checkOnGreenBranches(cwd: string, commit: string, trunk: Trunk, others: readonly string[]): Trunk {
  try {
    checkOnTrunk(cwd, commit, trunk);
    return trunk;
  } catch (err) {
    for (const branch of others) {
      const routed: Trunk = { ...trunk, branch };
      try {
        checkOnTrunk(cwd, commit, routed);
        return routed;
      } catch {
        // Not on this one either; the next, then the first branch's error.
      }
    }
    throw err;
  }
}

/**
 * Refuse `commit` unless it is reachable from `<remote>/<branch>` as this
 * clone knows it. A commit on the local branch only is `release-commit-not-pushed`;
 * any other is `release-commit-not-on-trunk`.
 */
export function checkOnTrunk(cwd: string, commit: string, trunk: Trunk): void {
  const remoteRef = `refs/remotes/${trunk.remote}/${trunk.branch}`;
  const short = commit.slice(0, 12);
  const named = `${trunk.remote}/${trunk.branch}`;
  const why = trunk.from === "ci.green.branch" ? " (the branch ci.green names)" : trunk.from === "origin/HEAD" ? ` (the branch ${trunk.remote}/HEAD names)` : "";
  const remoteTip = tryGit(cwd, ["rev-parse", "--verify", "--quiet", `${remoteRef}^{commit}`]);
  if (remoteTip && isAncestor(cwd, commit, remoteTip)) return;
  const localTip = tryGit(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${trunk.branch}^{commit}`]);
  if (localTip && isAncestor(cwd, commit, localTip)) {
    throw new WorkstationCheckError(
      "release-commit-not-pushed",
      remoteTip
        ? `commit ${short} is on ${trunk.branch}${why} but not on ${named}, so it has not been pushed`
        : `commit ${short} is on ${trunk.branch}${why}, and this clone knows no ${named}, so it can't be shown pushed`,
      `Push it, or fetch if it was pushed elsewhere: git push ${trunk.remote} ${trunk.branch}, or git fetch ${trunk.remote} ${trunk.branch}`,
    );
  }
  throw new WorkstationCheckError(
    "release-commit-not-on-trunk",
    remoteTip
      ? `commit ${short} is not on ${named}${why}, so a release cut from it would ship what trunk never had`
      : `commit ${short} is not on ${trunk.branch}${why}, and this clone knows no ${named}`,
    `Check out a commit of ${named} after fetching it: git fetch ${trunk.remote} ${trunk.branch}`,
  );
}

/** Refuse a tree with a tracked change or an untracked file git does not ignore. */
export function checkCleanTree(cwd: string, commit: string): void {
  const status = tryGit(cwd, ["status", "--porcelain", "--untracked-files=normal"]);
  if (status === null || status === "") return;
  const lines = status.split("\n");
  const untracked = lines.filter((l) => l.startsWith("??")).map((l) => l.slice(3));
  const tracked = lines.length - untracked.length;
  const parts = [
    ...(tracked > 0 ? [`${tracked} tracked file(s) with uncommitted changes`] : []),
    ...(untracked.length > 0 ? [`${untracked.length} untracked file(s) such as ${untracked[0]}`] : []),
  ];
  throw new WorkstationCheckError(
    "release-worktree-dirty",
    `the working tree has ${parts.join(" and ")}, so a compile here would not be commit ${commit.slice(0, 12)}'s`,
    "Commit, stash or remove them (or add them to .gitignore), or cut from a clean checkout of the commit.",
  );
}

/** Where the actor came from. */
export type ActorSource = "flag" | "signer" | "ci" | "git" | "user";

/** The public key `keyFile` holds or names, as `<type> <base64>`, or null when it can't be read without a passphrase. */
export function publicKeyOf(keyFile: string): string | null {
  const parse = (text: string): string | null => {
    const [type, blob] = text.trim().split(/\s+/);
    return type && blob && /^(ssh-|ecdsa-|sk-)/.test(type) ? `${type} ${blob}` : null;
  };
  try {
    if (existsSync(keyFile)) {
      const own = parse(readFileSync(keyFile, "utf-8"));
      if (own) return own;
    }
    if (existsSync(`${keyFile}.pub`)) {
      const pub = parse(readFileSync(`${keyFile}.pub`, "utf-8"));
      if (pub) return pub;
    }
  } catch {
    return null;
  }
  const derived = spawnSync("ssh-keygen", ["-y", "-P", "", "-f", keyFile], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  return derived.status === 0 ? parse(derived.stdout) : null;
}

/** The one principal `signers` lists for `publicKey`, or null for none or several. */
export function signerPrincipal(publicKey: string, signers: readonly Signer[]): string | null {
  const principals = [...new Set(signers.filter((s) => s.key === publicKey).map((s) => s.principal))];
  return principals.length === 1 ? principals[0] : null;
}

/**
 * Who cut the release, and where the name came from: `--actor`, else the
 * signer the signers file at base lists for the signing key, else the CI's
 * actor (`GITHUB_ACTOR`, `GITLAB_USER_LOGIN`), else git's `user.email`, else
 * `$USER`. Undefined when none is set.
 */
export function resolveCutActor(req: {
  cwd: string;
  explicit?: string;
  /** The signing key's public half, when the cut is signed and it could be read. */
  publicKey?: string | null;
  signers?: readonly Signer[];
  env?: NodeJS.ProcessEnv;
}): { actor: string; source: ActorSource } | undefined {
  const env = req.env ?? process.env;
  if (req.explicit) return { actor: req.explicit, source: "flag" };
  if (req.publicKey && req.signers) {
    const principal = signerPrincipal(req.publicKey, req.signers);
    if (principal) return { actor: principal, source: "signer" };
  }
  const ci = env.GITHUB_ACTOR || env.GITLAB_USER_LOGIN;
  if (ci) return { actor: ci, source: "ci" };
  const email = tryGit(req.cwd, ["config", "--get", "user.email"]);
  if (email) return { actor: email, source: "git" };
  if (env.USER) return { actor: env.USER, source: "user" };
  return undefined;
}

/** The tag a labelled release gets: `release/<label>`, or `release/<member>/<label>` for a workspace member. */
export function releaseTagName(member: string | null, label: string): string {
  return member ? `release/${member}/${label}` : `release/${label}`;
}

/**
 * Whether `tag` can name `commit`: `absent` (the cut creates it), `present`
 * (it already names the commit), or a {@link WorkstationCheckError} for a
 * tag that names another commit or is not a valid tag name.
 */
export function checkReleaseTag(cwd: string, tag: string, commit: string): "absent" | "present" {
  if (spawnSync("git", ["check-ref-format", `refs/tags/${tag}`], { cwd, stdio: "ignore" }).status !== 0) {
    throw new WorkstationCheckError("release-tag-invalid", `"${tag}" is not a valid git tag name, so the release can't be tagged`, "Pick a label git accepts in a ref name.");
  }
  const at = tryGit(cwd, ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`]);
  if (at === null) return "absent";
  if (at === commit) return "present";
  throw new WorkstationCheckError(
    "release-tag-taken",
    `the tag ${tag} already names commit ${at.slice(0, 12)}, not ${commit.slice(0, 12)}`,
    "Pick another label, or delete the tag if it was made by mistake: git tag -d " + tag,
  );
}

/**
 * Create `tag` on `commit` as an annotated tag whose message names the
 * release. Local only. A clone with no git identity tags as chant, as the ci
 * tags are made.
 */
export function createReleaseTag(cwd: string, tag: string, commit: string, release: { releaseDigest: string; label: string; member: string | null }): void {
  const ident: string[] = [];
  if (tryGit(cwd, ["config", "user.name"]) === null) ident.push("-c", "user.name=chant");
  if (tryGit(cwd, ["config", "user.email"]) === null) ident.push("-c", "user.email=chant@localhost");
  const message = [`release ${release.label}`, "", `Release-Digest: ${release.releaseDigest}`, ...(release.member ? [`Member: ${release.member}`] : [])].join("\n");
  execFileSync("git", [...ident, "tag", "-a", "-m", message, tag, commit], { cwd, stdio: ["ignore", "ignore", "pipe"] });
}
