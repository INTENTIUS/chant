/**
 * Alertmanager silences as Op steps (#3369): silence the alerts a change is
 * expected to set off, and expire the silence when the change is done or
 * has failed.
 *
 * `alertmanagerSilence` creates a silence through `POST /api/v2/silences`
 * and records its id in a file under the working directory
 * (`.chant/alertmanager-silences/<record>.json`). Step-output references are
 * not available in an Op's `onFailure` phases, so the record is how a final
 * phase and an `onFailure` phase alike find the silence:
 * `alertmanagerUnsilence({ record })` expires every silence the record
 * holds through `DELETE /api/v2/silence/{id}`, and drops them from it. An
 * already-expired or unknown silence counts as expired, so the step can
 * run in both places.
 *
 * The Alertmanager is `url`, else `$ALERTMANAGER_URL`, else
 * `http://localhost:9093`.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { currentOpRun } from "@intentius/chant/op";
import { durationMs } from "../../duration";
import { parseMatchers } from "../../matchers";

export interface AlertmanagerSilenceArgs {
  /** The Alertmanager's base URL. */
  url?: string;
  /**
   * The alerts to silence: matcher strings (`alertname="X"`,
   * `severity=~"page|ticket"`, or `{a="1", b="2"}`), or a label set matched
   * by equality.
   */
  matchers: string[] | Record<string, string>;
  /** How long the silence lasts, e.g. `30m`. Expiring it earlier is `alertmanagerUnsilence`'s job. */
  duration: string;
  comment?: string;
  /** Default `chant`, with the Op's name when run in one. */
  createdBy?: string;
  /** The record the id is kept in. Default `silence`. */
  record?: string;
  /** Where records live, relative to the working directory. Default `.chant/alertmanager-silences`. */
  recordDir?: string;
  /** Replaces fetch. For tests. */
  _fetch?: typeof fetch;
  /** Replaces the clock. For tests. */
  _now?: () => Date;
}

export interface AlertmanagerSilenceResult {
  silenceId: string;
  url: string;
  startsAt: string;
  endsAt: string;
  /** The record file the id was written to. */
  record: string;
}

export interface AlertmanagerUnsilenceArgs {
  url?: string;
  /** Expire this silence only, in place of the record's. */
  silenceId?: string;
  /** The record to expire. Default `silence`. */
  record?: string;
  recordDir?: string;
  _fetch?: typeof fetch;
}

export interface AlertmanagerUnsilenceResult {
  expired: string[];
  /** Silences that could not be expired, kept in the record for the next try. */
  failed: { silenceId: string; detail: string }[];
}

interface RecordedSilence {
  silenceId: string;
  url: string;
  endsAt: string;
  run?: string;
}

export function alertmanagerUrl(url?: string): string {
  return (url ?? process.env.ALERTMANAGER_URL ?? "http://localhost:9093").replace(/\/+$/, "");
}

/** The API matchers for `matchers`. */
export function apiMatchers(matchers: string[] | Record<string, string>): Array<{ name: string; value: string; isRegex: boolean; isEqual: boolean }> {
  if (!Array.isArray(matchers)) {
    return Object.entries(matchers).map(([name, value]) => ({ name, value, isRegex: false, isEqual: true }));
  }
  const out: Array<{ name: string; value: string; isRegex: boolean; isEqual: boolean }> = [];
  for (const entry of matchers) {
    const parsed = parseMatchers(entry);
    if (!parsed.ok) throw new Error(`matcher ${JSON.stringify(entry)}: ${parsed.error}`);
    for (const m of parsed.matchers) out.push({ name: m.name, value: m.value, isRegex: m.op.endsWith("~"), isEqual: !m.op.startsWith("!") });
  }
  if (out.length === 0) throw new Error("a silence needs at least one matcher");
  return out;
}

export function recordPath(record = "silence", recordDir = ".chant/alertmanager-silences", cwd = process.cwd()): string {
  if (!/^[A-Za-z0-9._-]+$/.test(record)) throw new Error(`record ${JSON.stringify(record)}: use letters, digits, dot, dash and underscore`);
  return join(resolve(cwd, recordDir), `${record}.json`);
}

function readRecord(path: string): RecordedSilence[] {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { silences?: RecordedSilence[] };
    return Array.isArray(parsed.silences) ? parsed.silences : [];
  } catch {
    return [];
  }
}

function writeRecord(path: string, silences: RecordedSilence[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ silences }, null, 2)}\n`);
}

/** Create a silence and record its id. */
export async function alertmanagerSilence(args: AlertmanagerSilenceArgs): Promise<AlertmanagerSilenceResult> {
  const f = args._fetch ?? fetch;
  const url = alertmanagerUrl(args.url);
  const ms = durationMs(args.duration);
  if (!ms || ms <= 0) throw new Error(`duration ${JSON.stringify(args.duration)} is not a Prometheus duration such as 30m`);
  const run = currentOpRun();
  const now = (args._now ?? (() => new Date()))();
  const startsAt = now.toISOString();
  const endsAt = new Date(now.getTime() + ms).toISOString();
  const body = {
    matchers: apiMatchers(args.matchers),
    startsAt,
    endsAt,
    createdBy: args.createdBy ?? (run ? `chant op ${run.op}` : "chant"),
    comment: args.comment ?? (run ? `chant run ${run.op} (${run.runId})` : "chant"),
  };
  const res = await f(`${url}/api/v2/silences`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${url}/api/v2/silences: HTTP ${res.status}: ${text.slice(0, 300)}`);
  const silenceId = (JSON.parse(text) as { silenceID?: string }).silenceID;
  if (!silenceId) throw new Error(`POST ${url}/api/v2/silences answered without a silenceID: ${text.slice(0, 300)}`);
  const path = recordPath(args.record, args.recordDir);
  writeRecord(path, [...readRecord(path), { silenceId, url, endsAt, ...(run ? { run: run.runId } : {}) }]);
  return { silenceId, url, startsAt, endsAt, record: path };
}

/** Expire the recorded silences (or `silenceId`), and drop the expired ones from the record. */
export async function alertmanagerUnsilence(args: AlertmanagerUnsilenceArgs = {}): Promise<AlertmanagerUnsilenceResult> {
  const f = args._fetch ?? fetch;
  const path = recordPath(args.record, args.recordDir);
  const recorded = readRecord(path);
  const targets: RecordedSilence[] = args.silenceId
    ? [recorded.find((s) => s.silenceId === args.silenceId) ?? { silenceId: args.silenceId, url: alertmanagerUrl(args.url), endsAt: "" }]
    : recorded;
  const expired: string[] = [];
  const failed: AlertmanagerUnsilenceResult["failed"] = [];
  for (const s of targets) {
    const base = args.url ? alertmanagerUrl(args.url) : s.url;
    try {
      const res = await f(`${base}/api/v2/silence/${encodeURIComponent(s.silenceId)}`, { method: "DELETE" });
      const text = await res.text().catch(() => "");
      // Alertmanager answers 404 for an unknown silence and 500 "already expired" for an expired one: both are done.
      if (res.ok || res.status === 404 || /expired/i.test(text)) expired.push(s.silenceId);
      else failed.push({ silenceId: s.silenceId, detail: `HTTP ${res.status}: ${text.slice(0, 200)}` });
    } catch (err) {
      failed.push({ silenceId: s.silenceId, detail: (err as Error).message });
    }
  }
  const done = new Set(expired);
  if (recorded.length > 0) writeRecord(path, recorded.filter((s) => !done.has(s.silenceId)));
  if (failed.length > 0) {
    throw new Error(`could not expire ${failed.length} silence(s): ${failed.map((x) => `${x.silenceId} (${x.detail})`).join("; ")}`);
  }
  return { expired, failed };
}
