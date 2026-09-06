/**
 * Capturing what a chant command prints, so a turn can stream it (#2125).
 *
 * chant's own handlers and its activities print through `console.log` /
 * `console.error`, which means the process's stdout and stderr are where a
 * step's output actually appears — there is no per-step output channel on the
 * executor to subscribe to instead. So a turn borrows both writers for its
 * duration and forwards every chunk as an `agent_message_chunk`.
 *
 * Two consequences worth stating rather than discovering:
 *
 * - The `chant acp` process writes the protocol on stdout, so a turn MUST
 *   hold this capture over everything it runs. A stray `console.log` reaching
 *   the real stdout mid-turn is an unparseable line to the client.
 * - The capture is process-wide, so turns are serialized (see
 *   ./server.ts). One stdio connection running one command at a time is the
 *   honest shape anyway.
 *
 * Redaction is deliberately absent. A step's output is the environment's
 * output, and fountain redacts a thread's secrets on the way in — the
 * documented division of labour in ../skills/chant-fountain.md. This server
 * never reads or prints the environment it inherits.
 */

/** Where a captured chunk came from. */
export type OutputStream = "stdout" | "stderr";

/** Run `fn` with both process writers forwarded to `onChunk`, and restore them after. */
export async function withCapturedOutput<T>(
  onChunk: (text: string, stream: OutputStream) => void,
  fn: () => Promise<T>,
): Promise<T> {
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);

  const intercept =
    (stream: OutputStream) =>
    (chunk: unknown, encoding?: unknown, cb?: unknown): boolean => {
      const text =
        typeof chunk === "string"
          ? chunk
          : Buffer.isBuffer(chunk)
            ? chunk.toString("utf8")
            : String(chunk);
      if (text.length > 0) onChunk(text, stream);
      const done = typeof encoding === "function" ? encoding : cb;
      if (typeof done === "function") (done as () => void)();
      return true;
    };

  process.stdout.write = intercept("stdout") as typeof process.stdout.write;
  process.stderr.write = intercept("stderr") as typeof process.stderr.write;
  try {
    return await fn();
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}
