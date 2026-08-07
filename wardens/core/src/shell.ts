/**
 * Process-edge helpers for a warden CLI: `die`, env lookup, error formatting,
 * and the run-when-invoked-directly guard. Everything is parameterized by the
 * tool name so the shared code never guesses at argv[0].
 */

import { pathToFileURL } from "node:url";
import { CliError } from "./cli-error.js";

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export type Die = (code: number, message: string) => never;

/** `die("gitlab-warden")(2, "…")` → `gitlab-warden: error: …` on stderr + exit. */
export function makeDie(tool: string): Die {
  return (code, message) => {
    process.stderr.write(`${tool}: error: ${message}\n`);
    process.exit(code);
  };
}

/** Read a required env var; throws `CliError(2)` when unset or empty. */
export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new CliError(2, `env var ${name} is not set or is empty`);
  return v;
}

/**
 * Run `main` iff this module is the invoked entrypoint (not merely imported —
 * the e2e suites import `run()` instead). Catches anything `main` lets escape
 * as a fatal (exit 3).
 */
export function runWhenInvoked(importMetaUrl: string, tool: string, main: () => Promise<void>): void {
  const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
  if (importMetaUrl === invokedPath) {
    main().catch((err: unknown) => {
      process.stderr.write(`${tool}: fatal: ${errMsg(err)}\n`);
      process.exit(3);
    });
  }
}
