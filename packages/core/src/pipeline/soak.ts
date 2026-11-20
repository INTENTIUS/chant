/**
 * Soak (#5326): checks that must keep passing for a while after a stage or
 * a wave applied, before the next stage's gate or the next wave opens.
 *
 * No process waits. A promote into the next stage, or the next wave's job,
 * reads the soak when it runs: when the clock started (the last apply the
 * ledger recorded), how long the soak is, and what each check says now. A
 * soak that is not over records its pending fact and exits 3 with the time
 * left; a later run, by hand or from the pipeline's scheduled re-run, reads
 * the clock and the checks again.
 *
 * The decision here is pure: {@link decideSoak} takes the soak, the members
 * that applied and when, the time, a person's early end, the state the last
 * run left, and a reader for the checks. `./soak-checks.ts` holds the
 * readers chant ships, and `./soak-gate.ts` the part a promote and a wave
 * job run, which reads and writes the gate ledger.
 *
 * A soak only holds. It adds a wait in front of a gate and never stands in
 * for an approval: once it passes, or a person ends it, the next stage's own
 * gate still decides.
 *
 * The rules, in the order they apply:
 *
 * 1. No soak: nothing is held.
 * 2. A person ended the soak through its gate: nothing is held, whatever
 *    else is true.
 * 3. An apply with no usable time: held, since no clock can be counted.
 * 4. Each `restart` check is read on every run. One that fails holds; once
 *    it passes again the clock starts over at that run.
 * 5. Before the clock is up, held for the time left. A `hold` check is not
 *    read yet: its failure would keep the elapsed time and hold all the same.
 * 6. Once the clock is up, each `hold` check is read. One that fails holds
 *    until it passes or a person ends the soak; the elapsed time is kept.
 * 7. Otherwise the soak passed.
 *
 * `unknown` never counts as passing: a check that cannot be read holds.
 */

import { createHash } from "node:crypto";

/** What a failing check does. */
export type SoakOnFail = "restart" | "hold";

/** The check kinds, in the order the per-member ones report. */
export const SOAK_CHECK_KINDS = ["drift", "apply", "policy", "http", "prometheus", "cloudwatch-alarm", "command", "health"] as const;
export type SoakCheckKind = (typeof SOAK_CHECK_KINDS)[number];

/** The kinds read once per member that applied, over that member's targets. The rest are read once per soak. */
export const SOAK_MEMBER_KINDS: readonly SoakCheckKind[] = ["drift", "apply", "policy"];

interface SoakCheckCommon {
  /** The check's name in the output, the ledger and the notice. Default: its kind and a short digest of its settings. */
  name?: string;
  /** What a failure does. Default `restart`. */
  onFail?: SoakOnFail;
}

/** An HTTP request whose status (and body, when given) must match. */
export interface SoakHttpCheck extends SoakCheckCommon {
  kind: "http";
  url: string;
  /** The statuses that pass. Default 200. */
  status?: number | number[];
  /** A regular expression the body must match. */
  body?: string;
  /** Seconds before the request counts as failed. Default 10. */
  timeoutSeconds?: number;
}

/** A Prometheus instant query whose every sample must stay within `min` and `max`. A query with no sample is unknown. */
export interface SoakPrometheusCheck extends SoakCheckCommon {
  kind: "prometheus";
  /** The server's base URL, such as `https://prometheus.example`. */
  url: string;
  query: string;
  /** The highest value that passes. */
  max?: number;
  /** The lowest value that passes. */
  min?: number;
  timeoutSeconds?: number;
}

/** A CloudWatch alarm that must be in state `OK`, read with the AWS CLI the job is logged in with. */
export interface SoakCloudwatchCheck extends SoakCheckCommon {
  kind: "cloudwatch-alarm";
  alarm: string;
  region?: string;
}

/** A command that must exit 0. */
export interface SoakCommandCheck extends SoakCheckCommon {
  kind: "command";
  command: string[];
  timeoutSeconds?: number;
}

/**
 * `chant lifecycle health` for the stage's environment. Every resource read
 * must be healthy: unhealthy, unknown, not read and not deployed all fail.
 * `covers` scopes the check to resources whose name or type a glob matches,
 * so a soak can pass on what it can observe; a scope that matches nothing
 * fails. Absent, every resource counts.
 */
export interface SoakHealthCheck extends SoakCheckCommon {
  kind: "health";
  covers?: string[];
}

/** No open drift issue of the member's environment names one of its targets (in a code span). */
export interface SoakDriftCheck extends SoakCheckCommon {
  kind: "drift";
}

/** The newest apply of each of the member's targets did not fail. One still running, or none on record, passes. */
export interface SoakApplyCheck extends SoakCheckCommon {
  kind: "apply";
}

/** No policy denial of one of the member's targets was recorded since the clock started. A target's newest denial is the one read. */
export interface SoakPolicyCheck extends SoakCheckCommon {
  kind: "policy";
}

export type SoakCheck = SoakHttpCheck | SoakPrometheusCheck | SoakCloudwatchCheck | SoakCommandCheck | SoakHealthCheck | SoakDriftCheck | SoakApplyCheck | SoakPolicyCheck;

/** Checks and a duration for the members a glob names, in place of the soak's own. */
export interface SoakOverride {
  /** Member names or globs: `*` stays within one `/` segment, `**` crosses them. */
  members: string[];
  duration?: string;
  checks?: SoakCheck[];
}

/** A stage's or a wave's soak. */
export interface Soak {
  /** How long the checks must pass after the last apply: `<n>m`, `<n>h`, `<n>d`, or `0`. */
  duration: string;
  checks?: SoakCheck[];
  /** The first override whose glob names a member decides that member's duration and checks; a field it leaves out is the soak's. */
  overrides?: SoakOverride[];
}

/** The rule one member soaks under, after overrides. */
export interface SoakRule {
  /** As written. */
  duration: string;
  durationMs: number;
  checks: SoakCheck[];
}

const DURATION = /^(0|\d+[mhd])$/;
const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/** A soak duration in milliseconds, or undefined when it is not `<n>m`, `<n>h`, `<n>d` or `0`. */
export function soakDurationMs(value: string): number | undefined {
  if (!DURATION.test(value)) return undefined;
  if (value === "0") return 0;
  return Number(value.slice(0, -1)) * UNIT_MS[value.slice(-1)]!;
}

/**
 * Whether `glob` names `name`: `*` matches within one `/` segment, `**`
 * across them (and `a/**\/b` also matches `a/b`), `?` one character other
 * than `/`. A glob with no wildcard matches only the same name.
 */
export function soakGlobMatch(glob: string, name: string): boolean {
  if (!/[*?]/.test(glob)) return glob === name;
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`).test(name);
}

/** The rule for a member known by `names` (its name, and any other spelling of it): the first override whose glob names one of them, else the soak's own. */
export function soakRuleFor(soak: Soak, names: readonly string[]): SoakRule {
  const hit = (soak.overrides ?? []).find((o) => o.members.some((g) => names.some((n) => soakGlobMatch(g, n))));
  const duration = hit?.duration ?? soak.duration;
  return { duration, durationMs: soakDurationMs(duration) ?? 0, checks: [...(hit?.checks ?? soak.checks ?? [])] };
}

/** What a failure of `check` does. */
export function soakOnFail(check: Pick<SoakCheck, "onFail">): SoakOnFail {
  return check.onFail ?? "restart";
}

/** The check's name: its own, else its kind and a short digest of its settings, so the same check keeps its name from run to run. */
export function soakCheckName(check: SoakCheck): string {
  if (check.name) return check.name;
  const { name: _n, onFail: _o, kind, ...settings } = check as SoakCheck & Record<string, unknown>;
  if (Object.keys(settings).length === 0) return kind;
  const text = JSON.stringify(settings, Object.keys(settings).sort());
  return `${kind}-${createHash("sha256").update(text).digest("hex").slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// Checking a declaration

const isMap = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const COMMON_KEYS = ["kind", "name", "onFail"];
const CHECK_KEYS: Record<SoakCheckKind, readonly string[]> = {
  http: ["url", "status", "body", "timeoutSeconds"],
  prometheus: ["url", "query", "max", "min", "timeoutSeconds"],
  "cloudwatch-alarm": ["alarm", "region"],
  command: ["command", "timeoutSeconds"],
  health: ["covers"],
  drift: [],
  apply: [],
  policy: [],
};

function checkProblems(check: unknown, at: string): string[] {
  if (!isMap(check) || typeof check.kind !== "string" || !(SOAK_CHECK_KINDS as readonly string[]).includes(check.kind)) {
    return [`${at} must be a check: { "kind": ${SOAK_CHECK_KINDS.join(", ")}, ... }`];
  }
  const kind = check.kind as SoakCheckKind;
  const keys = [...COMMON_KEYS, ...CHECK_KEYS[kind]];
  const out = Object.keys(check).filter((k) => !keys.includes(k)).map((k) => `${at} has an unknown key "${k}"; a ${kind} check takes ${keys.join(", ")}`);
  if (check.name !== undefined && (typeof check.name !== "string" || check.name.trim() === "")) out.push(`${at}.name must be text`);
  if (check.onFail !== undefined && check.onFail !== "restart" && check.onFail !== "hold") out.push(`${at}.onFail is restart or hold`);
  const text = (k: string) => typeof check[k] === "string" && (check[k] as string).trim() !== "";
  const seconds = check.timeoutSeconds;
  if (seconds !== undefined && !(typeof seconds === "number" && Number.isInteger(seconds) && seconds > 0)) out.push(`${at}.timeoutSeconds must be a whole number above 0`);
  switch (kind) {
    case "http": {
      if (!text("url") || !/^https?:\/\//.test(check.url as string)) out.push(`${at}.url must be an http or https URL`);
      const s = check.status;
      const okStatus = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n >= 100 && n <= 599;
      if (s !== undefined && !(okStatus(s) || (Array.isArray(s) && s.length > 0 && s.every(okStatus)))) out.push(`${at}.status must be an HTTP status or a list of them`);
      if (check.body !== undefined) {
        if (typeof check.body !== "string") out.push(`${at}.body must be a regular expression`);
        else {
          try {
            new RegExp(check.body);
          } catch {
            out.push(`${at}.body is not a regular expression`);
          }
        }
      }
      break;
    }
    case "prometheus":
      if (!text("url") || !/^https?:\/\//.test(check.url as string)) out.push(`${at}.url must be the server's http or https URL`);
      if (!text("query")) out.push(`${at}.query must be a PromQL query`);
      for (const k of ["max", "min"]) if (check[k] !== undefined && typeof check[k] !== "number") out.push(`${at}.${k} must be a number`);
      if (check.max === undefined && check.min === undefined) out.push(`${at} sets max, min, or both: the threshold the query's samples are held to`);
      break;
    case "cloudwatch-alarm":
      if (!text("alarm")) out.push(`${at}.alarm must name a CloudWatch alarm`);
      if (check.region !== undefined && !text("region")) out.push(`${at}.region must name a region`);
      break;
    case "command":
      if (!Array.isArray(check.command) || check.command.length === 0 || check.command.some((w) => typeof w !== "string" || w === "")) out.push(`${at}.command must be a list of words, such as ["./smoke.sh", "prod"]`);
      break;
    case "health":
      if (check.covers !== undefined && !(Array.isArray(check.covers) && check.covers.length > 0 && check.covers.every((g) => typeof g === "string" && g.trim() !== ""))) out.push(`${at}.covers must list resource names, types or globs`);
      break;
  }
  return out;
}

function checksProblems(checks: unknown, at: string): string[] {
  if (checks === undefined) return [];
  if (!Array.isArray(checks)) return [`${at} must be a list of checks`];
  const out = checks.flatMap((c, i) => checkProblems(c, `${at}[${i}]`));
  const names = new Map<string, number>();
  checks.forEach((c, i) => {
    if (out.length > 0 || !isMap(c)) return;
    const name = soakCheckName(c as unknown as SoakCheck);
    if (names.has(name)) out.push(`${at}[${i}] has the same name as ${at}[${names.get(name)}] ("${name}"); give one a name`);
    else names.set(name, i);
  });
  return out;
}

/** Everything wrong with a soak, one line each; empty when it reads. */
export function soakProblems(soak: unknown, where: string): string[] {
  if (soak === undefined) return [];
  if (!isMap(soak)) return [`${where}.soak must be { "duration", "checks"?, "overrides"? }`];
  const at = `${where}.soak`;
  const out = Object.keys(soak).filter((k) => !["duration", "checks", "overrides"].includes(k)).map((k) => `${at} has an unknown key "${k}"; it takes duration, checks, overrides`);
  if (typeof soak.duration !== "string" || soakDurationMs(soak.duration) === undefined) out.push(`${at}.duration must be a duration in minutes, hours or days, such as 24h, or 0`);
  out.push(...checksProblems(soak.checks, `${at}.checks`));
  if (soak.overrides !== undefined) {
    if (!Array.isArray(soak.overrides)) out.push(`${at}.overrides must be a list of { "members", "duration"?, "checks"? }`);
    else soak.overrides.forEach((o, i) => {
      const oat = `${at}.overrides[${i}]`;
      if (!isMap(o)) {
        out.push(`${oat} must be { "members", "duration"?, "checks"? }`);
        return;
      }
      out.push(...Object.keys(o).filter((k) => !["members", "duration", "checks"].includes(k)).map((k) => `${oat} has an unknown key "${k}"; it takes members, duration, checks`));
      if (!Array.isArray(o.members) || o.members.length === 0 || o.members.some((g) => typeof g !== "string" || g.trim() === "")) out.push(`${oat}.members must list member names or globs`);
      if (o.duration !== undefined && (typeof o.duration !== "string" || soakDurationMs(o.duration) === undefined)) out.push(`${oat}.duration must be a duration in minutes, hours or days, such as 24h, or 0`);
      out.push(...checksProblems(o.checks, `${oat}.checks`));
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reading the checks

/** What a check is asked about. */
export interface SoakCheckContext {
  /** The environment that soaks: the stage's name, or the wave's environment. */
  environment: string;
  /** On a per-member check: the member, and the targets of it that applied. */
  member?: string;
  targets: string[];
  /** When the clock started, ISO 8601. A policy denial counts from here. */
  since: string;
  now: Date;
}

/** What a check found. `unknown` holds, as `failed` does. */
export interface SoakCheckResult {
  status: "passed" | "failed" | "unknown";
  /** On a per-member check that failed: the targets it found. */
  targets?: string[];
  /** One line a person reads. */
  detail: string;
}

/** Reads one check. A reader never throws: an error is `unknown`. */
export type SoakCheckReader = (check: SoakCheck, context: SoakCheckContext) => Promise<SoakCheckResult>;

// ---------------------------------------------------------------------------
// The decision

/** One member that applied in the stage or wave that soaks. */
export interface SoakSubject {
  member: string;
  /** Other spellings an override glob may match, beside `member`. */
  names?: string[];
  /** The member's targets that applied. */
  targets: string[];
  /** When it applied, ISO 8601, from the ledger. Absent or not a time: the clock cannot be counted. */
  appliedAt?: string;
}

/** What the last run of this soak recorded (on its pending fact), so a run knows a check passing again. */
export interface SoakClockState {
  /** When a `restart` check last passed again after failing, ISO 8601: the clock starts over there. */
  restartedAt?: string;
  /** The checks that failed on the last run, by name. */
  failing?: string[];
}

/** Why a soak holds. */
export type SoakHold =
  | { reason: "time"; due: string; leftMs: number }
  | { reason: "clock-unknown"; members: string[] }
  | { reason: "check"; check: string; kind: SoakCheckKind; onFail: SoakOnFail; status: "failed" | "unknown"; member?: string; targets?: string[]; detail: string };

/** What {@link decideSoak} decided. */
export interface SoakDecision {
  outcome: "hold" | "release";
  /** On a release: no soak, a person ended it, or it soaked. */
  via?: "no-soak" | "ended" | "soaked";
  /** Each member's rule, in subject order; empty with no soak. */
  rules: { member: string; rule: SoakRule }[];
  /** When the clock started: the last apply, or a later restart. Null when nothing counted it. */
  clockStart: string | null;
  /** When the soak is up: the clock start and the longest duration. Null where `clockStart` is. */
  due: string | null;
  /** Why it holds, in the order reported; empty on a release. */
  holds: SoakHold[];
  /** On `ended`: who, and where. */
  endedBy?: { by: string; url?: string };
  /** The state to record for the next run. */
  state: SoakClockState;
}

export interface DecideSoakInput {
  /** The soak, or undefined when the stage or wave declares none. */
  soak: Soak | undefined;
  subjects: readonly SoakSubject[];
  environment: string;
  now: Date;
  /** A person ended the soak (through its gate). */
  ended?: { by: string; url?: string };
  /** What the last run recorded. */
  state?: SoakClockState;
  read: SoakCheckReader;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Decide a soak at `input.now`. See the module comment for the order. */
export async function decideSoak(input: DecideSoakInput): Promise<SoakDecision> {
  const { soak, subjects, now } = input;
  if (!soak) return { outcome: "release", via: "no-soak", rules: [], clockStart: null, due: null, holds: [], state: {} };
  const rules = subjects.map((s) => ({ member: s.member, rule: soakRuleFor(soak, [s.member, ...(s.names ?? [])]) }));
  if (input.ended) return { outcome: "release", via: "ended", rules, clockStart: null, due: null, holds: [], endedBy: { ...input.ended }, state: {} };

  const unknown = subjects.filter((s) => s.appliedAt === undefined || Number.isNaN(Date.parse(s.appliedAt)));
  if (unknown.length > 0 || subjects.length === 0) {
    return { outcome: "hold", rules, clockStart: null, due: null, holds: [{ reason: "clock-unknown", members: unknown.map((s) => s.member) }], state: { ...input.state } };
  }
  const applied = Math.max(...subjects.map((s) => Date.parse(s.appliedAt!)));
  const prior = input.state ?? {};
  const restarted = prior.restartedAt !== undefined && !Number.isNaN(Date.parse(prior.restartedAt)) ? Date.parse(prior.restartedAt) : undefined;
  let start = restarted !== undefined && restarted > applied ? restarted : applied;

  // What each subject reads, in order: its per-member checks in kind order, then the shared checks once each.
  type Item = { check: SoakCheck; name: string; subject?: SoakSubject; durationMs: number };
  const items: Item[] = [];
  const shared = new Map<string, Item>();
  for (const [i, s] of subjects.entries()) {
    const rule = rules[i]!.rule;
    const own = rule.checks.filter((c) => SOAK_MEMBER_KINDS.includes(c.kind)).sort((a, b) => SOAK_CHECK_KINDS.indexOf(a.kind) - SOAK_CHECK_KINDS.indexOf(b.kind));
    for (const c of own) items.push({ check: c, name: soakCheckName(c), subject: s, durationMs: rule.durationMs });
    for (const c of rule.checks.filter((c) => !SOAK_MEMBER_KINDS.includes(c.kind))) {
      const name = soakCheckName(c);
      const had = shared.get(name);
      if (had) had.durationMs = Math.max(had.durationMs, rule.durationMs);
      else shared.set(name, { check: c, name, durationMs: rule.durationMs });
    }
  }
  items.push(...shared.values());

  const read = async (item: Item): Promise<SoakCheckResult> => {
    try {
      return await input.read(item.check, {
        environment: input.environment,
        ...(item.subject ? { member: item.subject.member } : {}),
        targets: item.subject ? [...item.subject.targets] : subjects.flatMap((s) => s.targets),
        since: iso(start),
        now,
      });
    } catch (err) {
      return { status: "unknown", detail: `the check could not be read: ${err instanceof Error ? err.message : String(err)}` };
    }
  };
  const holdOf = (item: Item, r: SoakCheckResult): SoakHold => ({
    reason: "check",
    check: item.name,
    kind: item.check.kind,
    onFail: soakOnFail(item.check),
    status: r.status === "passed" ? "failed" : r.status,
    ...(item.subject ? { member: item.subject.member } : {}),
    ...(item.subject ? { targets: r.targets ?? [...item.subject.targets] } : {}),
    detail: r.detail,
  });

  // 4. Restart checks, on every run.
  const failing = new Set<string>();
  const restartHolds: SoakHold[] = [];
  let passedAgain = false;
  for (const item of items.filter((x) => soakOnFail(x.check) === "restart")) {
    const r = await read(item);
    const key = item.subject ? `${item.name}@${item.subject.member}` : item.name;
    if (r.status === "passed") {
      if ((prior.failing ?? []).includes(key)) passedAgain = true;
      continue;
    }
    failing.add(key);
    restartHolds.push(holdOf(item, r));
  }
  const state: SoakClockState = { ...(prior.restartedAt ? { restartedAt: prior.restartedAt } : {}) };
  if (restartHolds.length === 0 && passedAgain) {
    // Every restart check passes again: the clock starts over now.
    start = Math.max(start, now.getTime());
    state.restartedAt = iso(start);
  }
  const longest = Math.max(0, ...rules.map((r) => r.rule.durationMs));
  const due = start + longest;
  const times = { clockStart: iso(start), due: iso(due) };

  const holds: SoakHold[] = [];
  if (now.getTime() < due) holds.push({ reason: "time", due: iso(due), leftMs: due - now.getTime() });
  holds.push(...restartHolds);
  // 6. Hold checks, once the clock is up for their member.
  for (const item of items.filter((x) => soakOnFail(x.check) === "hold")) {
    if (now.getTime() < start + item.durationMs) continue;
    const r = await read(item);
    if (r.status === "passed") continue;
    failing.add(item.subject ? `${item.name}@${item.subject.member}` : item.name);
    holds.push(holdOf(item, r));
  }
  if (failing.size > 0) state.failing = [...failing].sort();
  return holds.length === 0
    ? { outcome: "release", via: "soaked", rules, ...times, holds: [], state }
    : { outcome: "hold", rules, ...times, holds, state };
}

// ---------------------------------------------------------------------------
// Words

/** A span of milliseconds as a person reads it: `2h 5m`, `3d 4h`, `40s`. */
export function soakSpan(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

/** One line per hold: what the next stage or wave waits for. */
export function soakHoldLines(decision: Pick<SoakDecision, "holds">): string[] {
  return decision.holds.map((h) => {
    if (h.reason === "time") return `${soakSpan(h.leftMs)} left, until ${h.due}`;
    if (h.reason === "clock-unknown") return `the ledger gives no apply time for ${h.members.length > 0 ? h.members.join(", ") : "anything that applied"}, so the soak's clock cannot be counted`;
    const where = h.member ? ` on ${h.member}${h.targets && h.targets.length > 0 ? ` (${h.targets.join(", ")})` : ""}` : "";
    const then = h.onFail === "restart" ? "the soak starts over once it passes" : "held until it passes, with the elapsed time kept";
    return `check ${h.check}${where} ${h.status === "unknown" ? "could not be read" : "failed"}: ${h.detail}; ${then}`;
  });
}

/** How a soak reads in the plan note and the docs: its duration and its checks. */
export function soakSummary(soak: Soak): string {
  const checks = (soak.checks ?? []).map((c) => `${soakCheckName(c)} (${soakOnFail(c)})`);
  const overrides = soak.overrides?.length ? `; ${soak.overrides.length} override${soak.overrides.length === 1 ? "" : "s"} by member` : "";
  return `${soak.duration === "0" ? "no wait" : soak.duration}${checks.length > 0 ? `, while ${checks.join(", ")} pass${checks.length === 1 ? "es" : ""}` : ""}${overrides}`;
}
