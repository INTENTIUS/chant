/**
 * Declared rule groups as resources a `ConvergeOp` observes (#3369).
 *
 * `rulesLoadedObserve` reads `GET /api/v1/rules` and returns one resource
 * per declared group:
 *
 * - `drifted` when Prometheus has not loaded the group (the rule file is not
 *   mounted, did not parse, or the reload has not happened), or when a rule
 *   in it has `health: "err"`, with the rule's `lastError` as the detail;
 * - `in-sync` otherwise;
 * - `unknown`, for every group, when the API cannot be read.
 *
 * The declared groups are `groups`, plus the groups of each rule file in
 * `rules` (read on each tick, so a rebuilt file is what is observed).
 * Prometheus is `url`, else `$PROMETHEUS_URL`, else `http://localhost:9090`.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "js-yaml";

export interface RulesLoadedObserveArgs {
  /** Prometheus's base URL. */
  url?: string;
  /** Group names that must be loaded. */
  groups?: string[];
  /** Rule files whose groups must be loaded, relative to the working directory. */
  rules?: string | string[];
  /** Request timeout, ms. Default 10000. */
  timeoutMs?: number;
  /** Replaces fetch. For tests. */
  _fetch?: typeof fetch;
}

export interface RulesLoadedObserveResult {
  resources: { name: string; status: "in-sync" | "drifted" | "unknown"; detail: string }[];
}

/** One group as `/api/v1/rules` returns it. */
export interface ApiRuleGroup {
  name: string;
  file?: string;
  rules: Array<{ name: string; type?: string; query?: string; health?: string; lastError?: string; state?: string }>;
}

export function prometheusUrl(url?: string): string {
  return (url ?? process.env.PROMETHEUS_URL ?? "http://localhost:9090").replace(/\/+$/, "");
}

/** The group names in a rule file's text. */
export function ruleFileGroups(text: string): string[] {
  const doc = load(text) as { groups?: Array<{ name?: unknown }> } | null;
  return (doc?.groups ?? []).map((g) => g?.name).filter((n): n is string => typeof n === "string");
}

/** The declared groups, in order, without repeats. */
export function declaredGroups(args: Pick<RulesLoadedObserveArgs, "groups" | "rules">, cwd = process.cwd()): string[] {
  const out = [...(args.groups ?? [])];
  const files = args.rules === undefined ? [] : Array.isArray(args.rules) ? args.rules : [args.rules];
  for (const f of files) out.push(...ruleFileGroups(readFileSync(resolve(cwd, f), "utf8")));
  return [...new Set(out)];
}

/** `GET /api/v1/rules`'s groups. Throws on anything but a successful answer. */
export async function fetchRuleGroups(f: typeof fetch, url: string, timeoutMs = 10_000): Promise<ApiRuleGroup[]> {
  const res = await f(`${url}/api/v1/rules`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`GET ${url}/api/v1/rules: HTTP ${res.status}`);
  const body = (await res.json()) as { status?: string; data?: { groups?: ApiRuleGroup[] } };
  if (body.status !== "success" || !Array.isArray(body.data?.groups)) throw new Error(`GET ${url}/api/v1/rules: status ${body.status ?? "missing"}`);
  return body.data.groups;
}

/** The verdict for one declared group against the loaded groups. */
export function groupVerdict(name: string, loaded: ApiRuleGroup[]): RulesLoadedObserveResult["resources"][number] {
  const matches = loaded.filter((g) => g.name === name);
  if (matches.length === 0) return { name, status: "drifted", detail: "group not loaded" };
  const rules = matches.flatMap((g) => g.rules ?? []);
  const errored = rules.filter((r) => r.health === "err");
  if (errored.length > 0) {
    return { name, status: "drifted", detail: errored.map((r) => `${r.name}: ${r.lastError || "health err"}`).join("; ") };
  }
  return { name, status: "in-sync", detail: `${rules.length} rule(s) loaded` };
}

/** Observe the declared rule groups: one resource per group. */
export async function rulesLoadedObserve(args: RulesLoadedObserveArgs): Promise<RulesLoadedObserveResult> {
  const names = declaredGroups(args);
  if (names.length === 0) throw new Error("rulesLoadedObserve: no groups declared (give groups or rules)");
  const url = prometheusUrl(args.url);
  let loaded: ApiRuleGroup[];
  try {
    loaded = await fetchRuleGroups(args._fetch ?? fetch, url, args.timeoutMs);
  } catch (err) {
    const detail = `rules API unreadable: ${(err as Error).message}`;
    return { resources: names.map((name) => ({ name, status: "unknown" as const, detail })) };
  }
  return { resources: names.map((name) => groupVerdict(name, loaded)) };
}
