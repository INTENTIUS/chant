/**
 * The runner key on a `chant ci serve` or `chant ci run` host (#4099, epic
 * #4101).
 *
 * The host keeps its runner key in the serve's state directory, by default
 * `<git common dir>/chant/ci-serve/runner-key.pem`: an Ed25519 private key in
 * PEM, mode 0600, made by `--setup-key` when there is none. Its public half
 * is the `ssh-ed25519` line `.chant/trust.json` lists under `runners`, and
 * `--setup-key --trust` proposes that entry through `chant workspace trust
 * runner add` (#3510) on a branch of its own, pushed for review. It never
 * commits to the target branch: changing the trust config is a protected
 * write, and the change is reviewed and merged like any other.
 *
 * `ci serve` refuses to start when its key is not listed, with the runner
 * role, in `.chant/trust.json` at the target branch's head, since every run
 * it signed would then be ignored by `ci tick --source runs`. `--unsigned`
 * starts it without a key.
 */

import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { ciTagSigner } from "./ci-green";
import { CiRunError } from "./ci-run";
import { loadRunnerKey } from "./trust/dsse";
import { trustWrite } from "./trust/trust-write";

/** The runner key's file in the state directory. */
export const RUNNER_KEY_FILE = "runner-key.pem";

/** The principal `--setup-key --trust` lists the key for when `--principal` names none. */
export function defaultRunnerPrincipal(): string {
  return `chant-runner:${hostname().split(".")[0]!.toLowerCase().replace(/[^a-z0-9-]/g, "-") || "host"}`;
}

export interface HostRunnerKey {
  path: string;
  pem: string;
  /** `ssh-ed25519 <base64>`. */
  publicKey: string;
  /** Whether this call made it. */
  created: boolean;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function tryGit(cwd: string, args: string[]): string | undefined {
  try {
    return git(cwd, args);
  } catch {
    return undefined;
  }
}

/** Read the key at `path`, refusing one others can read or one that is not an Ed25519 private key in PEM. */
function readHostKey(path: string): HostRunnerKey {
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) throw new CiRunError(`${path} can be read by other users (mode ${mode.toString(8)}); chmod 600 it, since it signs for this runner`);
  const pem = readFileSync(path, "utf-8");
  try {
    return { path, pem, publicKey: loadRunnerKey(pem).publicKey, created: false };
  } catch (err) {
    throw new CiRunError(`${path} is not an Ed25519 private key in PEM: ${message(err)}`);
  }
}

/** The host's runner key in `stateDir`, or undefined when there is none. */
export function hostRunnerKey(stateDir: string): HostRunnerKey | undefined {
  const path = join(stateDir, RUNNER_KEY_FILE);
  return existsSync(path) ? readHostKey(path) : undefined;
}

/** The host's runner key in `stateDir`, made when there is none: Ed25519, PEM, mode 0600 in a directory of mode 0700. */
export function ensureHostRunnerKey(stateDir: string): HostRunnerKey {
  const found = hostRunnerKey(stateDir);
  if (found) return found;
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const path = join(stateDir, RUNNER_KEY_FILE);
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  // wx: never replace a key another process made in the meantime.
  writeFileSync(path, pem, { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
  return { path, pem, publicKey: loadRunnerKey(pem).publicKey, created: true };
}

/**
 * The target branch's head, as the readers of runners take it: the remote's
 * branch after a fetch (best effort), else the local branch. Undefined when
 * neither exists.
 */
export function targetHead(top: string, branch: string, remote = "origin"): { commit: string; ref: string } | undefined {
  if (tryGit(top, ["remote", "get-url", remote]) !== undefined) tryGit(top, ["fetch", "-q", remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`]);
  for (const ref of [`refs/remotes/${remote}/${branch}`, `refs/heads/${branch}`]) {
    const commit = tryGit(top, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]);
    if (commit) return { commit, ref };
  }
  return undefined;
}

/** The exact command that lists `publicKey` for `principal`. */
export function trustCommand(principal: string, publicKey: string): string {
  return `chant workspace trust runner add ${principal} --key "${publicKey}"`;
}

/** Whether `.chant/trust.json` at `commit` lists the key as a runner holding the runner role: its principal, or why not. */
export function runnerKeyListed(top: string, commit: string, pem: string): { ok: true; principal: string } | { ok: false; reason: string } {
  try {
    return { ok: true, principal: ciTagSigner(top, commit, pem, "the runs it signs").principal };
  } catch (err) {
    return { ok: false, reason: message(err) };
  }
}

export interface RunnerTrustProposal {
  /** The branch holding the commit, or null when the key was already listed at the target's head. */
  branch: string | null;
  commit: string | null;
  /** Whether the branch was pushed to the remote. */
  pushed: boolean;
  /** The trust config's digest on the branch. */
  digest: string | null;
}

/**
 * Propose the runner entry for review (#4099): in a temporary worktree at
 * the target's head, run `trust runner add` (#3510), commit the change on
 * `chant/trust-runner/<principal>`, and push that branch to `remote` when
 * the clone has it. The target branch is never written. The commit is made
 * with the host's git identity and signing settings; when the policy at base
 * has signers, the change needs a signature by a policy writer before it
 * merges.
 */
export function proposeRunnerTrust(req: { top: string; branch: string; principal: string; publicKey: string; by?: string; remote?: string }): RunnerTrustProposal {
  const remote = req.remote ?? "origin";
  const head = targetHead(req.top, req.branch, remote);
  if (!head) throw new CiRunError(`there is no branch ${req.branch} here or on ${remote}, so there is no trust config to add the runner to`);
  const branch = `chant/trust-runner/${req.principal.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")}`;
  if (tryGit(req.top, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`])) {
    throw new CiRunError(`the branch ${branch} exists already; review or delete it, then run --setup-key --trust again`);
  }
  const dir = mkdtempSync(join(tmpdir(), "chant-trust-runner-"));
  try {
    git(req.top, ["worktree", "add", "-q", "-b", branch, dir, head.commit]);
    const doc = trustWrite({ cwd: dir, action: "runner add", name: req.principal, key: req.publicKey, ...(req.by ? { by: req.by } : {}) });
    if ("error" in doc) throw new CiRunError(`trust runner add refused (${doc.error.code}): ${doc.error.message}`);
    if (!doc.changed) {
      git(req.top, ["worktree", "remove", "--force", dir]);
      git(req.top, ["branch", "-q", "-D", branch]);
      return { branch: null, commit: null, pushed: false, digest: doc.digest };
    }
    git(dir, ["add", "--", ".chant/trust.json"]);
    git(dir, ["commit", "-q", "-m", `trust the ${req.principal} runner key\n\nchant ci --setup-key --trust: list this host's runner key in .chant/trust.json (#4099).`]);
    const commit = git(dir, ["rev-parse", "HEAD"]);
    let pushed = false;
    if (tryGit(req.top, ["remote", "get-url", remote]) !== undefined) {
      try {
        git(dir, ["push", "-q", remote, `refs/heads/${branch}:refs/heads/${branch}`]);
        pushed = true;
      } catch (err) {
        throw new CiRunError(`committed ${branch} here, and pushing it to ${remote} failed: ${message(err).split("\n")[0]}`);
      }
    }
    return { branch, commit, pushed, digest: doc.digest };
  } finally {
    tryGit(req.top, ["worktree", "remove", "--force", dir]);
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface RunnerKeySetup {
  key: HostRunnerKey;
  /** The target's head the trust config was read at, or null when there is no such branch. */
  head: string | null;
  /** The principal the key is listed for at the head, or null. */
  listedAs: string | null;
  principal: string;
  command: string;
  proposal?: RunnerTrustProposal;
}

/** `--setup-key [--trust]`: make or read the key, see whether the target's head lists it, and with `trust` propose the entry. */
export function setupRunnerKey(req: { top: string; stateDir: string; branch: string; principal?: string; trust?: boolean; by?: string }): RunnerKeySetup {
  const key = ensureHostRunnerKey(req.stateDir);
  const head = targetHead(req.top, req.branch);
  const listed = head ? runnerKeyListed(req.top, head.commit, key.pem) : undefined;
  const principal = req.principal ?? defaultRunnerPrincipal();
  const out: RunnerKeySetup = { key, head: head?.commit ?? null, listedAs: listed?.ok ? listed.principal : null, principal, command: trustCommand(principal, key.publicKey) };
  if (req.trust && !out.listedAs) out.proposal = proposeRunnerTrust({ top: req.top, branch: req.branch, principal, publicKey: key.publicKey, ...(req.by ? { by: req.by } : {}) });
  return out;
}

/** What `--setup-key` prints on stderr; the public key alone goes to stdout. */
export function formatRunnerKeySetup(s: RunnerKeySetup, branch: string): string {
  const lines = [`runner key ${s.key.path} (${s.key.created ? "made now, mode 0600" : "already here"})`];
  if (s.listedAs) {
    lines.push(`.chant/trust.json at ${branch} ${s.head!.slice(0, 12)} lists it for ${s.listedAs}, with the runner role`);
  } else if (s.proposal?.branch) {
    lines.push(
      `committed the runner entry for ${s.principal} on ${s.proposal.branch} (${s.proposal.commit!.slice(0, 12)})${s.proposal.pushed ? " and pushed it" : ""}; open a pull request into ${branch}, and the key counts once it merges`,
    );
    lines.push("changing .chant/trust.json is a protected write: when the trust policy has signers, an admin signs the commit before it merges");
  } else if (s.proposal) {
    lines.push(`the runner entry for ${s.principal} is already at ${branch}'s head`);
  } else {
    lines.push(`.chant/trust.json at ${branch}${s.head ? ` ${s.head.slice(0, 12)}` : ""} does not list it yet. In a checkout of ${branch}, run`, `  ${s.command}`, "commit the change through review, or run this again with --trust to push it on a branch");
  }
  return lines.join("\n");
}

/**
 * The key `ci serve` signs with, checked before its first poll (#4099): the
 * `--key` file, else `CHANT_RUNNER_KEY`, else the host's key in the state
 * directory. Throws, with the command that lists it, when there is none or
 * `.chant/trust.json` at the target's head does not list it with the runner
 * role. With `unsigned` there is no key and nothing is checked.
 */
export function ciServeRunnerKey(req: { top: string; stateDir: string; branch: string; keyFile?: string; envKey?: string; unsigned?: boolean }): { pem?: string; fromFlag: boolean; source: string } {
  if (req.unsigned) return { fromFlag: false, source: "none (--unsigned)" };
  const host = req.keyFile === undefined && !req.envKey ? hostRunnerKey(req.stateDir) : undefined;
  const pem = req.keyFile !== undefined ? readFileSync(req.keyFile, "utf-8") : req.envKey || host?.pem;
  const source = req.keyFile !== undefined ? req.keyFile : req.envKey ? "CHANT_RUNNER_KEY" : (host?.path ?? join(req.stateDir, RUNNER_KEY_FILE));
  if (pem === undefined) {
    throw new CiRunError(`there is no runner key: no --key, no CHANT_RUNNER_KEY and no ${source}. Make one with chant ci serve --setup-key, list it with --trust, or start with --unsigned`);
  }
  let publicKey: string;
  try {
    publicKey = loadRunnerKey(pem).publicKey;
  } catch (err) {
    throw new CiRunError(`the runner key from ${source} is not an Ed25519 private key in PEM: ${message(err)}`);
  }
  const head = targetHead(req.top, req.branch);
  if (!head) throw new CiRunError(`there is no branch ${req.branch} here or on origin, so the runner key can't be checked against its .chant/trust.json; fetch it, or start with --unsigned`);
  const listed = runnerKeyListed(req.top, head.commit, pem);
  if (!listed.ok) {
    throw new CiRunError(
      `the runner key from ${source} is not trusted at ${branchAt(req.branch, head.commit)}: ${listed.reason}\n` +
        `  List it on a branch for review with chant ci serve --setup-key --trust, or run ${trustCommand(defaultRunnerPrincipal(), publicKey)} in a checkout of ${req.branch} and merge the change. Start with --unsigned to serve without signing.`,
    );
  }
  return { pem, fromFlag: req.keyFile !== undefined, source };
}

const branchAt = (branch: string, commit: string) => `${branch} ${commit.slice(0, 12)}`;
