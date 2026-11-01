/**
 * One repository reached with git over SSH and one private key (#4699), for
 * a target that may not use a forge's API token, such as a Homebrew tap
 * written with a deploy key.
 *
 * Each {@link SshGitRepo} works in a temporary bare repository of its own.
 * It fetches only the branches it reads, at depth 1, makes commits with git's
 * plumbing (no checkout), and pushes. The key is written to a file only the
 * user can read, inside that directory, and the directory is removed by
 * {@link SshGitRepo.close}.
 *
 * The host's keys are pinned: ssh runs with `StrictHostKeyChecking=yes` and a
 * known-hosts file written from the `ssh_keys` that GitHub's `GET /meta`
 * lists, read over HTTPS from the API root. ssh reads no config file
 * (`-F /dev/null`) and offers only the key (`IdentitiesOnly=yes`).
 */

import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Credential } from "./publish-credentials";
import { PublishTargetError, type PublishContextBase, type PublishFetch } from "./release-publish";

/** The SSH host for a GitHub API root: `github.com` for `https://api.github.com`, else the API's own host (GitHub Enterprise Server). */
export function githubSshHost(api: string): string {
  const host = new URL(api).hostname;
  return host === "api.github.com" ? "github.com" : host;
}

/** The SSH URL of `owner/name` on `host`. */
export function sshRemote(host: string, repo: string): string {
  return `git@${host}:${repo}.git`;
}

/** A shell word for GIT_SSH_COMMAND, which git runs through the shell. */
function shellWord(s: string): string {
  return /^[A-Za-z0-9_./:@=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** What a push did: `ok`, or `rejected` when the remote refused a non-fast-forward. Any other failure throws. */
export type PushResult = "ok" | "rejected";

export class SshGitRepo {
  /** The bare repository, inside {@link root}. */
  private readonly dir: string;
  readonly remote: string;

  private constructor(
    readonly repo: string,
    readonly host: string,
    private readonly ctx: PublishContextBase,
    private readonly git: string,
    /** The code a failure throws. */
    private readonly code: string,
    /** The temporary directory: the key, the known hosts, the repository. */
    private readonly root: string,
    private readonly env: NodeJS.ProcessEnv,
  ) {
    this.dir = join(root, "repo.git");
    this.remote = sshRemote(host, repo);
  }

  /**
   * A repository session: reads the host's keys from `GET {api}/meta`, writes
   * them and the key to a temporary directory, and makes an empty bare
   * repository there. Close it with {@link close}.
   */
  static async open(opts: {
    api: string;
    repo: string;
    key: Credential;
    ctx: PublishContextBase;
    fetch: PublishFetch;
    code: string;
    git?: string;
    ssh?: string;
  }): Promise<SshGitRepo> {
    const host = githubSshHost(opts.api);
    const meta = await opts.fetch(`${opts.api}/meta`, { method: "GET", headers: { accept: "application/vnd.github+json", "user-agent": "chant" } });
    const text = await meta.text().catch(() => "");
    let keys: unknown;
    try {
      keys = meta.status === 200 ? (JSON.parse(text) as { ssh_keys?: unknown }).ssh_keys : undefined;
    } catch {
      keys = undefined;
    }
    if (!Array.isArray(keys) || keys.length === 0 || !keys.every((k) => typeof k === "string" && /^[a-z0-9@.-]+ [A-Za-z0-9+/=]+$/.test(k))) {
      throw new PublishTargetError(opts.code, `${opts.api}/meta gave no SSH host keys for ${host} (it answered ${meta.status}), so ${host} can't be checked`, "Set api to the GitHub API root of the host the repository is on.");
    }
    const dir = mkdtempSync(join(tmpdir(), "chant-git-ssh-"));
    try {
      const keyFile = join(dir, "key");
      writeFileSync(keyFile, opts.key.value.endsWith("\n") ? opts.key.value : `${opts.key.value}\n`, { mode: 0o600 });
      chmodSync(keyFile, 0o600);
      const knownHosts = join(dir, "known_hosts");
      writeFileSync(knownHosts, (keys as string[]).map((k) => `${host} ${k}\n`).join(""));
      const ssh = [opts.ssh ?? "ssh", "-F", "/dev/null", "-i", keyFile, "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${knownHosts}`, "-o", "BatchMode=yes"];
      const env: NodeJS.ProcessEnv = { ...opts.ctx.env, GIT_SSH_COMMAND: ssh.map(shellWord).join(" "), GIT_TERMINAL_PROMPT: "0" };
      for (const v of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_SSH", "GIT_SSH_VARIANT"]) delete env[v];
      const repo = new SshGitRepo(opts.repo, host, opts.ctx, opts.git ?? "git", opts.code, dir, env);
      await repo.run(["init", "-q", "--bare", repo.dir], dir);
      return repo;
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      throw err;
    }
  }

  /** Remove the temporary directory, with the key in it. */
  close(): void {
    rmSync(this.root, { recursive: true, force: true });
  }

  private run(args: string[], cwd = this.dir, extraEnv: NodeJS.ProcessEnv = {}): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolvePromise, reject) => {
      execFile(this.git, args, { cwd, env: { ...this.env, ...extraEnv }, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err && typeof (err as NodeJS.ErrnoException).code === "string") {
          reject(new PublishTargetError(this.code, `git could not be run: ${err.message}`, "Install git on the job's PATH."));
          return;
        }
        resolvePromise({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr });
      });
    });
  }

  private async must(what: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<string> {
    const r = await this.run(args, this.dir, extraEnv);
    if (r.code !== 0) this.fail(what, r.stderr || r.stdout);
    return r.stdout;
  }

  private fail(what: string, output: string): never {
    // git's advice after an ssh failure says nothing ssh didn't, and would push ssh's own line out of the last three.
    const lines = output.split("\n").map((l) => l.trim()).filter((l) => l && !/^(Please make sure you have the correct access rights|and the repository exists\.)$/.test(l));
    throw new PublishTargetError(this.code, this.ctx.redactor.redact(`${what} on ${this.remote} failed${lines.length ? `: ${lines.slice(-3).join(" ")}` : ""}`));
  }

  /** The remote's default branch and the head of each of its branches. */
  async heads(): Promise<{ defaultBranch: string | null; heads: Map<string, string> }> {
    const out = await this.must("listing the branches", ["ls-remote", "--symref", this.remote]);
    const heads = new Map<string, string>();
    let defaultBranch: string | null = null;
    for (const line of out.split("\n")) {
      const sym = /^ref: refs\/heads\/(\S+)\tHEAD$/.exec(line);
      if (sym) defaultBranch = sym[1]!;
      const ref = /^([0-9a-f]{40,64})\trefs\/heads\/(\S+)$/.exec(line);
      if (ref) heads.set(ref[2]!, ref[1]!);
    }
    return { defaultBranch, heads };
  }

  /**
   * Fetch `branch` and return its head. `depth` 1 is enough to read it and
   * commit on it; 2 also brings its head's parent, so git sees that pushing
   * the head fast-forwards a branch at that parent.
   */
  async fetch(branch: string, depth = 1): Promise<string> {
    await this.must(`fetching ${branch}`, ["fetch", "-q", "--no-tags", `--depth=${depth}`, this.remote, `+refs/heads/${branch}:refs/remotes/tap/${branch}`]);
    return (await this.must(`reading ${branch}`, ["rev-parse", `refs/remotes/tap/${branch}`])).trim();
  }

  /** The bytes of `path` at a fetched commit, or null when it holds no such file. */
  async file(commit: string, path: string): Promise<Buffer | null> {
    const spec = `${commit}:${path}`;
    if ((await this.run(["cat-file", "-e", spec])).code !== 0) return null;
    return new Promise((resolvePromise, reject) => {
      execFile(this.git, ["cat-file", "blob", spec], { cwd: this.dir, env: this.env, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolvePromise(stdout)));
    });
  }

  /** A commit on `parent` that writes `bytes` to `path`, with `message`. Made here, not pushed. */
  async commitFile(parent: string, path: string, bytes: Uint8Array, message: string): Promise<string> {
    const blobFile = join(this.root, "blob");
    writeFileSync(blobFile, bytes);
    const blob = (await this.must("writing the file", ["hash-object", "-w", blobFile])).trim();
    const index = { GIT_INDEX_FILE: join(this.root, "index") };
    await this.must("reading the tree", ["read-tree", parent], index);
    await this.must("staging the file", ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], index);
    const tree = (await this.must("writing the tree", ["write-tree"], index)).trim();
    rmSync(index.GIT_INDEX_FILE, { force: true });
    const who = (await this.run(["config", "user.email"])).stdout.trim() ? [] : ["-c", "user.name=chant", "-c", "user.email=chant@localhost"];
    return (await this.must("committing", [...who, "-c", "commit.gpgsign=false", "commit-tree", tree, "-p", parent, "-m", message])).trim();
  }

  /**
   * Push `commit` to `branch`. `force` moves it wherever it is; without it,
   * a branch that does not fast-forward comes back `rejected`.
   */
  async push(commit: string, branch: string, force: boolean): Promise<PushResult> {
    const r = await this.run(["push", "--porcelain", this.remote, `${force ? "+" : ""}${commit}:refs/heads/${branch}`]);
    if (r.code === 0) return "ok";
    if (!force && /^!\t[^\t]*\t\[rejected\] \((non-fast-forward|fetch first)\)/m.test(r.stdout)) return "rejected";
    this.fail(`pushing ${commit.slice(0, 12)} to ${branch}`, `${r.stdout}\n${r.stderr}`);
  }

  /** Delete `branch` on the remote, if it is there. */
  async deleteBranch(branch: string): Promise<void> {
    const r = await this.run(["push", "--porcelain", this.remote, `:refs/heads/${branch}`]);
    if (r.code !== 0 && !/remote ref does not exist/.test(`${r.stdout}\n${r.stderr}`)) this.fail(`deleting ${branch}`, `${r.stdout}\n${r.stderr}`);
  }
}
