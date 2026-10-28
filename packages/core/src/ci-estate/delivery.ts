/**
 * Delivery metrics (#4612): the four DORA metrics per member and for the
 * estate, from the workspace ledger and nothing else. Lifted from
 * terragucci's report/dora.ts, which reads the same facts from its reports
 * bucket (audit.jsonl and index rows). The output keeps that file's shape,
 * `dora.json`, with the product's name in `schema`
 * (`terragucci.dora/v1`, `plywood.dora/v1`), so a reader of terragucci's file
 * reads this one. A member is what the file calls a `project`.
 *
 * Where each number comes from:
 *
 *   applies        op wave jobs' run records (`runs.wave`, #4551): a wave
 *                  applied when its jobs applied targets and none failed,
 *                  failed when a target failed. Share and group jobs of one
 *                  wave join on the set digest and count once.
 *   first plan     the earliest job of the same spec and digest (the
 *                  deciding job, or the job that waited at the gate), or the
 *                  commit's time when the caller passes `commitTime`
 *   the gate       the pending fact for the digest (`gates`), and the
 *                  approval the apply spent (`applies`), else a resolution
 *                  of the same digest
 *   drift          drift checks' run records: `Drift=true` opens an
 *                  incident on the member (on the roots or stacks a
 *                  `DriftedRoots` outcome names, else on any of them), and
 *                  the next check with `Drift=false` closes it
 *
 * Deployment frequency   applied waves per week, over the span the history covers
 * Lead time              first plan to applied, split at the gate
 * Change failure rate    failed applies, plus applied waves whose targets
 *                        drifted within DRIFT_WINDOW_SECONDS, over all applies.
 *                        A refused wave is the gate working and counts for nothing.
 * Time to restore        a failed apply to the next apply of those targets;
 *                        drift found to the next check that found none
 *
 * Every number covers the newest DORA_WEEKS weeks, Monday to Sunday in UTC,
 * with a row per week. Nothing is compared to DORA's performance tiers.
 */
import { samePlanDigest } from "../lifecycle/plan-digest";
import { CHANT_WORDS, type CiProductWords } from "../ci-product-words";
import type { DriftRun, EstateRows, WaveJob } from "./rows";

/** How many weeks the metrics cover, the current one included. */
export const DORA_WEEKS = 8;

/** An applied wave whose targets drift within this long counts as a failed change. */
export const DRIFT_WINDOW_SECONDS = 7 * 86400;

/** The shortest span a deployment rate divides by, so one apply does not read as thousands a week. */
export const DORA_MIN_SPAN_SECONDS = 86400;

/** The file beside the estate page. */
export const DORA_FILE = "dora.json";

/** `<product>.dora/v1`: terragucci's schema name under terragucci's words. */
export const doraSchema = (words: Pick<CiProductWords, "product"> = CHANT_WORDS): string => `${words.product}.dora/v1`;

export interface DoraLeadTime {
  /** Applied waves whose first plan was found. */
  changes: number;
  /** Medians in seconds; null when no change counts. */
  median_seconds: number | null;
  /** From the first plan to the wave reaching its gate, or to the apply when no gate held it. */
  before_gate_seconds: number | null;
  /** From the gate asking for an approval to the approval. */
  at_gate_seconds: number | null;
  /** From the approval to the wave applied. */
  after_gate_seconds: number | null;
}

export interface DoraWeek {
  /** The Monday the week starts on, YYYY-MM-DD. */
  week: string;
  deployments: number;
  applies: number;
  /** Failed applies and applied waves followed by drift. */
  failures: number;
  lead_time_seconds: number | null;
  restore_seconds: number | null;
}

export interface DoraMetrics {
  /** Applied waves in the window, and per week over span_seconds. */
  deployments: number;
  per_week: number;
  /** What per_week divides by: now back to the oldest apply on record, or to the window's start when the history is older; at least DORA_MIN_SPAN_SECONDS. With no apply on record, the window. */
  span_seconds: number;
  lead_time: DoraLeadTime;
  change_failure: { applies: number; failed: number; drifted: number; rate: number | null };
  /** Incidents restored in the window and their median; open ones are still failing or drifted. */
  restore: { restored: number; open: number; median_seconds: number | null; apply_restored: number; drift_restored: number };
  /** Oldest week first. */
  trend: DoraWeek[];
}

export interface DoraProject extends DoraMetrics {
  /** The member. */
  project: string;
}

export interface Dora {
  /** {@link doraSchema}. */
  schema: string;
  generated: string;
  weeks: number;
  /** The first Monday the window holds, and when it ends. */
  window: { from: string; to: string };
  drift_window_seconds: number;
  /** Whether any apply record was on the ledger. Without one only drift counts. */
  audit: boolean;
  /** Where the numbers came from: always `ledger` here. terragucci's own file has no such field. */
  source: "ledger";
  estate: DoraMetrics;
  projects: DoraProject[];
}

export interface DeliveryOptions {
  words?: Pick<CiProductWords, "product">;
  now?: Date;
  /** The members to report, in order. Default every member the rows name. */
  members?: readonly string[];
  /** A commit's time in milliseconds, or null when unknown. Given, a change starts no later than its commit. */
  commitTime?: (commit: string) => number | null;
}

const at = (iso: string | undefined): number => (iso ? Date.parse(iso) || 0 : 0);
const secs = (from: number, to: number): number => Math.max(0, Math.round((to - from) / 1000));
const WEEK_MS = 7 * 86400 * 1000;
const WEEK_SECONDS = 7 * 86400;

/** The Monday, 00:00 UTC, of the week `t` falls in. */
export function weekStart(t: number): number {
  const d = new Date(t);
  const day = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}

/** One wave's apply, its jobs joined. */
interface Apply {
  project: string;
  at: number;
  applied: boolean;
  spec: string;
  digest?: string;
  commit?: string;
  roots: string[];
  failed: string[];
}

interface Lead {
  project: string;
  at: number;
  total: number;
  before: number;
  gate: number;
  after: number;
}

interface Restore {
  project: string;
  at: number;
  seconds: number;
  kind: "apply" | "drift";
}

interface Failure {
  project: string;
  at: number;
}

/** The waves that applied or failed, their share and group jobs joined on the digest, oldest first. */
export function appliesOf(waves: readonly WaveJob[]): Apply[] {
  const by = new Map<string, WaveJob[]>();
  for (const w of waves) {
    if (w.job === "decide" || (w.applied.length === 0 && w.failed.length === 0)) continue;
    const k = [w.member, w.spec, w.wave, w.digest ?? `run:${w.id}`].join("\n");
    by.set(k, [...(by.get(k) ?? []), w]);
  }
  const out: Apply[] = [];
  for (const jobs of by.values()) {
    const first = jobs[0]!;
    const failed = [...new Set(jobs.flatMap((j) => j.failed))];
    const roots = [...new Set(jobs.flatMap((j) => [...j.applied, ...j.failed]))];
    const commit = jobs.find((j) => j.commit)?.commit;
    out.push({ project: first.member, at: Math.max(...jobs.map((j) => at(j.ended))), applied: failed.length === 0, spec: first.spec, ...(first.digest ? { digest: first.digest } : {}), ...(commit ? { commit } : {}), roots, failed });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** The lead time of an applied wave, or undefined when nothing says when its change started. */
function leadOf(a: Apply, rows: EstateRows, commitTime: DeliveryOptions["commitTime"]): Lead | undefined {
  const same = (d: string | undefined): boolean => a.digest !== undefined && d !== undefined && samePlanDigest(d, a.digest);
  const starts: number[] = [];
  for (const w of rows.waves) if (w.member === a.project && w.spec === a.spec && same(w.digest) && at(w.started) <= a.at) starts.push(at(w.started));
  const committed = a.commit && commitTime ? commitTime(a.commit) : null;
  if (committed !== null && committed !== undefined && committed <= a.at) starts.push(committed);
  if (starts.length === 0) return undefined;
  const first = Math.min(...starts);
  const asked = rows.gates
    .filter((g) => g.kind === "pending" && g.member === a.project && g.op === a.spec && same(g.planDigest) && at(g.timestamp) <= a.at)
    .map((g) => at(g.timestamp))
    .sort((x, y) => x - y)[0];
  const spent = rows.approved.filter((p) => p.member === a.project && p.op === a.spec && same(p.planDigest) && at(p.approvedAt) <= a.at).map((p) => at(p.approvedAt));
  const resolved = rows.gates.filter((g) => g.kind === "resolution" && g.resolvedBy && g.member === a.project && g.op === a.spec && same(g.planDigest) && at(g.timestamp) <= a.at).map((g) => at(g.timestamp));
  const approvedAt = spent.length ? Math.max(...spent) : resolved.length ? Math.max(...resolved) : undefined;
  if (asked === undefined) return { project: a.project, at: a.at, total: secs(first, a.at), before: secs(first, a.at), gate: 0, after: 0 };
  const ok = approvedAt !== undefined ? Math.min(Math.max(approvedAt, asked), a.at) : undefined;
  const gateEnd = ok ?? asked;
  return { project: a.project, at: a.at, total: secs(first, a.at), before: secs(first, Math.max(first, asked)), gate: secs(asked, gateEnd), after: secs(gateEnd, a.at) };
}

/** Failed applies, each restored by the next apply that applied every target it failed on. */
function applyRestores(applies: Apply[]): { restored: Restore[]; open: number } {
  const restored: Restore[] = [];
  const open = new Map<string, { start: number; roots: Set<string> }>();
  for (const a of applies) {
    if (!a.applied) {
      const roots = (a.failed.length ? a.failed : a.roots).filter((r) => !open.has(r));
      if (roots.length === 0) continue;
      const incident = { start: a.at, roots: new Set(roots) };
      for (const r of roots) open.set(r, incident);
      continue;
    }
    for (const r of a.roots) {
      const incident = open.get(r);
      if (!incident) continue;
      open.delete(r);
      incident.roots.delete(r);
      if (incident.roots.size === 0) restored.push({ project: a.project, at: a.at, seconds: secs(incident.start, a.at), kind: "apply" });
    }
  }
  return { restored, open: new Set(open.values()).size };
}

/** Drift as one incident: when it was first found, on which targets (empty for any), and when a check first found none. */
export interface DriftIncident {
  since: number;
  roots: Set<string>;
  closed?: number;
}

/** A member's drift incidents from its checks, oldest first. A check that says nothing (it failed) neither opens nor closes one. */
export function driftIncidents(checks: readonly DriftRun[]): DriftIncident[] {
  const out: DriftIncident[] = [];
  let open: DriftIncident | undefined;
  for (const c of [...checks].sort((x, y) => at(x.ended) - at(y.ended))) {
    if (c.drifted === true) {
      if (!open) out.push((open = { since: at(c.ended), roots: new Set() }));
      for (const r of c.roots) open.roots.add(r);
    } else if (c.drifted === false && open) {
      open.closed = at(c.ended);
      open = undefined;
    }
  }
  return out;
}

/** Applied waves whose targets drifted within the window, before another apply of those targets. */
function driftedApplies(applies: Apply[], incidents: DriftIncident[]): Set<Apply> {
  const out = new Set<Apply>();
  for (const a of applies) {
    if (!a.applied) continue;
    const hit = incidents.some((i) => {
      const t = i.since;
      if (t < a.at || t - a.at > DRIFT_WINDOW_SECONDS * 1000) return false;
      const shared = i.roots.size ? a.roots.filter((x) => i.roots.has(x)) : a.roots;
      return shared.some((x) => !applies.some((b) => b !== a && b.applied && b.at > a.at && b.at <= t && b.roots.includes(x)));
    });
    if (hit) out.add(a);
  }
  return out;
}

interface Events {
  applies: Apply[];
  leads: Lead[];
  failures: Failure[];
  drifted: Set<Apply>;
  restores: Restore[];
  open: number;
}

function eventsOf(member: string, rows: EstateRows, applies: Apply[], commitTime: DeliveryOptions["commitTime"]): Events {
  const mine = applies.filter((a) => a.project === member);
  const incidents = driftIncidents(rows.drift.filter((d) => d.member === member));
  const leads = mine.filter((a) => a.applied).flatMap((a) => leadOf(a, rows, commitTime) ?? []);
  const drifted = driftedApplies(mine, incidents);
  const failures = mine.filter((a) => !a.applied || drifted.has(a)).map((a) => ({ project: a.project, at: a.at }));
  const ar = applyRestores(mine);
  const dr = incidents.filter((i) => i.closed !== undefined).map((i) => ({ project: member, at: i.closed!, seconds: secs(i.since, i.closed!), kind: "drift" as const }));
  return { applies: mine, leads, failures, drifted, restores: [...ar.restored, ...dr], open: ar.open + incidents.filter((i) => i.closed === undefined).length };
}

const merge = (all: Events[]): Events => ({
  applies: all.flatMap((e) => e.applies),
  leads: all.flatMap((e) => e.leads),
  failures: all.flatMap((e) => e.failures),
  drifted: new Set(all.flatMap((e) => [...e.drifted])),
  restores: all.flatMap((e) => e.restores),
  open: all.reduce((n, e) => n + e.open, 0),
});

function spanOf(all: Apply[], from: number, now: number): number {
  const start = all.length ? Math.max(from, Math.min(...all.map((a) => a.at))) : from;
  return Math.max(DORA_MIN_SPAN_SECONDS, secs(start, now));
}

/** "32 hours", "9 days", "7.4 weeks": a span as the page names it. */
export function spanLabel(seconds: number): string {
  const unit = (n: number, one: string): string => `${n} ${n === 1 ? one : `${one}s`}`;
  if (seconds < 72 * 3600) return unit(Math.max(1, Math.round(seconds / 3600)), "hour");
  if (seconds < 2 * WEEK_SECONDS) return unit(Math.round(seconds / 86400), "day");
  return unit(Math.round((seconds / WEEK_SECONDS) * 10) / 10, "week");
}

function metricsOf(ev: Events, from: number, now: number): DoraMetrics {
  const inside = <T extends { at: number }>(xs: T[]): T[] => xs.filter((x) => x.at >= from && x.at <= now);
  const applies = inside(ev.applies);
  const deployments = applies.filter((a) => a.applied).length;
  const failed = applies.filter((a) => !a.applied).length;
  const drift = applies.filter((a) => ev.drifted.has(a)).length;
  const leads = inside(ev.leads);
  const restores = inside(ev.restores);
  const span = spanOf(ev.applies, from, now);
  const trend: DoraWeek[] = [];
  for (let w = 0; w < DORA_WEEKS; w++) {
    const start = from + w * WEEK_MS;
    const end = start + WEEK_MS;
    const of = <T extends { at: number }>(xs: T[]): T[] => xs.filter((x) => x.at >= start && x.at < end);
    trend.push({
      week: new Date(start).toISOString().slice(0, 10),
      deployments: of(applies).filter((a) => a.applied).length,
      applies: of(applies).length,
      failures: of(inside(ev.failures)).length,
      lead_time_seconds: median(of(leads).map((l) => l.total)),
      restore_seconds: median(of(restores).map((r) => r.seconds)),
    });
  }
  return {
    deployments,
    per_week: Math.round(((deployments * WEEK_SECONDS) / span) * 100) / 100,
    span_seconds: span,
    lead_time: {
      changes: leads.length,
      median_seconds: median(leads.map((l) => l.total)),
      before_gate_seconds: median(leads.map((l) => l.before)),
      at_gate_seconds: median(leads.map((l) => l.gate)),
      after_gate_seconds: median(leads.map((l) => l.after)),
    },
    change_failure: { applies: applies.length, failed, drifted: drift, rate: applies.length ? Math.round(((failed + drift) / applies.length) * 1e6) / 1e6 : null },
    restore: {
      restored: restores.length,
      open: ev.open,
      median_seconds: median(restores.map((r) => r.seconds)),
      apply_restored: restores.filter((r) => r.kind === "apply").length,
      drift_restored: restores.filter((r) => r.kind === "drift").length,
    },
    trend,
  };
}

/** The metrics of every member and of the estate, from the ledger rows. */
export function buildDelivery(rows: EstateRows, options: DeliveryOptions = {}): Dora {
  const now = options.now ?? new Date();
  const end = now.getTime();
  const from = weekStart(end) - (DORA_WEEKS - 1) * WEEK_MS;
  const members = options.members ?? rows.members;
  const applies = appliesOf(rows.waves);
  const events = members.map((m) => eventsOf(m, rows, applies, options.commitTime));
  return {
    schema: doraSchema(options.words),
    generated: now.toISOString(),
    weeks: DORA_WEEKS,
    window: { from: new Date(from).toISOString(), to: now.toISOString() },
    drift_window_seconds: DRIFT_WINDOW_SECONDS,
    audit: applies.length > 0,
    source: "ledger",
    estate: metricsOf(merge(events), from, end),
    projects: members.map((m, i) => ({ project: m, ...metricsOf(events[i]!, from, end) })),
  };
}

/** "3d 4h", "2h 10m", "5m", "40s": how long, to two units. */
export function duration(seconds: number | null): string {
  if (seconds === null) return "none";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${seconds}s`;
}

/** One gauge the estate sends, per member and for the estate (project `*`). terragucci's DoraGauge. */
export interface DeliveryGauge {
  name: string;
  unit: string;
  description: string;
  value: number;
  attributes: Record<string, string>;
}

/** `<product>_dora_<name>`: terragucci's metric names under terragucci's words, which its dashboards query. */
export function doraMetricNames(words: Pick<CiProductWords, "product"> = CHANT_WORDS): { deployments: string; leadTime: string; failureRate: string; restore: string } {
  const p = words.product.replace(/[^a-z0-9_]/g, "_");
  return { deployments: `${p}_dora_deployments_per_week`, leadTime: `${p}_dora_lead_time_seconds`, failureRate: `${p}_dora_change_failure_ratio`, restore: `${p}_dora_restore_seconds` };
}

/** The gauges for `dora`, as terragucci's `doraGauges` builds them. */
export function deliveryGauges(dora: Dora, words: Pick<CiProductWords, "product"> = CHANT_WORDS): DeliveryGauge[] {
  const names = doraMetricNames(words);
  const out: DeliveryGauge[] = [];
  const of = (project: string, m: DoraMetrics): void => {
    const a = { project };
    out.push({ name: names.deployments, unit: "", description: `Applied waves per week over the newest ${spanLabel(m.span_seconds)}, the span the history covers in the ${dora.weeks}-week window.`, value: m.per_week, attributes: a });
    const l = m.lead_time;
    for (const [segment, v] of [["total", l.median_seconds], ["before_gate", l.before_gate_seconds], ["at_gate", l.at_gate_seconds], ["after_gate", l.after_gate_seconds]] as const) {
      if (v !== null) out.push({ name: names.leadTime, unit: "s", description: "Median lead time from a change's first plan to its wave applied, and its split.", value: v, attributes: { ...a, segment } });
    }
    if (m.change_failure.rate !== null) out.push({ name: names.failureRate, unit: "", description: "Failed applies and applied waves followed by drift, over all applies.", value: m.change_failure.rate, attributes: a });
    if (m.restore.median_seconds !== null) out.push({ name: names.restore, unit: "s", description: "Median time from a failed apply or drift found to restored.", value: m.restore.median_seconds, attributes: a });
  };
  of("*", dora.estate);
  for (const p of dora.projects) of(p.project, p);
  return out;
}
