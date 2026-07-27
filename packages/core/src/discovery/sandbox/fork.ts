import { fork } from "node:child_process";

/**
 * The one place chant starts a sandboxed child process.
 *
 * Extracted from `./run.ts` by chant #1113, which added a SECOND thing that
 * has to run behind the same boundary (`chant.config.ts` evaluation, see
 * `./config-run.ts`). Both callers must get the identical `--permission`
 * profile and the identical environment scrub — if the two drifted, the
 * weaker one would silently become the boundary. Keeping the spawn itself in
 * one function is the cheapest way to make "same profile" a fact rather than
 * a claim.
 *
 * Isolation mechanics (verified on Node v24.13.1 — see the chant#1045 PR
 * description for the full write-up):
 *  - `--permission --allow-fs-read=<bundle dir>,<project dir>[,<trusted
 *    external package dirs>]` — no filesystem write, no child-process, no
 *    worker-thread access. Bundling with esbuild first (`./bundle.ts`) means
 *    the child needs NO TypeScript loader (no `tsx`, so no `--allow-worker`
 *    and no writable temp dir either).
 *  - The env is a spawn-time scrub, not `--permission`: Node's Permission
 *    Model does not gate `process.env` at all (confirmed: every key stays
 *    readable even under `--permission`). See {@link SandboxForkOptions.env}.
 *  - Network egress is NOT addressed — Node has no flag for it. See
 *    `docs/.../architecture/sandbox.mdx` for the residual-risk statement.
 */

export interface SandboxForkOptions {
  /** Absolute, realpath'd path to the bundled ESM entry file to run. */
  bundlePath: string;
  /** Absolute, realpath'd directory holding {@link bundlePath} — granted `--allow-fs-read`. */
  bundleDir: string;
  /** Absolute, realpath'd project directory — granted `--allow-fs-read`. */
  projectRealpath: string;
  /** Additional directories to grant `--allow-fs-read` (the resolved locations of `./bundle.ts`'s deliberately-unbundled trusted packages). */
  externalReadPaths: readonly string[];
  /**
   * The child's ENTIRE environment. Callers pass an explicit, closed set —
   * never a spread of `process.env`. `./run.ts` passes `PATH` only;
   * `./config-run.ts` adds `CHANT_ENV` (see its doc for why that one
   * variable, and only that one, is forwarded).
   */
  env: Record<string, string>;
  /** How long to wait for the child's one IPC message before killing it. */
  timeoutMs: number;
  /** What timed out / exited early, for the error message (e.g. `"sandboxed run"`). */
  label: string;
}

/**
 * Fork `bundlePath` under `--permission` with a scrubbed environment, and
 * resolve with the first IPC message that satisfies `isResponse` (or reject
 * on crash / timeout / fork error).
 */
export function forkSandboxed<T>(
  options: SandboxForkOptions,
  isResponse: (value: unknown) => value is T,
): Promise<T> {
  const { bundlePath, bundleDir, projectRealpath, externalReadPaths, env, timeoutMs, label } = options;

  return new Promise((resolvePromise, reject) => {
    const readAllowances = [bundleDir, projectRealpath, ...externalReadPaths].map(
      (p) => `--allow-fs-read=${p}`,
    );
    const child = fork(bundlePath, [], {
      execArgv: ["--permission", ...readAllowances],
      env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });

    let settled = false;
    let stderrBuf = "";

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });

    child.on("message", (msg: unknown) => {
      if (settled || !isResponse(msg)) return;
      settled = true;
      clearTimeout(timeout);
      resolvePromise(msg);
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });

    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(
        new Error(
          `${label}: child exited before reporting results (code ${code}, signal ${signal})${stderrBuf.trim() ? `: ${stderrBuf.trim()}` : ""}`,
        ),
      );
    });
  });
}
