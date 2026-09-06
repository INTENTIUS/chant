/**
 * The one string an op run is posted as.
 *
 * `chant acp` (#2125) parses a prompt as a chant command line, so a hosted run
 * of an Op is the line a person would have typed. Two places build it — the
 * `opRuntime` provider when it posts a run (#2126) and the `Steward`
 * composite when it declares a schedule (#2127) — and a schedule whose prompt
 * differed from what the runtime posts would be a second, silently divergent
 * spelling of the same command. Hence one module, imported by both, with no
 * dependencies of its own so neither drags the other in.
 */

/** The prompt one run of `op` is posted as, and the string a turn is matched by. */
export function runPrompt(op: string): string {
  return `chant run ${op}`;
}
