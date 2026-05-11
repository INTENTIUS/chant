/**
 * Helpers for K8s `MicroTime` fields.
 *
 * The K8s API server validates fields like `coordination.k8s.io/v1.Lease.spec.renewTime`
 * (kind: MicroTime) with the exact format `2006-01-02T15:04:05.000000Z07:00`
 * — microsecond precision, always 6 fractional digits, UTC offset.
 *
 * The naive JS `Date.toISOString()` (millisecond precision, 3 fractional
 * digits) is accepted by the API server too — the schema is more permissive
 * than the documented format string — but `time.RFC3339Nano`-style strings
 * with nanosecond precision (9 fractional digits) are rejected as
 * `422 Unprocessable Entity` with:
 *
 *   parsing time "...754Z" as "2006-01-02T15:04:05.000000Z07:00":
 *     cannot parse "754Z" as "Z07:00"
 *
 * Pass a JS Date through `microTime()` to get a string the API server
 * always accepts. This is the canonical way to populate MicroTime fields
 * when authoring chant resources by hand.
 */

/**
 * Format a Date as a K8s MicroTime string (UTC, exactly 6 fractional digits).
 *
 * @example
 *   import { Lease } from "@intentius/chant-lexicon-k8s";
 *   import { microTime } from "@intentius/chant-lexicon-k8s/micro-time";
 *
 *   new Lease({
 *     metadata: { name: "my-lease", namespace: "default" },
 *     spec: {
 *       holderIdentity: "node-1",
 *       leaseDurationSeconds: 15,
 *       renewTime: microTime(new Date()),
 *     },
 *   });
 */
export function microTime(date: Date = new Date()): string {
  const iso = date.toISOString(); // "2026-05-11T21:25:36.495Z" (3 digits)
  // Replace the millisecond fragment with a 6-digit microsecond fragment.
  // toISOString() always produces ms precision; pad to 6 by appending 3 zeros.
  return iso.replace(/\.(\d{3})Z$/, ".$1000Z");
}

/**
 * Returns true if `value` is a string in the K8s MicroTime canonical format
 * (UTC, microsecond precision). Useful in lint/validation contexts.
 */
export function isMicroTimeFormatted(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value);
}
