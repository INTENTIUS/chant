/**
 * git for the harness's driver, from the fan-out demo's lib/git.ts, with one
 * guard: every git command runs in a directory whose own `.git` is the
 * repository, outside the checkout the driver runs from. A clone that failed
 * would otherwise leave git to find that checkout's repository above it, and
 * the driver would push or approve there.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

/** Whether `dir` is `checkout` or below it. */
export function insideCheckout(dir: string, checkout: string): boolean {
  const rel = relative(realpathSync(checkout), realpathSync(dir));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

/** Refuse a directory that is in `checkout` (when given) or has no `.git` of its own. */
export function assertOwnRepo(dir: string, checkout?: string): void {
  if (checkout && insideCheckout(dir, checkout)) throw new Error(`${dir} is inside ${checkout}; the driver's git work stays outside it`);
  if (!existsSync(join(dir, ".git"))) throw new Error(`${dir} has no .git of its own`);
}

/** A new empty directory under the system temp dir. */
export function freshDir(name: string, prefix = "chant-e2e"): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-${name}-`));
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  /** Secrets blanked in an error. */
  redact?: string[];
}

/** Run a program, rejecting with its last stderr lines. */
export function run(file: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolveRun, reject) => {
    const child = execFile(
      file,
      args,
      { cwd: opts.cwd, env: opts.env ?? process.env, timeout: opts.timeoutMs ?? 300_000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) return resolveRun({ stdout: String(stdout), stderr: String(stderr) });
        let text = `${file} ${args[0] ?? ""} failed: ${String(stderr).trim().split("\n").slice(-3).join(" / ") || err.message}`;
        for (const secret of opts.redact ?? []) if (secret) text = text.split(secret).join("***");
        reject(new Error(text));
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

const gitEnv = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_TERMINAL_PROMPT: "0" });

/** git bound to a checkout the driver must stay out of. */
export interface GuardedGit {
  /** git in `dir`, which must be its own repository outside the checkout. */
  git(dir: string, args: string[], redact?: string[]): Promise<string>;
  /** Clone `remote` into a fresh directory outside the checkout. */
  clone(remote: string, name: string, redact?: string[]): Promise<string>;
  assertOwnRepo(dir: string): void;
}

export function guardedGit(checkout?: string, prefix = "chant-e2e"): GuardedGit {
  const own = (dir: string) => assertOwnRepo(dir, checkout);
  return {
    assertOwnRepo: own,
    async git(dir, args, redact = []) {
      own(dir);
      return (await run("git", ["-C", dir, ...args], { env: gitEnv(), redact })).stdout.trim();
    },
    async clone(remote, name, redact = []) {
      const dir = freshDir(name, prefix);
      await run("git", ["clone", "-q", remote, dir], { env: gitEnv(), redact });
      own(dir);
      return dir;
    },
  };
}

/** An http remote with a login and token in it. */
export function remoteWith(url: string, login: string, token: string, repo: string): string {
  const u = new URL(url);
  u.username = login;
  u.password = token;
  return `${u.toString().replace(/\/$/, "")}/${repo}.git`;
}
