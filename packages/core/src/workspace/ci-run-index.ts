/**
 * The run index (#4098, epic #4101): where the chant runner says which jobs it
 * ran, at the `--report-url` root, for behold and the demo kiosk to find runs
 * without a forge or a workflow file.
 *
 * ```
 * <url>/runs/index.json
 * ```
 *
 * One document, `ci-run-index/v1` (`ci-run-index.schema.json`). Each settled
 * `chant ci run` job with `--report-url` set adds an entry to its front, so
 * the newest run is first, and the list is cut to the newest `limit` entries,
 * 200 by default. An entry's `key` is the folder the job's report went to
 * (`reportKey`, `<pr>/<commit>`), so a reader goes from the index to
 * `<url>/<key>/pr-<job>.json`.
 *
 * The update reads the index, changes it and writes it back through the same
 * `file://` and `s3://` paths the report upload uses (pr-report-url.ts). A
 * `file://` write goes through a temporary name and a rename. Two runners
 * updating one index at once can lose an entry, and that is out of scope:
 * `chant ci serve` is one host. Within one process the updates for one URL
 * take turns, so `ci serve --max-jobs 2` does not race itself.
 *
 * An index that can't be parsed is replaced with a warning. An index this
 * chant can't read for any other reason, or a newer contract, is left alone
 * with a warning. Nothing here fails a job.
 */

import type { RunOrigin } from "../lifecycle/release-ledger";
import type { CommandContext } from "../cli/registry";
import { formatError } from "../cli/format";
import { reportUrlOf } from "./ci-report-url";
import { parseReportUrl, reportGet, reportPut, type ReportGet, type ReportPut, type ReportTarget } from "../pr-report-url";
import { readerVersion } from "./declaration";

export const CI_RUN_INDEX_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/ci-run-index/v1/ci-run-index.schema.json";
export const CI_RUN_INDEX_CONTRACT = 1;
/** The first chant that writes the index. */
export const CI_RUN_INDEX_FLOOR = "0.124.31";
/** Where the index is kept, below the report URL. */
export const CI_RUN_INDEX_KEY = "runs/index.json";
/** How many entries the index keeps unless told otherwise. */
export const CI_RUN_INDEX_LIMIT = 200;

/** One job the runner ran. */
export interface CiRunIndexEntry {
  job: "plan" | "apply";
  /** The pull request, or null when the job found none. */
  pr: number | null;
  commit: string;
  status: "ok" | "fail";
  /** Why a failed job failed: the `failure.code` of its run record. */
  failure?: { code: string };
  member?: string;
  started: string;
  ended: string;
  runId: string;
  /** The folder the job's report is under, below the report URL: `<pr>/<commit>[/<member>]`. */
  key: string;
  runOrigin: RunOrigin;
  /**
   * The runner whose key signed the run's record, or null for an unsigned
   * run (#4156). Written by chant 0.124.32 and newer; an entry from an older
   * chant lacks it.
   */
  signer?: string | null;
  /**
   * The code `chant ci run` exited with for the job: 0, its command's own
   * code such as 3 for a moved plan or a waiting wave, else 1 (#4165).
   * Written by chant 0.124.32 and newer; an entry from an older chant lacks it.
   */
  exitCode?: number;
}

export interface CiRunIndex {
  $schema: typeof CI_RUN_INDEX_SCHEMA_ID;
  contract: typeof CI_RUN_INDEX_CONTRACT;
  chant: string;
  /** When the index was last written. */
  updated: string;
  /** Newest first. */
  runs: CiRunIndexEntry[];
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The index as `text` holds it, or why it can't be used: `corrupt` is replaced, `newer` is left alone. */
export function parseCiRunIndex(text: string): { index: CiRunIndex } | { corrupt: string } | { newer: number } {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    return { corrupt: `it is not JSON (${messageOf(err)})` };
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return { corrupt: "it is not an object" };
  const d = doc as { contract?: unknown; runs?: unknown };
  if (typeof d.contract === "number" && d.contract > CI_RUN_INDEX_CONTRACT) return { newer: d.contract };
  if (d.contract !== CI_RUN_INDEX_CONTRACT) return { corrupt: "it is not a ci-run-index document" };
  if (!Array.isArray(d.runs)) return { corrupt: "it has no runs list" };
  const runs = d.runs.filter((r): r is CiRunIndexEntry => r !== null && typeof r === "object" && typeof (r as { runId?: unknown }).runId === "string");
  return { index: { ...(doc as CiRunIndex), runs } };
}

/** `entry` at the front of `runs`, replacing an entry with its run id, cut to the newest `limit`. */
export function addRunEntry(runs: readonly CiRunIndexEntry[], entry: CiRunIndexEntry, limit: number): CiRunIndexEntry[] {
  return [entry, ...runs.filter((r) => r.runId !== entry.runId)].slice(0, limit);
}

/** The turn each index URL is waiting for, so updates in one process run one after another. */
const turns = new Map<string, Promise<void>>();

/**
 * Add `entry` to the index at `target`. Never throws: a problem is a warning
 * and the index stays as it was, or is replaced when it was unreadable JSON.
 */
export function updateCiRunIndex(input: {
  target: ReportTarget;
  entry: CiRunIndexEntry;
  limit?: number;
  warn: (message: string) => void;
  now?: () => Date;
  put?: ReportPut;
  get?: ReportGet;
}): Promise<void> {
  const where = `${input.target.url}/${CI_RUN_INDEX_KEY}`;
  const put = input.put ?? reportPut(input.target);
  const get = input.get ?? reportGet(input.target);
  const limit = Math.max(1, Math.floor(input.limit ?? CI_RUN_INDEX_LIMIT));
  const work = async (): Promise<void> => {
    let runs: CiRunIndexEntry[] = [];
    try {
      const text = await get(CI_RUN_INDEX_KEY);
      if (text !== null) {
        const parsed = parseCiRunIndex(text);
        if ("corrupt" in parsed) input.warn(`the run index at ${where} is replaced, since ${parsed.corrupt}`);
        else if ("newer" in parsed) return input.warn(`the run index at ${where} is contract ${parsed.newer}, which this chant does not write; it is left as it is`);
        else runs = parsed.index.runs;
      }
    } catch (err) {
      return input.warn(`could not read the run index at ${where}, so it is not updated: ${messageOf(err)}`);
    }
    const index: CiRunIndex = {
      $schema: CI_RUN_INDEX_SCHEMA_ID,
      contract: CI_RUN_INDEX_CONTRACT,
      chant: readerVersion(),
      updated: (input.now?.() ?? new Date()).toISOString(),
      runs: addRunEntry(runs, input.entry, limit),
    };
    try {
      await put(CI_RUN_INDEX_KEY, JSON.stringify(index, null, 2) + "\n", "application/json");
    } catch (err) {
      input.warn(`could not write the run index at ${where}: ${messageOf(err)}`);
    }
  };
  const previous = turns.get(where) ?? Promise.resolve();
  const next = previous.then(work, work);
  const settled = next.catch(() => undefined);
  turns.set(where, settled);
  void settled.then(() => {
    if (turns.get(where) === settled) turns.delete(where);
  });
  return next.catch((err) => input.warn(`could not update the run index at ${where}: ${messageOf(err)}`));
}

/** The index at `target`, or null when none is there. Throws a line a person can read when it can't be read. */
export async function readCiRunIndex(target: ReportTarget, get: ReportGet = reportGet(target)): Promise<CiRunIndex | null> {
  const where = `${target.url}/${CI_RUN_INDEX_KEY}`;
  const text = await get(CI_RUN_INDEX_KEY);
  if (text === null) return null;
  const parsed = parseCiRunIndex(text);
  if ("corrupt" in parsed) throw new Error(`the run index at ${where} is unusable: ${parsed.corrupt}`);
  if ("newer" in parsed) throw new Error(`the run index at ${where} is contract ${parsed.newer}; this chant reads contract ${CI_RUN_INDEX_CONTRACT}`);
  return parsed.index;
}

/** The text `chant ci runs` prints: one line per run, newest first. */
export function formatCiRunIndex(index: CiRunIndex): string {
  if (index.runs.length === 0) return "no runs in the index";
  return index.runs
    .map((r) => {
      const pr = r.pr === null ? "no PR" : `PR ${r.pr}`;
      const why = r.status === "fail" ? ` (${r.failure?.code ?? "failed"})` : "";
      return `${r.ended}  ${r.job.padEnd(5)}  ${r.status}${why}  ${pr}  ${r.commit.slice(0, 12)}  ${r.runId}  ${r.key}${r.signer ? `  signed by ${r.signer}` : ""}`;
    })
    .join("\n");
}

const RUNS_USAGE = "chant ci runs [--report-url <s3://<bucket>/<prefix> | file://<directory>>] [--json]";

/** `chant ci runs` (#4098): list the index at the report URL. */
export async function runCiRuns(ctx: CommandContext): Promise<number> {
  try {
    // #4160: without --report-url, the declaration's ci.reportUrl.
    const raw = await reportUrlOf(ctx.args.reportUrl, process.cwd());
    if (!raw) throw new Error("--report-url names where the index is kept, unless the workspace declares ci.reportUrl");
    const target = parseReportUrl(raw);
    if ("error" in target) throw new Error(target.error);
    const index = await readCiRunIndex(target);
    if (index === null) throw new Error(`there is no run index at ${target.url}/${CI_RUN_INDEX_KEY}`);
    console.log(ctx.args.json ? JSON.stringify(index, null, 2) : formatCiRunIndex(index));
    return 0;
  } catch (err) {
    console.error(formatError({ message: `chant ci runs: ${messageOf(err)}`, hint: RUNS_USAGE }));
    return 1;
  }
}
