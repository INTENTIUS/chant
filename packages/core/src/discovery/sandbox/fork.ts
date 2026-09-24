import { fork, type ChildProcess } from "node:child_process";

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
 * chant #1148 — this is also the one place chant forwards a sandboxed
 * child's own stdout/stderr, so `./run.ts`, `./config-run.ts` and
 * `./policy-run.ts` cannot drift on whether project output vanishes. See
 * {@link SandboxForkOptions.outputPrefix}.
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
  /**
   * chant #1148 — prepended to every line the child writes on EITHER stdout
   * or stderr before it is relayed, line-buffered, to this process's own
   * stderr (e.g. `"[sandbox:run]"`, `"[sandbox:config]"`,
   * `"[policy:org.ts]"`).
   *
   * A sandboxed child's `console.log`/`console.error` used to go nowhere: its
   * stdout was piped but never read, and its stderr was captured only into
   * {@link stderrBuf}'s error-message use, never surfaced on a successful
   * run. Diagnostics crossing as data (the whole point of the boundary) is
   * not the same thing as incidental output being silently dropped — chant's
   * stance is that nothing the project prints vanishes, sandboxed or not.
   *
   * This is forwarding, not a second capture: {@link stderrBuf} still
   * accumulates the child's raw stderr for `classifyChildError`/the
   * exited-before-reporting message exactly as before. Both read the same
   * `data` events; one buffers for classification, this one relays for a
   * human to see.
   */
  outputPrefix: string;
  /**
   * chant #1131 — an optional payload sent to the child over the SAME IPC
   * channel its response comes back on, immediately after the fork.
   *
   * The run and config children are fully described by their generated driver
   * source, so they need nothing inbound. The policy child does: its input is
   * the finished build result, which exists only after the parent has merged
   * and serialized, long after the bundle was built. Sending it rather than
   * baking it into a source literal keeps the bundle small (esbuild would
   * otherwise parse a multi-megabyte literal) and keeps it off disk.
   *
   * Safe to send before the child has booted: `child.send` writes to the IPC
   * pipe and Node queues the message until the child's channel is read, and
   * the driver registers its `process.on("message", …)` synchronously at module
   * top level — before the event loop can deliver anything. This is NOT a
   * second protocol: same channel, same JSON, same one-message-back response.
   */
  send?: Record<string, unknown>;
}

/**
 * chant #1148 — buffers arbitrary chunks and calls `emit` once per complete
 * line, never on a chunk boundary that happens to split a line in two (a
 * pipe makes no promise that one `write()` on the child's side arrives as one
 * `data` event on ours). `flush()` emits whatever partial line never got a
 * trailing newline, so the last unterminated write doesn't silently vanish
 * when the stream ends — the same no-dropping stance this whole feature
 * exists for.
 */
function lineBuffered(emit: (line: string) => void) {
  let pending = "";
  return {
    push(chunk: Buffer | string): void {
      pending += chunk.toString();
      let newlineAt = pending.indexOf("\n");
      while (newlineAt !== -1) {
        emit(pending.slice(0, newlineAt));
        pending = pending.slice(newlineAt + 1);
        newlineAt = pending.indexOf("\n");
      }
    },
    flush(): void {
      if (pending.length > 0) {
        emit(pending);
        pending = "";
      }
    },
  };
}

/**
 * Fork `bundlePath` under `--permission` with a scrubbed environment, and
 * resolve with the first IPC message that satisfies `isResponse` (or reject
 * on crash / timeout / fork error).
 */
/**
 * Why a child ended without a usable result, in terms a reader can act on.
 *
 * chant#2461 — this used to be one sentence, `child exited before reporting
 * results (code N, signal S)`, for three unrelated situations. The one that
 * was observed in the wild is the hardest to read: exit code 0, empty stderr,
 * no message. That reads like the child was cut off, and it was not: it ran
 * to completion.
 *
 * The observed case turned out to be the parent's fault. A config child that
 * sent its result and exited could have its `exit` dispatched here BEFORE its
 * already-written `message`, and the old `exit` handler settled on the spot.
 * The payload arrived a moment later and was ignored. Stress runs of the real
 * `evaluateConfigSandboxed`, 24 at a time under 16 CPU hogs, lost 3 of 800 and
 * 13 of 1500 that way. An earlier test that blocked the parent had seen
 * `message` win 60 of 60, which is why this was ruled out for a while.
 * {@link settleOnExitAfterChannelDrains} closes it by not reading the exit
 * until the IPC channel has drained. Every driver also awaits its
 * `process.send` callback and exits 1 with a stderr line if the send fails
 * (see `./driver.ts`'s `sendFunctionSource`), so a result that never left the
 * child cannot look like exit 0 either.
 *
 * With both of those in place, exit 0 with nothing on stderr and nothing
 * received has one known cause left: an `await` that never settles.
 * `main().catch(...)` catches a REJECTION, and a promise that never settles is
 * not one, so if nothing keeps the loop alive Node drains it and exits 0
 * having sent nothing. On the RUN path that is reproducible: the driver does
 * `await import(<project file>)` per run-fallback file, module scope is
 * arbitrary project source, and a file whose top level never settles makes
 * that import never complete (the run driver names the file on stderr in that
 * case). The CONFIG driver bundles to one microtask over synchronous code with
 * no runtime imports, so on that path the cause is not known, and the message
 * says so rather than guessing.
 */
function describeSilentExit(
  label: string,
  code: number | null,
  signal: NodeJS.Signals | null,
  stderrBuf: string,
  unrecognised: readonly unknown[],
): string {
  const stderr = stderrBuf.trim();
  const head = `${label}: child exited before reporting results (code ${code}, signal ${signal})`;

  if (unrecognised.length > 0) {
    // It DID send. The parent refused the shape, which is a bug in one of them
    // and not the child dying early.
    const shapes = unrecognised
      .map((m) => (m && typeof m === "object" ? `{${Object.keys(m as object).join(", ")}}` : typeof m))
      .join(", ");
    return (
      `${head}. It sent ${unrecognised.length} message(s) the parent did not recognise (${shapes}), ` +
      `so the payload shape and the parent's check disagree` +
      (stderr ? `: ${stderr}` : "")
    );
  }

  if (stderr) return `${head}: ${stderr}`;
  if (code !== 0 || signal !== null) return head;

  // Exit 0, nothing on stderr, and nothing received even after the IPC
  // channel drained. See this function's doc for what is and is not left.
  return (
    `${head}. It exited cleanly with nothing on stderr, and no message arrived even after its ` +
    `IPC channel closed, so it never sent one: something it awaited never settled. On the run ` +
    `path the usual cause is a project file with a top-level \`await\` that does not settle. ` +
    `Module scope is arbitrary project source, an import of such a file never completes, and a ` +
    `promise that never settles is not a rejection, so the driver's own \`main().catch\` does ` +
    `not see it either. The config driver has nothing to await that can hang, and a failed ` +
    `send exits non-zero with a reason on stderr, so on the config path this has no known ` +
    `cause: please report it with the command that produced it (chant#2461).`
  );
}

/** How long {@link settleOnExitAfterChannelDrains} waits, after exit, for the IPC channel to report closed. Normally it takes well under a millisecond; this only bounds a channel that never does. */
const EXIT_DRAIN_GRACE_MS = 2_000;

/**
 * chant#2461 — call `onExit` once `child` has exited AND its IPC channel has
 * drained, so a message the child wrote before exiting is always dispatched
 * first.
 *
 * Node does not order `exit` after `message`. The child's exit and the last
 * bytes on the IPC socket reach the parent's event loop as separate events,
 * and under load the exit can be handled first even though the child wrote
 * the message before it exited. Settling on `exit` alone then drops a payload
 * that is already sitting in the socket. The channel reports `disconnect`
 * only after it has read EOF, which comes after every message the child
 * wrote, so waiting for it is exact.
 *
 * This is deliberately not `close`. `close` also waits for stdout and stderr
 * to end, and a grandchild holding those pipes would turn a fast failure into
 * the full timeout. The wait here is on the IPC channel alone, and is bounded
 * by `graceMs` in case that channel never reports closed.
 */
export function settleOnExitAfterChannelDrains(
  child: ChildProcess,
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void,
  graceMs = EXIT_DRAIN_GRACE_MS,
): void {
  child.on("exit", (code, signal) => {
    let done = false;
    let grace: NodeJS.Timeout | undefined;
    const finish = (): void => {
      if (done) return;
      done = true;
      if (grace !== undefined) clearTimeout(grace);
      onExit(code, signal);
    };
    if (!child.connected) {
      finish();
      return;
    }
    child.once("disconnect", finish);
    grace = setTimeout(finish, graceMs);
  });
}

export function forkSandboxed<T>(
  options: SandboxForkOptions,
  isResponse: (value: unknown) => value is T,
): Promise<T> {
  const { bundlePath, bundleDir, projectRealpath, externalReadPaths, env, timeoutMs, label, send, outputPrefix } =
    options;

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
    /** Messages the child sent that `isResponse` refused — see the `message` handler. */
    const unrecognised: unknown[] = [];

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    if (send !== undefined) {
      child.send(send, (err) => {
        if (settled || !err) return;
        settled = true;
        clearTimeout(timeout);
        child.kill();
        reject(new Error(`${label}: failed to send the child its input: ${err.message}`));
      });
    }

    // chant #1148 — forward, don't just capture. Both streams write to THIS
    // process's stderr, prefixed and line-buffered, independent of
    // `stderrBuf` below (which keeps accumulating raw stderr for
    // `classifyChildError`'s use — forwarded and captured are not mutually
    // exclusive, the same bytes feed both).
    const forwardLine = (line: string): void => {
      process.stderr.write(`${outputPrefix} ${line}\n`);
    };
    const stdoutForwarder = lineBuffered(forwardLine);
    const stderrForwarder = lineBuffered(forwardLine);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutForwarder.push(chunk);
    });
    child.stdout?.on("end", () => stdoutForwarder.flush());

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      stderrForwarder.push(chunk);
    });
    child.stderr?.on("end", () => stderrForwarder.flush());

    child.on("message", (msg: unknown) => {
      if (settled) return;
      if (!isResponse(msg)) {
        // chant#2461 — remember it rather than dropping it. A child that sent
        // something the parent does not recognise is a different failure from
        // a child that sent nothing, and both used to arrive as "exited before
        // reporting results" with no way to tell them apart.
        unrecognised.push(msg);
        return;
      }
      settled = true;
      clearTimeout(timeout);
      // chant #1131 — the child's entire job is to send this one message, so
      // once it has arrived there is nothing left to wait for. Killing it here
      // rather than hoping it exits on its own closes a real hang: an open
      // handle on the child side (a `setInterval` in project source, an
      // `http.Server` a policy started, or simply an IPC listener the driver
      // registered to RECEIVE its input) keeps the child's event loop alive,
      // and a live IPC channel then keeps the PARENT's alive too. `chant build`
      // never noticed because `cli/main.ts` ends with `process.exit`; anything
      // embedding chant as a library would have hung forever.
      child.kill();
      resolvePromise(msg);
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });

    // chant#2461 — not `child.on("exit")`: a payload can still be in the IPC
    // socket when the exit is handled. See settleOnExitAfterChannelDrains.
    settleOnExitAfterChannelDrains(child, (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(describeSilentExit(label, code, signal, stderrBuf, unrecognised)));
    });
  });
}
