/**
 * Picks the line of npm's output that says what failed. npm ends a failed run
 * with `npm error A complete log of this run can be found in: ...`, which says
 * nothing about the cause, so a message that quotes the last line quotes that.
 *
 * Order: the `npm error code E...` line with the line after it; otherwise the
 * last `npm error` (or `npm ERR!`) line that is not the log-file pointer;
 * otherwise the last line of the output.
 */
export function npmCause(output: string | readonly string[], fallback = "npm printed nothing"): string {
  const raw = typeof output === "string" ? [output] : output;
  const lines = raw.flatMap((l) => l.split("\n")).map((l) => l.trim()).filter((l) => l !== "");
  const bodies: string[] = [];
  for (const l of lines) {
    const m = /^npm (?:error|ERR!)\s*(.*)$/.exec(l);
    if (!m) continue;
    const body = (m[1] ?? "").trim();
    if (body === "" || /^A complete log of this run/i.test(body)) continue;
    bodies.push(body);
  }
  const codeAt = bodies.map((b) => /^code E\w+/.test(b)).lastIndexOf(true);
  if (codeAt >= 0) {
    const next = bodies[codeAt + 1];
    return next ? `${bodies[codeAt]}: ${next}` : (bodies[codeAt] as string);
  }
  if (bodies.length > 0) return bodies[bodies.length - 1] as string;
  return lines.at(-1) ?? fallback;
}
