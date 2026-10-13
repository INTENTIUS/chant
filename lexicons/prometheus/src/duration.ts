/**
 * Prometheus durations, as `model.ParseDuration` reads them.
 *
 * A duration is one or more `<number><unit>` terms, units in descending
 * order and each at most once: `y`, `w`, `d`, `h`, `m`, `s`, `ms`. `1h30m`
 * is valid, `30m1h` and `1.5h` are not. `0` on its own is valid. Prometheus
 * (rule `for`, `interval`, range selectors) and Alertmanager (`group_wait`,
 * `resolve_timeout`) share this grammar.
 */

const DURATION = /^(?:(\d+)y)?(?:(\d+)w)?(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?(?:(\d+)ms)?$/;

const UNIT_MS = [365 * 86_400_000, 7 * 86_400_000, 86_400_000, 3_600_000, 60_000, 1_000, 1];

/** True when `value` is a Prometheus duration string. */
export function isValidDuration(value: unknown): value is string {
  if (typeof value !== "string" || value === "") return false;
  if (value === "0") return true;
  return DURATION.test(value);
}

/** A duration in milliseconds, or `undefined` when it isn't a valid duration. */
export function durationMs(value: string): number | undefined {
  if (value === "0") return 0;
  if (value === "") return undefined;
  const m = DURATION.exec(value);
  if (!m) return undefined;
  let total = 0;
  for (let i = 0; i < UNIT_MS.length; i++) {
    const n = m[i + 1];
    if (n !== undefined) total += Number(n) * UNIT_MS[i];
  }
  return total;
}

/** Write a millisecond count as the shortest Prometheus duration, e.g. `5400000` -> `1h30m`. */
export function formatDuration(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0) throw new Error(`prometheus: ${ms} is not a whole, non-negative number of milliseconds`);
  if (ms === 0) return "0s";
  const units = ["y", "w", "d", "h", "m", "s", "ms"];
  let rest = ms;
  let out = "";
  for (let i = 0; i < UNIT_MS.length; i++) {
    const n = Math.floor(rest / UNIT_MS[i]);
    if (n > 0) {
      out += `${n}${units[i]}`;
      rest -= n * UNIT_MS[i];
    }
  }
  return out;
}
