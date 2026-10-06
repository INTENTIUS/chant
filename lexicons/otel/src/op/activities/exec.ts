/**
 * How the otel activities run a binary: a child process whose exit code,
 * stdout and stderr are returned rather than thrown, so the caller decides
 * what a non-zero exit means. Tests pass their own runner.
 */

import { execFile } from "node:child_process";

export interface ExecResult {
  /** The exit code, or null when the binary could not be started. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Why the binary could not be started (ENOENT and the like). */
  error?: string;
}

export type ExecRunner = (bin: string, args: string[], opts?: { cwd?: string; timeoutMs?: number }) => Promise<ExecResult>;

export const defaultExec: ExecRunner = (bin, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(
      bin,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? 120_000, maxBuffer: 32 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout, stderr });
        const e = err as NodeJS.ErrnoException & { code?: unknown };
        if (typeof e.code === "number") return resolve({ code: e.code, stdout, stderr });
        resolve({ code: null, stdout: stdout ?? "", stderr: stderr ?? "", error: e.message });
      },
    );
  });
