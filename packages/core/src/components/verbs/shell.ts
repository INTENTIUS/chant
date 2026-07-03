/**
 * escape hatch family — `shell`. Typed, but flagged: a raw shell step run by
 * exactly one component is the "capability-per-component" smell the model
 * exists to avoid (see docs/components/capabilities.mdx#the-discipline).
 * `reason` is required so lint (a later phase — COMP* rules, #562) can flag an
 * escape hatch used without a stated justification.
 *
 * Typed stub only; see ../capability.ts for the "no cloud implementation yet" contract.
 */

import type { Capability } from "../capability";
import { stubCapability } from "./stub";

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
  /** Process exit code. */
  exitCode: number;
}

/** Run an arbitrary shell command. The escape hatch — typed, but lint-flagged; requires a `reason`. */
export const shell: Capability<ShellInput, ShellOutput> = stubCapability("shell");
