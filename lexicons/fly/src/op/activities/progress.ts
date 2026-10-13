/**
 * Progress output for the fly Op activities (#2516, #3200).
 *
 * An Op step's stdout is its output, so activities write their progress lines
 * ("created: sprite/x", "pruned: ...") to stderr and keep stdout free for
 * machine-readable results.
 */
export function logProgress(line: string): void {
  process.stderr.write(`${line}\n`);
}
