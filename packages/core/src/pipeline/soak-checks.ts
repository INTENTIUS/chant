/**
 * The soak's check readers (#5326): what each check kind reads, from
 * sources a caller hands in, so a test touches no network, no forge and no
 * ledger.
 *
 * - `http`: the URL's status, and its body against a regular expression.
 * - `prometheus`: an instant query's samples against `min` and `max`.
 * - `cloudwatch-alarm`: the alarm's state, through `aws cloudwatch
 *   describe-alarms`; only `OK` passes.
 * - `command`: the command's exit code; only 0 passes.
 * - `health`: `chant lifecycle health <env> --json`; every resource in scope
 *   must be healthy, and unknown, unread and undeployed resources fail.
 * - `drift`: the environment's open drift issue (`./drift-issue.ts`'s, one
 *   per environment) names none of the member's targets in a code span.
 * - `apply`: the newest apply of each target did not fail.
 * - `policy`: no target's newest policy denial is at or after the clock start.
 *
 * A source a caller does not give reads `unknown`, which holds.
 */

import { spawnSync } from "node:child_process";
import type { OpRunRecord } from "../op/runtime";
import { soakGlobMatch, type SoakCheck, type SoakCheckContext, type SoakCheckReader, type SoakCheckResult } from "./soak";

/** An apply's outcome for one target. */
export type SoakApplyState = "success" | "failure" | "pending";

/** A policy denial of one target, as the ledger recorded it. */
export interface SoakDenial {
  target: string;
  /** When it was recorded, ISO 8601. */
  at: string;
  rules: string[];
}

/** What a command run gave. */
export interface SoakExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

/** Where the readers read from. Each one is optional; a check whose source is missing reads `unknown`. */
export interface SoakSources {
  fetch?: (url: string, init: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ status: number; text(): Promise<string> }>;
  exec?: (argv: readonly string[], options: { timeoutMs: number }) => SoakExecResult | Promise<SoakExecResult>;
  /** The body of the environment's open drift issue for `member`, null when none is open. */
  driftIssue?: (environment: string, member: string | undefined) => Promise<{ body: string; url?: string } | null>;
  /** The newest apply of each of `targets`; a target left out has none on record. */
  applies?: (environment: string, member: string | undefined, targets: readonly string[]) => Promise<Record<string, SoakApplyState>>;
  /** The policy denials of `targets`, in any order. */
  denials?: (environment: string, member: string | undefined, targets: readonly string[]) => Promise<SoakDenial[]>;
  /** The argv that prints `chant lifecycle health <env> --json`. Default `["chant", "lifecycle", "health", env, "--json"]`. */
  healthCommand?: (environment: string) => string[];
}

/** The targets a drift issue's body names: those written in a code span, whole. */
export function driftNamedTargets(body: string, targets: readonly string[]): string[] {
  return targets.filter((t) => body.includes(`\`${t}\``));
}

const unknown = (detail: string): SoakCheckResult => ({ status: "unknown", detail });

/** A {@link SoakCheckReader} over `sources`. */
export function soakCheckReader(sources: SoakSources): SoakCheckReader {
  return async (check, ctx) => {
    try {
      return await readCheck(sources, check, ctx);
    } catch (err) {
      return unknown(`the check could not be read: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

async function withTimeout<T>(seconds: number | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), (seconds ?? 10) * 1000);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function readCheck(sources: SoakSources, check: SoakCheck, ctx: SoakCheckContext): Promise<SoakCheckResult> {
  switch (check.kind) {
    case "http": {
      if (!sources.fetch) return unknown("no HTTP client was given");
      const res = await withTimeout(check.timeoutSeconds, (signal) => sources.fetch!(check.url, { signal }));
      const want = check.status === undefined ? [200] : Array.isArray(check.status) ? check.status : [check.status];
      if (!want.includes(res.status)) return { status: "failed", detail: `${check.url} answered ${res.status}, not ${want.join(" or ")}` };
      if (check.body !== undefined) {
        const text = await res.text();
        if (!new RegExp(check.body).test(text)) return { status: "failed", detail: `${check.url}'s body does not match /${check.body}/` };
      }
      return { status: "passed", detail: `${check.url} answered ${res.status}` };
    }
    case "prometheus": {
      if (!sources.fetch) return unknown("no HTTP client was given");
      const url = `${check.url.replace(/\/+$/, "")}/api/v1/query?query=${encodeURIComponent(check.query)}`;
      const res = await withTimeout(check.timeoutSeconds, (signal) => sources.fetch!(url, { signal, headers: { accept: "application/json" } }));
      if (res.status !== 200) return unknown(`Prometheus answered ${res.status}`);
      const doc = JSON.parse(await res.text()) as { status?: string; data?: { resultType?: string; result?: unknown } };
      if (doc.status !== "success") return unknown("Prometheus did not answer the query");
      const values = samplesOf(doc.data?.resultType, doc.data?.result);
      if (values.length === 0) return unknown(`the query ${check.query} returned no sample`);
      const bad = values.filter((v) => Number.isNaN(v) || (check.max !== undefined && v > check.max) || (check.min !== undefined && v < check.min));
      if (bad.length > 0) return { status: "failed", detail: `the query ${check.query} returned ${bad.join(", ")}, outside ${bounds(check.min, check.max)}` };
      return { status: "passed", detail: `the query ${check.query} stays within ${bounds(check.min, check.max)}` };
    }
    case "cloudwatch-alarm": {
      if (!sources.exec) return unknown("no command runner was given");
      const argv = ["aws", "cloudwatch", "describe-alarms", "--alarm-names", check.alarm, "--output", "json", ...(check.region ? ["--region", check.region] : [])];
      const r = await sources.exec(argv, { timeoutMs: 30_000 });
      if (r.status !== 0) return unknown(`aws cloudwatch describe-alarms failed: ${oneLine(r.error ?? r.stderr) || `exit ${r.status}`}`);
      const doc = JSON.parse(r.stdout) as { MetricAlarms?: { StateValue?: string }[]; CompositeAlarms?: { StateValue?: string }[] };
      const state = [...(doc.MetricAlarms ?? []), ...(doc.CompositeAlarms ?? [])][0]?.StateValue;
      if (state === undefined) return unknown(`no alarm named ${check.alarm} was found`);
      if (state === "OK") return { status: "passed", detail: `the alarm ${check.alarm} is OK` };
      return state === "ALARM" ? { status: "failed", detail: `the alarm ${check.alarm} is in ALARM` } : unknown(`the alarm ${check.alarm} is ${state}`);
    }
    case "command": {
      if (!sources.exec) return unknown("no command runner was given");
      const r = await sources.exec(check.command, { timeoutMs: (check.timeoutSeconds ?? 300) * 1000 });
      if (r.status === 0) return { status: "passed", detail: `${check.command.join(" ")} exited 0` };
      if (r.status === null) return unknown(`${check.command.join(" ")} did not finish: ${oneLine(r.error ?? r.stderr)}`);
      return { status: "failed", detail: `${check.command.join(" ")} exited ${r.status}${r.stderr.trim() ? `: ${oneLine(r.stderr)}` : ""}` };
    }
    case "health": {
      if (!sources.exec) return unknown("no command runner was given");
      const argv = sources.healthCommand?.(ctx.environment) ?? ["chant", "lifecycle", "health", ctx.environment, "--json"];
      const r = await sources.exec(argv, { timeoutMs: 600_000 });
      if (r.status !== 0) return unknown(`lifecycle health ${ctx.environment} failed: ${oneLine(r.stderr) || `exit ${r.status}`}`);
      return healthVerdict(JSON.parse(r.stdout), check.covers);
    }
    case "drift": {
      if (!sources.driftIssue) return unknown("no drift issue reader was given");
      const issue = await sources.driftIssue(ctx.environment, ctx.member);
      const named = issue ? driftNamedTargets(issue.body, ctx.targets) : [];
      if (named.length === 0) return { status: "passed", detail: issue ? "the open drift issue names none of the targets" : "no drift issue is open" };
      return { status: "failed", targets: named, detail: `the drift issue${issue!.url ? ` ${issue!.url}` : ""} is open and names ${named.join(", ")}` };
    }
    case "apply": {
      if (!sources.applies) return unknown("no apply reader was given");
      const states = await sources.applies(ctx.environment, ctx.member, ctx.targets);
      const failed = ctx.targets.filter((t) => states[t] === "failure");
      if (failed.length === 0) return { status: "passed", detail: "no newest apply failed" };
      return { status: "failed", targets: failed, detail: `the newest apply failed for ${failed.join(", ")}` };
    }
    case "policy": {
      if (!sources.denials) return unknown("no policy denial reader was given");
      const since = Date.parse(ctx.since);
      const newest = new Map<string, SoakDenial>();
      for (const d of await sources.denials(ctx.environment, ctx.member, ctx.targets)) {
        const had = newest.get(d.target);
        if (!had || Date.parse(d.at) > Date.parse(had.at)) newest.set(d.target, d);
      }
      const denied = ctx.targets.map((t) => newest.get(t)).filter((d): d is SoakDenial => d !== undefined && Date.parse(d.at) >= since);
      if (denied.length === 0) return { status: "passed", detail: "policy denied none of the targets since the clock started" };
      const rules = [...new Set(denied.flatMap((d) => d.rules))];
      return { status: "failed", targets: denied.map((d) => d.target), detail: `policy denied ${denied.map((d) => d.target).join(", ")} since the clock started${rules.length > 0 ? ` (${rules.join(", ")})` : ""}` };
    }
  }
}

function bounds(min: number | undefined, max: number | undefined): string {
  if (min !== undefined && max !== undefined) return `${min} to ${max}`;
  return min !== undefined ? `${min} or more` : `${max} or less`;
}

function samplesOf(type: string | undefined, result: unknown): number[] {
  if (type === "scalar" && Array.isArray(result)) return [Number(result[1])];
  if (type === "vector" && Array.isArray(result)) return result.map((s) => Number((s as { value?: unknown[] }).value?.[1]));
  return [];
}

function oneLine(text: string): string {
  return text.trim().split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 300) ?? "";
}

/**
 * The verdict of a `chant lifecycle health --json` document (`chant-health/v1`)
 * for a health check: every resource in scope healthy. `covers` scopes it to
 * resources whose name or type a glob matches. Nothing in scope fails: a
 * soak never passes on what nobody observed.
 */
export function healthVerdict(doc: unknown, covers?: readonly string[]): SoakCheckResult {
  type Read = { entities?: Record<string, { type?: string; state?: string; detail?: string }>; unobserved?: Record<string, { type?: string; reason?: string }>; absent?: string[] };
  const d = doc as { schema?: string; lexicons?: Record<string, Read>; stacks?: Record<string, Record<string, Read>> };
  if (d?.schema !== "chant-health/v1") return unknown("lifecycle health printed no chant-health/v1 document");
  const reads: Read[] = d.lexicons ? Object.values(d.lexicons) : Object.values(d.stacks ?? {}).flatMap((s) => Object.values(s));
  const inScope = (name: string, type: string | undefined) => !covers || covers.some((g) => soakGlobMatch(g, name) || (type !== undefined && soakGlobMatch(g, type)));
  let seen = 0;
  const bad: string[] = [];
  for (const r of reads) {
    for (const [name, e] of Object.entries(r.entities ?? {})) {
      if (!inScope(name, e.type)) continue;
      seen++;
      if (e.state !== "healthy") bad.push(`${name} is ${e.state ?? "unknown"}`);
    }
    for (const [name, h] of Object.entries(r.unobserved ?? {})) {
      if (!inScope(name, h.type)) continue;
      seen++;
      bad.push(`${name} was not read (${h.reason ?? "unknown reason"})`);
    }
    for (const name of r.absent ?? []) {
      if (!inScope(name, undefined)) continue;
      seen++;
      bad.push(`${name} is not deployed`);
    }
  }
  if (seen === 0) return unknown(covers ? `no resource matches ${covers.join(", ")}` : "no resource has a health read");
  if (bad.length === 0) return { status: "passed", detail: `${seen} resource${seen === 1 ? "" : "s"} healthy` };
  const shown = bad.slice(0, 5).join("; ") + (bad.length > 5 ? `; and ${bad.length - 5} more` : "");
  // Unhealthy or not deployed is a failure; a resource only unknown or unread is unknown. Both hold.
  return { status: bad.some((b) => b.endsWith(" is unhealthy") || b.endsWith(" is not deployed")) ? "failed" : "unknown", detail: shown };
}

/**
 * The apply and policy sources read from op wave run records (#4551, #4614):
 * a target's newest record that applied or failed it, and the denials its
 * planned runs' policy rows carry, at the record's end.
 */
export function runRecordSoakSources(records: readonly OpRunRecord[]): Pick<SoakSources, "applies" | "denials"> {
  const sorted = [...records].sort((a, b) => Date.parse(a.ended) - Date.parse(b.ended));
  return {
    async applies(_env, _member, targets) {
      const out: Record<string, SoakApplyState> = {};
      for (const r of sorted) {
        const w = r.wave;
        if (!w) continue;
        for (const t of targets) {
          if (w.failed.includes(t)) out[t] = "failure";
          else if (w.applied.includes(t)) out[t] = "success";
        }
      }
      return out;
    },
    async denials(_env, _member, targets) {
      const out: SoakDenial[] = [];
      for (const r of sorted) {
        for (const [t, plan] of Object.entries(r.wave?.plans ?? {})) {
          if (!targets.includes(t)) continue;
          const rows = (plan.policy ?? []).filter((p) => p.result === "denied");
          if (rows.length > 0) out.push({ target: t, at: r.ended, rules: [...new Set(rows.flatMap((p) => p.rules))].sort() });
        }
      }
      return out;
    },
  };
}

/** `exec` through `spawnSync`, for a job. */
export function spawnSoakExec(cwd: string = process.cwd()): NonNullable<SoakSources["exec"]> {
  return (argv, { timeoutMs }) => {
    const r = spawnSync(argv[0]!, argv.slice(1), { cwd, encoding: "utf-8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", ...(r.error ? { error: r.error.message } : {}) };
  };
}
