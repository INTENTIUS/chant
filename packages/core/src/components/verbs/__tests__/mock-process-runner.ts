/**
 * `MockProcessRunner` — an in-memory fake of `ProcessRunner`
 * (../process-runner.ts) for tests. No live `syft`/`buildx`/
 * `cyclonedx-maven`/`cdxgen`/`oras`, no child process spawned at all: every
 * call is recorded, and `run`/`available` return scripted results — the same
 * convention `../__tests__/mock-cloud-executor.ts` uses for `CloudExecutor`.
 *
 * Every test that exercises a #610 real backend (`ToolSbomGenerator`,
 * `OrasReferrerLookup`, `publish-image`'s referrer-attach step) builds one
 * `MockProcessRunner`, scripts which tools are "installed" and what each
 * command's canned stdout is, and passes it in — never touching the real,
 * `child_process`-backed runner.
 */

import type { ProcessResult, ProcessRunner, RunOptions } from "../process-runner";

export interface RecordedProcessCall {
  command: string;
  options?: RunOptions;
}

export interface MockProcessRunnerOptions {
  /** Which tools `available()` reports as installed. Default: every tool is available (opt a test into "missing tool" by naming it here with `false`, or by omitting it when `defaultAvailable` is `false`). */
  tools?: Record<string, boolean>;
  /** `available()`'s answer for a tool not named in `tools`. Default: `true` (most tests aren't about the missing-tool path). */
  defaultAvailable?: boolean;
  /**
   * Canned stdout per command, matched by a substring (the first entry whose
   * key is included in the command string wins) — this is deliberately loose
   * rather than an exact-string map, since the SUT constructs full shell
   * command lines the test doesn't want to hand-reconstruct byte-for-byte
   * just to script a response.
   */
  responses?: Record<string, string>;
  /** Command substrings that should reject (simulates the tool exiting non-zero), mapped to the error message. */
  failures?: Record<string, string>;
}

export interface MockProcessRunner {
  runner: ProcessRunner;
  calls: RecordedProcessCall[];
  /** Change a tool's reported availability after construction. */
  setAvailable(tool: string, available: boolean): void;
  /** Script (or replace) a command substring's canned stdout after construction. */
  setResponse(commandSubstring: string, stdout: string): void;
}

/** Build a fresh mock `ProcessRunner`. Every method is deterministic and synchronous-fast — no real process spawned, no real delay. */
export function createMockProcessRunner(options: MockProcessRunnerOptions = {}): MockProcessRunner {
  const calls: RecordedProcessCall[] = [];
  const tools = new Map<string, boolean>(Object.entries(options.tools ?? {}));
  const responses = new Map<string, string>(Object.entries(options.responses ?? {}));
  const failures = new Map<string, string>(Object.entries(options.failures ?? {}));
  const defaultAvailable = options.defaultAvailable ?? true;

  const runner: ProcessRunner = {
    async run(command: string, runOptions?: RunOptions): Promise<ProcessResult> {
      calls.push({ command, options: runOptions });
      for (const [substring, message] of failures) {
        if (command.includes(substring)) throw new Error(message);
      }
      for (const [substring, stdout] of responses) {
        if (command.includes(substring)) return { stdout, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
    async available(tool: string): Promise<boolean> {
      calls.push({ command: `command -v ${tool}` });
      return tools.has(tool) ? tools.get(tool)! : defaultAvailable;
    },
  };

  return {
    runner,
    calls,
    setAvailable: (tool, available) => tools.set(tool, available),
    setResponse: (commandSubstring, stdout) => responses.set(commandSubstring, stdout),
  };
}
