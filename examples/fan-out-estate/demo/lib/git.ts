/**
 * git for the driver, with one guard: every git command runs in a directory
 * whose own `.git` is the repository, outside the chant checkout. A clone that
 * failed would otherwise leave git to find the checkout's repository above
 * it, and the driver would push or approve there. The demo only ever writes
 * to its own forge repo.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

/** The chant checkout this file is in. */
export const CHECKOUT = resolve(import.meta.dirname, "..", "..", "..", "..");

/** Whether `dir` is the checkout or below it. */
export function insideCheckout(dir: string, checkout: string = CHECKOUT): boolean {
  const rel = relative(realpathSync(checkout), realpathSync(dir));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

/** Refuse a directory that is in the checkout or has no `.git` of its own. */
export function assertOwnRepo(dir: string): void {
  if (insideCheckout(dir)) throw new Error(`${dir} is inside the chant checkout; the demo's git work stays outside it`);
  if (!existsSync(join(dir, ".git"))) throw new Error(`${dir} has no .git of its own`);
}

/** A new empty directory for a clone, under the system temp dir. */
export function freshDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `chant-fan-out-demo-${name}-`));
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

/** Run a program, rejecting with its last stderr line. Secrets in `redact` are blanked in the error. */
export function run(
  file: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number; redact?: string[] } = {},
): Promise<RunResult> {
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

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

/** git in `dir`, which must be its own repository outside the checkout. */
export async function git(dir: string, args: string[], redact: string[] = []): Promise<string> {
  assertOwnRepo(dir);
  return (await run("git", ["-C", dir, ...args], { env: GIT_ENV, redact })).stdout.trim();
}

/** Clone `remote` into a fresh directory outside the checkout. */
export async function clone(remote: string, name: string, redact: string[] = []): Promise<string> {
  const dir = freshDir(name);
  await run("git", ["clone", "-q", remote, dir], { env: GIT_ENV, redact });
  assertOwnRepo(dir);
  return dir;
}

/** An http remote with a login and token in it. */
export function remoteWith(url: string, login: string, token: string, repo: string): string {
  const u = new URL(url);
  u.username = login;
  u.password = token;
  return `${u.toString().replace(/\/$/, "")}/${repo}.git`;
}
