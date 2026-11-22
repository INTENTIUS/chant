/**
 * The restore drill's record (#5450): what one drill measured, and the
 * arithmetic that turns the measurements into a verdict. Pure, no I/O, so the
 * workspace status reader and the activity share it and it bundles for the
 * browser. The ledger that stores it is `./drill-ledger.ts`.
 *
 * Two numbers are measured, and each has one definition:
 *
 * - RPO achieved is the age of the backup the drill restored, taken at the
 *   instant the restore was requested: `restoreStarted - backup.at`. It is
 *   the data a loss at that moment would have cost, given the newest backup.
 * - RTO achieved is the time from the restore request until the restored
 *   store has passed every check: `checksEnded - restoreStarted`. A store that
 *   is "available" but fails its checks has not been recovered, so a drill
 *   whose checks fail has no RTO (`rtoMs` is null). Tearing the scratch
 *   environment down is not counted.
 */

import { parseDuration } from "../op/duration";

/** The store kinds a drill restores. */
export const DRILL_STORE_KINDS = ["rds", "aurora", "dynamodb", "s3", "velero"] as const;
export type DrillStoreKind = (typeof DRILL_STORE_KINDS)[number];

/** The targets a drill is held to, as authored: durations such as `"4h"` and `"15m"`. */
export interface DrillTargetsInput {
  rto?: string;
  rpo?: string;
}

/** The targets in milliseconds. A target left out is not checked. */
export interface DrillTargets {
  rtoMs?: number;
  rpoMs?: number;
}

/** One check's result. */
export interface DrillCheckResult {
  name: string;
  kind: "http" | "command";
  ok: boolean;
  /** How long the check took, retries included. */
  durationMs: number;
  /** What the check saw, or why it failed. */
  detail?: string;
}

/** How a drill ended. `passed`: checks ok and every declared target met. */
export type DrillOutcome = "passed" | "missed" | "failed";

/** How far over a target a drill ran, in milliseconds, for each target it missed. */
export interface DrillShortfall {
  rtoMs?: number;
  rpoMs?: number;
}

/** One drill, one line of `<env>/drills.jsonl` on `chant/lifecycle`. */
export interface DrillRecord {
  version: 1;
  /** A unique id for the drill. */
  id: string;
  /** The store's name, as the Op declares it. The key `workspace status` groups on. */
  store: string;
  kind: DrillStoreKind;
  /** The environment the drilled store lives in. */
  env: string;
  /** The Op that ran the drill, when one did. */
  op?: string;
  /** The scratch environment the backup was restored into. */
  scratch: string;
  /** ISO-8601 instants. */
  started: string;
  ended: string;
  /** The backup restored: its id and when it was taken. Null when none was found. */
  backup: { id: string; at: string } | null;
  /** The restore request to the last passing check, or null when the restore or a check failed. */
  rtoMs: number | null;
  /** The restore request alone, until the store was available. Null when the restore failed. */
  restoreMs: number | null;
  /** The backup's age when the restore was requested. Null when no backup was found. */
  rpoMs: number | null;
  targets: DrillTargets;
  /** Whether every declared target was met; null when none was declared or a measurement is missing. */
  met: boolean | null;
  shortfall: DrillShortfall;
  outcome: DrillOutcome;
  checks: DrillCheckResult[];
  /** Why the drill failed, for `outcome: "failed"`. */
  error?: string;
  /** Whether the scratch environment was torn down. False means something is left to remove. */
  tornDown: boolean;
  /** The failure to tear down, when it failed. */
  tearDownError?: string;
}

/** The targets of a drill in milliseconds. Throws on a duration it cannot read. */
export function parseDrillTargets(input: DrillTargetsInput | undefined): DrillTargets {
  const out: DrillTargets = {};
  if (input?.rto !== undefined) out.rtoMs = durationOf("rto", input.rto);
  if (input?.rpo !== undefined) out.rpoMs = durationOf("rpo", input.rpo);
  return out;
}

function durationOf(name: string, value: string): number {
  let ms: number;
  try {
    ms = parseDuration(value);
  } catch {
    throw new Error(`${name}: ${JSON.stringify(value)} is not a duration; write it like "4h", "15m" or "1h30m"`);
  }
  if (ms <= 0) throw new Error(`${name}: ${JSON.stringify(value)} must be longer than zero`);
  return ms;
}

/** A span as people read it: `1h12m`, `4m30s`, `800ms`. */
export function formatSpan(ms: number): string {
  const total = Math.round(ms);
  if (total < 1000) return `${total}ms`;
  const s = Math.floor(total / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return m > 0 ? `${h}h${m}m` : `${h}h`;
  if (m > 0) return sec > 0 ? `${m}m${sec}s` : `${m}m`;
  return `${sec}s`;
}

/**
 * Hold the measurements to the targets. A target is missed when the measured
 * span is longer than it; equal is met. A target with no measurement behind
 * it (the restore failed, so there is no RTO) leaves `met` null rather than
 * guessing, and the drill's outcome is `failed` for the failure itself.
 */
export function evaluateTargets(
  measured: { rtoMs: number | null; rpoMs: number | null },
  targets: DrillTargets,
): { met: boolean | null; shortfall: DrillShortfall } {
  const shortfall: DrillShortfall = {};
  let declared = 0;
  let unmeasured = false;
  for (const [key, target, value] of [
    ["rtoMs", targets.rtoMs, measured.rtoMs],
    ["rpoMs", targets.rpoMs, measured.rpoMs],
  ] as const) {
    if (target === undefined) continue;
    declared++;
    if (value === null) {
      unmeasured = true;
      continue;
    }
    if (value > target) shortfall[key] = value - target;
  }
  if (Object.keys(shortfall).length > 0) return { met: false, shortfall };
  if (declared === 0 || unmeasured) return { met: null, shortfall };
  return { met: true, shortfall };
}

/** The sentence a missed drill fails with: each target, what was measured, and by how much it was missed. */
export function describeTargets(store: string, measured: { rtoMs: number | null; rpoMs: number | null }, targets: DrillTargets): string {
  const parts: string[] = [];
  for (const [label, target, value] of [
    ["RTO", targets.rtoMs, measured.rtoMs],
    ["RPO", targets.rpoMs, measured.rpoMs],
  ] as const) {
    if (target === undefined) continue;
    if (value === null) parts.push(`${label} not measured against ${formatSpan(target)}`);
    else if (value > target) parts.push(`${label} ${formatSpan(value)} against ${formatSpan(target)}, over by ${formatSpan(value - target)}`);
    else parts.push(`${label} ${formatSpan(value)} against ${formatSpan(target)}, met`);
  }
  return `restore drill ${store}: ${parts.join("; ")}`;
}

/** The outcome of a drill from what it measured. */
export function drillOutcome(checksOk: boolean, failed: boolean, met: boolean | null): DrillOutcome {
  if (failed || !checksOk) return "failed";
  return met === false ? "missed" : "passed";
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Whether a parsed line has the fields status and the ledger reader depend on. */
export function isDrillRecord(v: unknown): v is DrillRecord {
  if (!isRecord(v) || v.version !== 1) return false;
  return (
    typeof v.id === "string" &&
    typeof v.store === "string" &&
    typeof v.kind === "string" &&
    typeof v.env === "string" &&
    typeof v.started === "string" &&
    typeof v.ended === "string" &&
    (v.outcome === "passed" || v.outcome === "missed" || v.outcome === "failed") &&
    Array.isArray(v.checks) &&
    isRecord(v.targets)
  );
}

/** The drills in a ledger file, oldest first. A line that is not a drill record is skipped and counted. */
export function parseDrillLedger(text: string): { records: DrillRecord[]; malformed: number } {
  const records: DrillRecord[] = [];
  let malformed = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isDrillRecord(parsed)) records.push(parsed);
      else malformed++;
    } catch {
      malformed++;
    }
  }
  return { records, malformed };
}

/** The newest drill of each store, by the time it ended, sorted by store name. */
export function latestDrillPerStore(records: readonly DrillRecord[]): DrillRecord[] {
  const newest = new Map<string, DrillRecord>();
  for (const r of records) {
    const held = newest.get(r.store);
    if (!held || Date.parse(r.ended) >= Date.parse(held.ended)) newest.set(r.store, r);
  }
  return [...newest.values()].sort((a, b) => a.store.localeCompare(b.store));
}
