/**
 * Injectable external-process boundary for the #610 deep-scan/attach
 * backends (`ToolSbomGenerator` in ./tool-sbom-generator.ts,
 * `OrasReferrerLookup` in ../../lifecycle/oras-referrer-lookup.ts, and
 * `publish-image`'s referrer-attach step in ./publish.ts). Mirrors
 * ./cloud-executor.ts's `CloudExecutor` pattern exactly: production code gets
 * a `RealProcessRunner` that shells out via `node:child_process`, tests get a
 * `MockProcessRunner` (./__tests__/mock-process-runner.ts) that records calls
 * and returns canned output — no live `syft`/`buildx`/`cyclonedx-maven`/
 * `cdxgen`/`oras`, ever, in a test run.
 *
 * Kept deliberately narrower than `CloudExecutor`: every one of #610's real
 * backends reduces to "run this external CLI, capture stdout, tell me if the
 * tool exists" — a single `ProcessRunner` interface (`run` + `available`)
 * covers `syft`, `docker buildx`, `cyclonedx-maven`, `cdxgen`, and `oras`
 * alike, rather than one bespoke client per tool the way `CloudExecutor`
 * models AWS's genuinely distinct service APIs (CloudFormation, ECS,
 * CodeDeploy, ...).
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/** One external command invocation's result. */
export interface ProcessResult {
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** Working directory the command runs in. Defaults to the current process cwd. */
  cwd?: string;
  /** Max buffer size for stdout/stderr, matching ./cloud-executor.ts's `run`'s 64MB allowance (SBOM/BOM documents can be large). */
  maxBuffer?: number;
}

/**
 * Injectable boundary for shelling out to a deep-scan/attach CLI tool and for
 * checking whether one is installed. A real implementation runs the command
 * via `node:child_process`; every method here is injected so tests substitute
 * `MockProcessRunner` (./__tests__/mock-process-runner.ts) and never invoke a
 * real tool.
 */
export interface ProcessRunner {
  /** Run a shell command, returning its stdout/stderr. Rejects (with the tool's own stderr in the error) on a non-zero exit. */
  run(command: string, options?: RunOptions): Promise<ProcessResult>;
  /** True if `tool` (a CLI binary name, e.g. "syft", "oras") resolves on `PATH`. Never throws — a missing tool is a normal, expected outcome the caller checks before attempting to `run` it. */
  available(tool: string): Promise<boolean>;
}

/** Shell-quote a single argument for POSIX shells (wrap in single quotes, escaping embedded ones) — same convention as ./cloud-executor.ts's `q`. */
export function q(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const realProcessRunner: ProcessRunner = {
  async run(command, options) {
    return execAsync(command, {
      cwd: options?.cwd,
      maxBuffer: options?.maxBuffer ?? 64 * 1024 * 1024,
    });
  },
  async available(tool) {
    try {
      // `command -v` is POSIX-portable (works in sh/bash/zsh) and prints
      // nothing to stderr for a normal miss, unlike `which` on some systems.
      await execAsync(`command -v ${q(tool)}`);
      return true;
    } catch {
      return false;
    }
  },
};

/** Build a `ProcessRunner` that shells out for real via `node:child_process`. Never used in tests. */
export function realProcessExecutor(): ProcessRunner {
  return realProcessRunner;
}

/** Lazily-constructed process-wide default, mirroring ./cloud-executor.ts's `defaultCloudExecutor`. */
let defaultRunner: ProcessRunner | undefined;

/** The default `ProcessRunner` each real #610 backend falls back to when none is supplied. */
export function defaultProcessRunner(): ProcessRunner {
  if (!defaultRunner) defaultRunner = realProcessExecutor();
  return defaultRunner;
}

/**
 * Thrown when a #610 real backend needs a CLI tool that `ProcessRunner.available`
 * reports as absent — the "graceful, actionable error if the tool is absent"
 * #610 asks for, distinct from a generic `Error` so callers (and tests) can
 * assert on it specifically, mirroring `SbomGeneratorNotImplementedError`'s
 * role in ./sbom-generator.ts.
 */
export class ToolNotAvailableError extends Error {
  constructor(
    public readonly tool: string,
    public readonly purpose: string,
  ) {
    super(`"${tool}" is not installed or not on PATH — required to ${purpose}. Install it and retry.`);
    this.name = "ToolNotAvailableError";
  }
}

/** Throw `ToolNotAvailableError` unless `tool` is available, per `runner.available`. Shared guard every #610 real backend calls before shelling out. */
export async function requireTool(runner: ProcessRunner, tool: string, purpose: string): Promise<void> {
  if (!(await runner.available(tool))) {
    throw new ToolNotAvailableError(tool, purpose);
  }
}
