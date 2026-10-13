/**
 * escape hatch family — `shell`. Typed, but flagged: a raw shell step run by
 * exactly one component is the "capability-per-component" smell the model
 * exists to avoid (see docs/components/capabilities.mdx#the-discipline).
 * `reason` is required so lint (COMP006) can flag an escape hatch used without
 * a stated justification.
 */

import type { Capability } from "../capability";
import { defaultProcessRunner, q, type ProcessRunner } from "./process-runner";
import { releaseEnvironment } from "../../telemetry-attribution";

export interface ShellInput {
  /** Command to run. */
  cmd: string;
  /** Working directory. Default: process cwd. */
  cwd?: string;
  /** Additional environment variables. */
  env?: Record<string, string>;
  /** Required justification for reaching past the capability set — lint-checked. */
  reason: string;
}

export interface ShellOutput {
  /** Captured stdout. */
  stdout: string;
  /** Process exit code. Always 0 on success — a non-zero exit rejects the run. */
  exitCode: number;
}

/**
 * Run an arbitrary shell command through the injectable {@link ProcessRunner}.
 * The escape hatch — typed, lint-flagged, and requires a `reason`. A non-zero
 * exit rejects (with the command's own stderr), failing the step like any other
 * capability error, so `onFailure`/rollback fires.
 */
export function createShellCapability(processRunner: ProcessRunner = defaultProcessRunner()): Capability<ShellInput, ShellOutput> {
  return {
    kind: "shell",
    async run(ctx, input) {
      // A release run exports its attributes (#3061, ws-081), so a `docker compose up` here fills the
      // Compose file's `${CHANT_RELEASE_ATTRIBUTES:-}`. A value the step sets itself wins.
      const env = { ...releaseEnvironment(ctx.release), ...(input.env ?? {}) };
      const envPrefix =
        Object.keys(env).length > 0
          ? `env ${Object.entries(env).map(([k, v]) => `${k}=${q(v)}`).join(" ")} `
          : "";
      const { stdout } = await processRunner.run(`${envPrefix}${input.cmd}`, { cwd: input.cwd });
      return { stdout, exitCode: 0 };
    },
  };
}

/** Default `shell` capability, backed by the real process runner. */
export const shellCapability: Capability<ShellInput, ShellOutput> = createShellCapability();
