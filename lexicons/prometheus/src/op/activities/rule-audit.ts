/**
 * `ruleAudit`: what a live Prometheus says about its rules (#3369), the
 * activity behind `RuleAuditOp`.
 *
 * - groups with health errors: every rule `/api/v1/rules` reports with
 *   `health: "err"`, with its `lastError`.
 * - alerts pending or firing past a threshold, from `/api/v1/alerts`: a
 *   pending alert older than `pendingFor` is one whose `for` never
 *   completes (a flapping condition), and a firing one older than
 *   `firingFor` is one nobody is acting on.
 * - selectors no live target emits: each distinct vector selector in the
 *   loaded rules' expressions, queried as
 *   `count(last_over_time(<selector>[<lookback>]))`. An empty answer means
 *   the rule reads a series nothing writes (a renamed metric, a dropped
 *   label, a target that is gone). Selectors over series the rules record
 *   themselves, and over `ALERTS`, are left out. One query per selector, at
 *   most `selectorBudget` of them; the rest are counted as unchecked.
 *
 * `mode` is `report` (return the findings) or `issue` (keep one open issue
 * current with them).
 */

import { defaultRunner, stickyIssue, type CommandRunner } from "@intentius/chant-lexicon-otel/op/activities/github";
import { durationMs } from "../../duration";
import { selectors } from "../../promql-analysis";
import { fetchRuleGroups, prometheusUrl, type ApiRuleGroup } from "./rules-loaded";

export type RuleAuditMode = "report" | "issue";

export interface RuleAuditArgs {
  /** Prometheus's base URL. Default `$PROMETHEUS_URL`, else `http://localhost:9090`. */
  url?: string;
  /** A pending alert older than this is a finding. Default `1h`. */
  pendingFor?: string;
  /** A firing alert older than this is a finding. Default `24h`. */
  firingFor?: string;
  /** At most this many selector queries. Default 50. */
  selectorBudget?: number;
  /** How far back a selector's series may last have been written. Default `1h`. */
  lookback?: string;
  mode?: RuleAuditMode;
  /** The issue's title in `issue` mode. Default `prometheus: rule audit findings`. */
  issueTitle?: string;
  _fetch?: typeof fetch;
  _run?: CommandRunner;
  _now?: () => Date;
}

export type RuleAuditFindingKind = "rule-error" | "pending-too-long" | "firing-too-long" | "selector-no-series";

export interface RuleAuditFinding {
  kind: RuleAuditFindingKind;
  /** The group, the alert, or the selector. */
  subject: string;
  detail: string;
}

export interface RuleAuditResult {
  mode: RuleAuditMode;
  findings: RuleAuditFinding[];
  /** Selector queries made. */
  queried: number;
  /** Selectors left unchecked by the budget. */
  unchecked: number;
  summary: string;
  issueUrl?: string;
}

interface ApiAlert {
  labels: Record<string, string>;
  state: string;
  activeAt?: string;
}

async function getJson<T>(f: typeof fetch, url: string): Promise<T> {
  const res = await f(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  const body = (await res.json()) as { status?: string; data?: T };
  if (body.status !== "success" || body.data === undefined) throw new Error(`GET ${url}: status ${body.status ?? "missing"}`);
  return body.data;
}

/** The distinct selectors the rules read, without the ones over recorded series and ALERTS. */
export function auditedSelectors(groups: ApiRuleGroup[]): string[] {
  const recorded = new Set<string>(["ALERTS", "ALERTS_FOR_STATE"]);
  for (const g of groups) for (const r of g.rules ?? []) if (r.type === "recording") recorded.add(r.name);
  const out = new Set<string>();
  for (const g of groups) {
    for (const r of g.rules ?? []) {
      if (!r.query) continue;
      for (const s of selectors(r.query)) {
        if (s.name && recorded.has(s.name)) continue;
        out.add(s.text.replace(/\s+/g, ""));
      }
    }
  }
  return [...out].sort();
}

function alertName(a: ApiAlert): string {
  const { alertname, ...rest } = a.labels;
  const extra = Object.entries(rest)
    .sort(([x], [y]) => x.localeCompare(y))
    .map(([k, v]) => `${k}="${v}"`)
    .join(",");
  return `${alertname ?? "(unnamed)"}{${extra}}`;
}

export function renderRuleAuditSummary(findings: RuleAuditFinding[], queried: number, unchecked: number): string {
  let out = "## Prometheus rule audit\n\n";
  if (findings.length === 0) out += "No findings.\n";
  else {
    out += "| Finding | Subject | Detail |\n|---|---|---|\n";
    for (const f of findings) out += `| ${f.kind} | \`${f.subject.replace(/\|/g, "\\|")}\` | ${f.detail.replace(/\|/g, "\\|")} |\n`;
  }
  out += `\n${queried} selector(s) queried${unchecked > 0 ? `, ${unchecked} left unchecked by the budget` : ""}.\n`;
  return out;
}

/** Audit a live Prometheus's rules, alerts and selectors. */
export async function ruleAudit(args: RuleAuditArgs = {}): Promise<RuleAuditResult> {
  const f = args._fetch ?? fetch;
  const url = prometheusUrl(args.url);
  const now = (args._now ?? (() => new Date()))().getTime();
  const mode = args.mode ?? "report";
  const findings: RuleAuditFinding[] = [];

  const groups = await fetchRuleGroups(f, url);
  for (const g of groups) {
    const errored = (g.rules ?? []).filter((r) => r.health === "err");
    for (const r of errored) findings.push({ kind: "rule-error", subject: g.name, detail: `${r.name}: ${r.lastError || "health err"}` });
  }

  const pendingMs = durationMs(args.pendingFor ?? "1h");
  const firingMs = durationMs(args.firingFor ?? "24h");
  if (pendingMs === undefined || firingMs === undefined) throw new Error("pendingFor and firingFor are Prometheus durations such as 1h");
  const { alerts } = await getJson<{ alerts: ApiAlert[] }>(f, `${url}/api/v1/alerts`);
  for (const a of alerts) {
    const since = a.activeAt ? Date.parse(a.activeAt) : NaN;
    if (Number.isNaN(since)) continue;
    const age = now - since;
    const hours = (age / 3_600_000).toFixed(1);
    if (a.state === "pending" && age > pendingMs) findings.push({ kind: "pending-too-long", subject: alertName(a), detail: `pending for ${hours}h` });
    if (a.state === "firing" && age > firingMs) findings.push({ kind: "firing-too-long", subject: alertName(a), detail: `firing for ${hours}h` });
  }

  const lookback = args.lookback ?? "1h";
  if (durationMs(lookback) === undefined) throw new Error(`lookback ${JSON.stringify(lookback)} is not a Prometheus duration`);
  const all = auditedSelectors(groups);
  const budget = Math.max(0, args.selectorBudget ?? 50);
  const checked = all.slice(0, budget);
  for (const sel of checked) {
    const query = `count(last_over_time(${sel}[${lookback}]))`;
    try {
      const data = await getJson<{ result: unknown[] }>(f, `${url}/api/v1/query?query=${encodeURIComponent(query)}`);
      if (data.result.length === 0) findings.push({ kind: "selector-no-series", subject: sel, detail: `no series in the last ${lookback}` });
    } catch {
      // A query Prometheus refuses is not evidence the series is missing.
    }
  }

  const summary = renderRuleAuditSummary(findings, checked.length, all.length - checked.length);
  const result: RuleAuditResult = { mode, findings, queried: checked.length, unchecked: all.length - checked.length, summary };
  if (mode === "issue" && findings.length > 0) {
    result.issueUrl = await stickyIssue(args._run ?? defaultRunner, process.cwd(), args.issueTitle ?? "prometheus: rule audit findings", summary);
  }
  return result;
}
