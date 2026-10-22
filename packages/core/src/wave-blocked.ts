/**
 * A failed member blocks only the members that depend on it (#4291).
 *
 * A run applied a wave at a time stops a member when something it reads did
 * not apply, and lets every other member go on. This module holds the rule
 * and the records it reads, with no runner in it, so a product that runs its
 * waves in its own CI stages (terragucci's roots, lifted from its
 * `blocked.ts`) and chant's own wave jobs (`pr-apply --wave-gate`,
 * `chant components fan-out --wave-gate`) block the same members for the
 * same reasons. It imports `node:fs` and `node:path` and nothing else, so it
 * bundles small (`wave-blocked-bundle.test.ts`).
 *
 * ## Outcomes
 *
 * Each member of an earlier wave has an outcome. `applied` and `unchanged`
 * let a dependent through. Every other status holds it:
 *
 * - `failed`: its plan or its apply failed.
 * - `waiting`: its wave waits for an approval.
 * - `refused`: its wave was refused, held or stood down.
 * - `decided`: its wave's deciding job decided it, and a share job applies it.
 * - `not-applied`: its wave applied nothing because another member of it failed to plan.
 * - `blocked`: something it reads did not apply. `by` names the member whose
 *   outcome held it, past any member blocked in between.
 *
 * ## Outcome files
 *
 * A wave job that hands the next job its outcomes as files writes one per
 * job, `outcome-wave-<k>[-group-<g>][-share-<i>].json`:
 *
 *   {
 *     "version": 1, "wave": 2, "at": "2026-10-18T10:00:09.000Z",
 *     "members": {
 *       "cluster-b": { "status": "applied" },
 *       "cluster-a": { "status": "failed" },
 *       "app-01": { "status": "blocked", "by": "cluster-a" }
 *     }
 *   }
 *
 * A wave job runs again on a re-run, so the newest outcome of a member wins.
 * A file written with `roots` in place of `members` (terragucci's, before
 * this module) reads the same. `holds_all` marks a wave that holds every
 * later member, such as a wave of state migrations that did not apply: each
 * later member is blocked by `wave-<k>`.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const WAVE_OUTCOME_VERSION = 1;

export type WaveMemberStatus = "applied" | "unchanged" | "failed" | "waiting" | "refused" | "decided" | "not-applied" | "blocked";

export interface WaveMemberOutcome {
  status: WaveMemberStatus;
  /** A blocked member's: the member whose outcome held it, past any member blocked in between. */
  by?: string;
}

export interface WaveOutcomeFile {
  version: typeof WAVE_OUTCOME_VERSION;
  wave: number;
  /** When the job wrote it: the newest outcome of a member wins. */
  at: string;
  members: Record<string, WaveMemberOutcome>;
  /** The wave holds every later member, each blocked by `wave-<k>`. */
  holds_all?: true;
}

const THROUGH: ReadonlySet<WaveMemberStatus> = new Set(["applied", "unchanged"]);

/** Whether `outcome` lets a dependent through: it applied, or had nothing to apply. */
export function passesThrough(outcome: WaveMemberOutcome | undefined): boolean {
  return outcome !== undefined && THROUGH.has(outcome.status);
}

/**
 * The members of `members` an upstream that did not apply holds, each with
 * the member whose outcome holds it. `upstreams` is each member's upstreams;
 * only those in `earlier` count (a member of this wave or a later one is no
 * upstream it waits for here). An upstream with no outcome did not apply as
 * far as this run knows, so it holds its dependents and names itself. A
 * blocked upstream passes on the member that blocked it. With `holdsAll`,
 * every member is blocked by `wave-<holdsAll>`.
 */
export function blockedMembers(
  members: readonly string[],
  upstreams: ReadonlyMap<string, Iterable<string>>,
  earlier: ReadonlySet<string>,
  outcomes: ReadonlyMap<string, WaveMemberOutcome>,
  holdsAll?: number,
): Map<string, string> {
  if (holdsAll !== undefined) return new Map(members.map((m) => [m, `wave-${holdsAll}`]));
  const out = new Map<string, string>();
  for (const member of members) {
    const by = [...(upstreams.get(member) ?? [])]
      .filter((u) => earlier.has(u))
      .sort()
      .map((u) => {
        const o = outcomes.get(u);
        if (passesThrough(o)) return undefined;
        return o?.status === "blocked" && o.by ? o.by : u;
      })
      .find((b): b is string => b !== undefined);
    if (by !== undefined) out.set(member, by);
  }
  return out;
}

/**
 * Walk waves 1 to `before - 1` and give each member that has no outcome the
 * one it ends with: `blocked` behind an upstream that did not apply. A member
 * with no outcome that nothing blocks has not run yet: it is in `unsettled`,
 * and wave `before` cannot run until it has. `outcomes` is what the records
 * say: `applied` for what applied, and `failed`, `waiting` or `not-applied`
 * for what did not. Returns those outcomes with the blocked members added.
 */
export function settleEarlierWaves(
  waves: readonly (readonly string[])[],
  before: number,
  upstreams: ReadonlyMap<string, Iterable<string>>,
  outcomes: ReadonlyMap<string, WaveMemberOutcome>,
): { outcomes: Map<string, WaveMemberOutcome>; unsettled: string[] } {
  const out = new Map(outcomes);
  const unsettled: string[] = [];
  const earlier = new Set<string>();
  for (let k = 1; k < before && k <= waves.length; k++) {
    const wave = waves[k - 1]!;
    const open = wave.filter((m) => !out.has(m));
    const blocked = blockedMembers(open, upstreams, earlier, out);
    for (const m of open) {
      const by = blocked.get(m);
      if (by !== undefined) out.set(m, { status: "blocked", by });
      else unsettled.push(m);
    }
    for (const m of wave) earlier.add(m);
  }
  return { outcomes: out, unsettled };
}

/**
 * Whether every member that did not apply waits for an approval, or is
 * blocked behind one that does: the run waits rather than failed, so the
 * job ends as waiting (exit 3), and the approval's re-run applies them.
 */
export function onlyWaiting(outcomes: ReadonlyMap<string, WaveMemberOutcome>): boolean {
  let held = false;
  for (const o of outcomes.values()) {
    if (THROUGH.has(o.status)) continue;
    held = true;
    if (o.status === "waiting") continue;
    if (o.status === "blocked" && o.by !== undefined && outcomes.get(o.by)?.status === "waiting") continue;
    return false;
  }
  return held;
}

const byName = ([a]: [string, unknown], [b]: [string, unknown]): number => (a < b ? -1 : a > b ? 1 : 0);

/** The blocked members grouped by what blocked them, as a log and a note list them: `app-01, app-02 (blocked by cluster-a)`. */
export function blockedWords(blocked: ReadonlyMap<string, string>): string {
  const byRoot = new Map<string, string[]>();
  for (const [member, by] of [...blocked].sort(byName)) byRoot.set(by, [...(byRoot.get(by) ?? []), member]);
  return [...byRoot].map(([by, ms]) => `${ms.join(", ")} (blocked by ${by})`).join("; ");
}

/**
 * How the run came out, from every member's newest outcome: "8 applied, 1
 * failed, 6 blocked", with waiting, refused and the rest named when there
 * are any, and undefined when every member applied or had nothing to apply.
 */
export function runSummary(outcomes: Iterable<WaveMemberOutcome>): string | undefined {
  const counts = new Map<WaveMemberStatus, number>();
  for (const o of outcomes) counts.set(o.status, (counts.get(o.status) ?? 0) + 1);
  if (![...counts.keys()].some((s) => !THROUGH.has(s))) return undefined;
  const parts = [`${counts.get("applied") ?? 0} applied`, `${counts.get("failed") ?? 0} failed`, `${counts.get("blocked") ?? 0} blocked`];
  for (const s of ["waiting", "refused", "decided", "not-applied"] as const) {
    if (counts.get(s)) parts.push(`${counts.get(s)} ${s === "decided" ? "not reported by their share" : s}`);
  }
  if (counts.get("unchanged")) parts.push(`${counts.get("unchanged")} unchanged`);
  return parts.join(", ");
}

/** The outcome file of a wave's job, or of one group or share of it. */
export function waveOutcomeFileName(wave: number, part: { group?: string; share?: number } = {}): string {
  const group = part.group !== undefined ? `-group-${part.group.replace(/[^A-Za-z0-9._-]/g, "_")}` : "";
  const share = part.share !== undefined ? `-share-${part.share}` : "";
  return `outcome-wave-${wave}${group}${share}.json`;
}

/** Write a wave job's outcome file in `dir`, members sorted by name. Returns its path. */
export function writeWaveOutcomeFile(
  dir: string,
  wave: number,
  part: { group?: string; share?: number },
  members: Record<string, WaveMemberOutcome>,
  at = new Date().toISOString(),
  holdsAll = false,
): string {
  const file = join(dir, waveOutcomeFileName(wave, part));
  const body: WaveOutcomeFile = {
    version: WAVE_OUTCOME_VERSION,
    wave,
    at,
    members: Object.fromEntries(Object.entries(members).sort(byName)),
    ...(holdsAll ? { holds_all: true as const } : {}),
  };
  writeFileSync(file, JSON.stringify(body, null, 2) + "\n");
  return file;
}

/** Every outcome file under `dirs`, four directories deep at most: downloaded artifacts keep each job's in a directory of its own. */
function outcomeFiles(dirs: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const abs = join(dir, name);
      let isDir = false;
      try {
        isDir = statSync(abs).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        if (depth < 4) walk(abs, depth + 1);
      } else if (/^outcome-wave-\d+.*\.json$/.test(name)) out.push(abs);
    }
  };
  for (const d of dirs) if (existsSync(d)) walk(d, 0);
  return out.sort();
}

/**
 * The outcome of each member of the waves before `wave`, as their jobs wrote
 * them under `dirs`, and the earliest such wave that holds every later
 * member, if any. For a member more than one job wrote (a re-run, or a split
 * wave's deciding job and the share that applied it), the newest. A file
 * that does not parse, or is of another version, is skipped.
 */
export function earlierWaveOutcomes(
  dirs: readonly string[],
  wave: number,
): { members: Map<string, WaveMemberOutcome & { wave: number; at: string }>; holdsAll?: number } {
  const out = new Map<string, WaveMemberOutcome & { wave: number; at: string }>();
  const newest = new Map<number, { at: string; holdsAll: boolean }>();
  for (const file of outcomeFiles(dirs)) {
    let f: Partial<WaveOutcomeFile> & { roots?: unknown };
    try {
      f = JSON.parse(readFileSync(file, "utf-8"));
    } catch {
      continue;
    }
    const members = (f?.members ?? f?.roots) as Record<string, WaveMemberOutcome> | undefined;
    if (f?.version !== WAVE_OUTCOME_VERSION || !Number.isInteger(f.wave) || f.wave! >= wave || typeof f.at !== "string") continue;
    if (typeof members !== "object" || members === null) continue;
    for (const [member, o] of Object.entries(members)) {
      const had = out.get(member);
      if (had && had.at > f.at) continue;
      out.set(member, { ...o, wave: f.wave!, at: f.at });
    }
    const n = newest.get(f.wave!);
    if (!n || n.at <= f.at) newest.set(f.wave!, { at: f.at, holdsAll: f.holds_all === true });
  }
  const holding = [...newest].filter(([, n]) => n.holdsAll).map(([k]) => k).sort((a, b) => a - b);
  return { members: out, ...(holding.length ? { holdsAll: holding[0] } : {}) };
}
