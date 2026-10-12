/**
 * Exiting without truncating piped output, shared by the full CLI (`./main.ts`)
 * and the slim wave-job runtime (`../wave-runtime.ts`, #3896).
 */

/**
 * Wait until a writable stream has flushed its buffer. `process.exit()` discards
 * data still buffered for an async sink (a pipe or file), truncating large output
 * at the ~64 KB pipe buffer — so `chant graph --format ir` piped into a consumer
 * loses everything past 64 KB and its JSON won't parse. A TTY writes
 * synchronously (`writableLength` stays 0), so this is a no-op there. Resolves on
 * `error`/`close` too, so a reader that closes early (EPIPE) can't hang exit.
 */
export function waitForStreamDrain(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    const tick = (): void => {
      if (stream.writableLength === 0 || stream.writableEnded || stream.destroyed) {
        cleanup();
        resolve();
        return;
      }
      stream.once("drain", tick);
    };
    const stop = (): void => {
      cleanup();
      resolve();
    };
    const cleanup = (): void => {
      stream.off("drain", tick);
      stream.off("error", stop);
      stream.off("close", stop);
    };
    stream.once("error", stop);
    stream.once("close", stop);
    tick();
  });
}

/** Flush stdout+stderr, then exit — so a large piped payload isn't truncated. */
export async function flushAndExit(code: number): Promise<never> {
  await waitForStreamDrain(process.stdout);
  await waitForStreamDrain(process.stderr);
  process.exit(code);
}
