/**
 * The duration-string parser the Op model uses everywhere a timeout is
 * authored ("5m", "30s", "1h30m", "100ms"). Its own leaf module so both
 * `./local-executor.ts` (activity start-to-close timeouts) and `./gate.ts`
 * (a gate's pending-fact expiry) can reach it without importing each other.
 * Re-exported from `./local-executor.ts`, which is where it lived and where
 * every existing caller still imports it from.
 */

/** Parse a duration string ("5m", "30s", "1h30m", "100ms") to milliseconds. Throws when nothing in `s` parses as a quantity+unit. */
export function parseDuration(s: string): number {
  const units: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  let total = 0;
  let matched = false;
  for (const m of s.matchAll(/(\d+)(ms|s|m|h|d)/g)) {
    total += Number(m[1]) * units[m[2]];
    matched = true;
  }
  if (!matched) throw new Error(`unparseable duration: "${s}"`);
  return total;
}
