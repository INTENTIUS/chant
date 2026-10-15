/**
 * The seam between the e2b runtime and an E2B-compatible API.
 *
 * {@link StewardSandboxes} is all the runtime asks of a sandbox provider: find
 * the steward's sandbox by its metadata, make one, wake one, run a command in
 * it, list and kill its processes, keep it awake and pause it. The production
 * implementation below is a thin wrapper over the `e2b` SDK, so the runtime
 * works against hosted E2B and anything that serves E2B's API (loam, for one);
 * a test hands the runtime a fake and drives the whole path with no network.
 */

/** The metadata key a steward's sandbox is found by. */
export const STEWARD_METADATA_KEY = "chant/steward";

/** The environment variables that mark a process in the sandbox as a chant run. */
export const RUN_OP_ENV = "CHANT_E2B_OP";
export const RUN_ID_ENV = "CHANT_E2B_RUN";
export const RUN_STARTED_ENV = "CHANT_E2B_STARTED";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunCommandOptions {
  envs?: Record<string, string>;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /** Called with the process id once the command has started. */
  onStart?: (pid: number) => void;
}

export interface SandboxProcess {
  pid: number;
  envs: Record<string, string>;
}

/** One steward's sandbox, awake. */
export interface StewardSandbox {
  readonly id: string;
  /** Run `bash -c <script>` to completion, however long it takes. A non-zero exit is a result, not a throw. */
  run(script: string, opts?: RunCommandOptions): Promise<CommandResult>;
  processes(): Promise<SandboxProcess[]>;
  kill(pid: number): Promise<void>;
  /** Hold the sandbox awake for `ms` from now. When that runs out it pauses rather than dying. */
  keepAwake(ms: number): Promise<void>;
  pause(): Promise<void>;
}

export interface StewardSandboxes {
  /** The steward's sandbox, running or paused, or `undefined` when it has none. */
  find(steward: string): Promise<{ id: string; state: string } | undefined>;
  /** Make the steward's sandbox. It pauses, rather than dies, when it is left alone. */
  create(steward: string, opts: { template: string; awakeMs: number }): Promise<StewardSandbox>;
  /** Wake (or reach) a sandbox by id. */
  connect(id: string, opts: { awakeMs: number }): Promise<StewardSandbox>;
}

export interface E2bConnection {
  apiKey: string;
  /** Omitted: the SDK's own default. */
  domain?: string;
}

/** The production seam, over the `e2b` SDK. The SDK is imported on first use, so loading the plugin costs nothing. */
export function e2bSandboxes(conn: E2bConnection): StewardSandboxes {
  const base = { apiKey: conn.apiKey, ...(conn.domain ? { domain: conn.domain } : {}) };
  const sdk = () => import("e2b");

  const wrap = (sb: import("e2b").Sandbox): StewardSandbox => ({
    id: sb.sandboxId,
    async run(script, opts = {}) {
      const { CommandExitError } = await sdk();
      // `timeoutMs: 0` lifts the SDK's one-minute default: an op runs as long as it runs.
      const handle = await sb.commands.run(script, {
        background: true,
        timeoutMs: 0,
        ...(opts.envs ? { envs: opts.envs } : {}),
        ...(opts.onStdout ? { onStdout: opts.onStdout } : {}),
        ...(opts.onStderr ? { onStderr: opts.onStderr } : {}),
      });
      opts.onStart?.(handle.pid);
      try {
        const done = await handle.wait();
        return { exitCode: done.exitCode, stdout: done.stdout, stderr: done.stderr };
      } catch (err) {
        if (err instanceof CommandExitError) return { exitCode: err.exitCode, stdout: err.stdout, stderr: err.stderr };
        throw err;
      }
    },
    async processes() {
      return (await sb.commands.list()).map((p) => ({ pid: p.pid, envs: p.envs ?? {} }));
    },
    async kill(pid) {
      await sb.commands.kill(pid);
    },
    async keepAwake(ms) {
      await sb.setTimeout(ms);
    },
    async pause() {
      await sb.pause();
    },
  });

  return {
    async find(steward) {
      const { Sandbox } = await sdk();
      const page = await Sandbox.list({
        ...base,
        query: { metadata: { [STEWARD_METADATA_KEY]: steward }, state: ["running", "paused"] },
        limit: 2,
      }).nextItems();
      if (page.length > 1) {
        throw new Error(
          `e2b runtime: ${page.length} sandboxes carry ${STEWARD_METADATA_KEY}=${steward}. ` +
            `A steward is one machine; kill all but one (${page.map((s) => s.sandboxId).join(", ")}).`,
        );
      }
      return page[0] ? { id: page[0].sandboxId, state: page[0].state } : undefined;
    },
    async create(steward, opts) {
      const { Sandbox } = await sdk();
      const sb = await Sandbox.create(opts.template, {
        ...base,
        timeoutMs: opts.awakeMs,
        metadata: { [STEWARD_METADATA_KEY]: steward },
        // Run out of time paused, not killed: the disk, and the memory, are the steward.
        lifecycle: { onTimeout: "pause" },
      });
      return wrap(sb);
    },
    async connect(id, opts) {
      const { Sandbox } = await sdk();
      return wrap(await Sandbox.connect(id, { ...base, timeoutMs: opts.awakeMs }));
    },
  };
}
