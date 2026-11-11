/**
 * `rest` waves in a split pipeline (#4992): one wave per run, each run
 * starting the next.
 *
 * Maintainer decision (2026-11-10): a follow-on run. Before merge (and on a
 * push of the same pipeline) each wave is four jobs (./op-waves-split.ts),
 * and the jobs of a wave the plan finds at run time cannot be rendered up
 * front. So the rest wave's four jobs (the last rendered wave, N) run wave
 * N in a run, and their record job, once every wave of the run applied and
 * the plan found more waves, starts the waves workflow again for wave N+1:
 *
 * - GitHub and Forgejo dispatch the workflow on its branch with the inputs
 *   `wave` and, before merge, `pr`, `head` and `digest`, or, for a push,
 *   `commit` (the pushed commit, which every job of the follow-on checks
 *   out and checks is on the branch). GitHub dispatches with the job's
 *   token (`actions: write` on that job alone); Forgejo with the
 *   `CHANT_FORGE_TOKEN` secret, as its resume does.
 * - GitLab starts a pipeline of the branch with the same values as
 *   variables (`CHANT_WAVES_WAVE`, the decision's three or
 *   `CHANT_WAVES_COMMIT`), with `CHANT_FORGE_TOKEN`, since the job token
 *   cannot start one.
 *
 * In the follow-on the jobs of waves 1 to N-1 do not run, and the rest
 * wave's jobs run wave N+1 (`--wave "${CHANT_WAVES_WAVE:-N}"`, and their
 * files at that wave's paths, {@link opWaveRestPath}). The guard admits the
 * run as the same decided head (./follow-on-run.ts). It goes on until the
 * wave the plan found last.
 *
 * The record job leaves a note in the outcome directory
 * ({@link OP_WAVE_REST_NOTE}): the wave it ran, how many the plan found, and
 * the wave it started, if it started one. `before-merge-done`, the control
 * dispatch and the apply status read it, so a run that started a follow-on
 * is not the last: nothing merges, the control repo hears from the last
 * run, and the status stays pending with `wave k of M applied`.
 *
 * #4998: before it starts a follow-on, the record job records it on
 * `chant/lifecycle` (./follow-on-run.ts, ./follow-on-store.ts): the wave it
 * starts, its own run, the decision or the pushed commit, and the outcomes
 * of every run of the chain so far, its own added. The follow-on's guard
 * admits that wave alone. A follow-on's record job reads the record that
 * started it and puts the earlier runs' outcomes in its note as `chain`, so
 * the last run's control dispatch and apply status add up the whole chain
 * ({@link withChainOutcomes}): a chain whose last wave changed nothing
 * reports `applied` when an earlier run applied.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { CHANT_EXIT } from "../exit-codes";
import { CONTROL_OUTCOME_VAR } from "../control/dispatch";
import { beforeMergeRunFromEnv, isBeforeMergeRun } from "./before-merge";
import { OP_WAVES_COMMIT_ENV, OP_WAVES_WAVE_ENV, type FollowOnChainPort, type FollowOnOutcome, type FollowOnRecord } from "./follow-on-run";
import type { WaveMemberOutcome } from "../wave-blocked";
import { opWaveOutcomeDir, opWaveRecordPath, type OpWavesSpec } from "./op-waves";

export { FOLLOW_ON_INPUTS, OP_WAVES_COMMIT_ENV, OP_WAVES_WAVE_ENV } from "./follow-on-run";

/** The variable the rest wave's record job is told how to start a follow-on in: `{ "forge": ..., "workflow": ... }` as JSON. */
export const OP_WAVES_FOLLOW_ON_ENV = "CHANT_WAVES_FOLLOW_ON";

/**
 * The variable the rest wave's record step hands the token that starts the
 * follow-on in (GitHub: the job's token; Forgejo: the `CHANT_FORGE_TOKEN`
 * secret), so no other line of the job reads it as the forge's token.
 * Unset (GitLab), the record job reads {@link FORGE_TOKEN_VAR}.
 */
export const FOLLOW_ON_TOKEN_ENV = "CHANT_WAVES_FOLLOW_ON_TOKEN";

/** The secret (Forgejo) or CI/CD variable (GitLab) a token that may start a run is kept in. */
export const FORGE_TOKEN_VAR = "CHANT_FORGE_TOKEN";

/** How the rest wave's record job starts a follow-on. */
export interface OpWavesFollowOnTarget {
  forge: "github" | "forgejo" | "gitlab";
  /** GitHub and Forgejo: the waves workflow's file name, which the record job dispatches. */
  workflow?: string;
}

/** The rest wave's number when the spec's last wave has `rest`, else undefined. */
export function opWavesRestWave(spec: Pick<OpWavesSpec, "waves">): number | undefined {
  return spec.waves[spec.waves.length - 1]?.rest === true ? spec.waves.length : undefined;
}

/**
 * A path of the rest wave's (`wave-N.json`, `wave-N/`, `outcome-wave-N-apply.json`,
 * `run-record-wave-N.json`) with its wave number put as `token`, the form
 * the forge reads `CHANT_WAVES_WAVE` in at that place.
 */
export function opWaveRestPath(path: string, wave: number, token: string): string {
  return path.replace(new RegExp(`(^|[/-])wave-${wave}(?=[./-]|$)`, "g"), (_m, lead: string) => `${lead}wave-${token}`);
}

/** The value of {@link OP_WAVES_FOLLOW_ON_ENV} for a forge. */
export function opWavesFollowOnEnv(target: OpWavesFollowOnTarget): string {
  return JSON.stringify(target);
}

/** Read {@link OP_WAVES_FOLLOW_ON_ENV}; undefined when unset, and a value that is no target throws. */
export function parseFollowOnTarget(raw: string | undefined): OpWavesFollowOnTarget | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new Error(`${OP_WAVES_FOLLOW_ON_ENV} is not JSON`);
  }
  const o = v as Partial<OpWavesFollowOnTarget> | null;
  if (!o || (o.forge !== "github" && o.forge !== "forgejo" && o.forge !== "gitlab")) throw new Error(`${OP_WAVES_FOLLOW_ON_ENV}.forge is github, forgejo or gitlab`);
  if (o.forge !== "gitlab" && (typeof o.workflow !== "string" || !/^[A-Za-z0-9._-]+\.ya?ml$/.test(o.workflow))) throw new Error(`${OP_WAVES_FOLLOW_ON_ENV}.workflow names the waves workflow's file`);
  return { forge: o.forge, ...(o.workflow ? { workflow: o.workflow } : {}) };
}

/**
 * The lines every job of the rest wave runs after its checkout (#4992): in
 * a push's follow-on, stop (exit 9, `misplaced`) unless the commit it goes
 * on with is on the branch the run checked out, then check that commit
 * out. Nothing in any other run. The guard checked it is a commit sha.
 */
export function followOnCommitScript(product: string): string {
  return [
    `if [ -n "\${${OP_WAVES_COMMIT_ENV}:-}" ]; then`,
    `  git merge-base --is-ancestor "$${OP_WAVES_COMMIT_ENV}" HEAD || { echo "${product}: the follow-on's commit $(printf %.12s "$${OP_WAVES_COMMIT_ENV}") is not on the branch this run checked out, so nothing is applied" >&2; exit ${CHANT_EXIT.misplaced}; }`,
    `  git checkout -q --detach "$${OP_WAVES_COMMIT_ENV}" || exit 1`,
    "fi",
  ].join("\n");
}

/**
 * The first line of the control dispatch's script in a pipeline with a rest
 * wave (#4992): `chant run wave --waves-outcome` adds up nothing for a run
 * that started a follow-on, and the dispatch sends nothing then; the last
 * run of the waves sends the outcome.
 */
export function followOnControlSkip(product: string): string {
  return `if [ -z "\${${CONTROL_OUTCOME_VAR}:-}" ]; then echo "${product}: this run started a follow-on run for the next wave, which tells the control repo how the waves ended"; exit 0; fi`;
}

/** The note the rest wave's record job leaves in the outcome directory. */
export const OP_WAVE_REST_NOTE = "rest-wave.json";

/** What the note holds. */
export interface OpWaveRestNote {
  version: 1;
  op: string;
  /** The wave the run's rest wave jobs ran. */
  wave: number;
  /** How many waves the plan found. */
  found: number;
  /** The wave of the follow-on the record job started. Absent: this run is the last. */
  next?: number;
  /** A follow-on's: the outcomes of the chain's earlier runs, by member (#4998), from the record that started it. */
  chain?: Record<string, FollowOnOutcome>;
}

/** A member's outcome as the jobs after the waves add it up: `earlierWaveOutcomes`' entries. */
export type ChainedOutcome = WaveMemberOutcome & { wave: number; at: string };

/** The outcomes of a chain's runs: a valid entry of each, the rest dropped. */
function chainOf(v: unknown): Record<string, FollowOnOutcome> | undefined {
  if (!v || typeof v !== "object") return undefined;
  const out: Record<string, FollowOnOutcome> = {};
  for (const [member, o] of Object.entries(v as Record<string, Partial<FollowOnOutcome> | null>)) {
    if (!o || typeof o.status !== "string" || !Number.isInteger(o.wave) || typeof o.at !== "string" || (o.by !== undefined && typeof o.by !== "string")) continue;
    out[member] = { status: o.status, ...(o.by !== undefined ? { by: o.by } : {}), wave: o.wave!, at: o.at };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The outcomes the jobs after the waves add up (#4998): this run's, from
 * its outcome files (`members`, `earlierWaveOutcomes` below wave `before`),
 * with the chain's earlier runs' from the rest wave's note. A member's
 * newer outcome wins. With no note, or one with no chain, `members`.
 */
export function withChainOutcomes(members: ReadonlyMap<string, ChainedOutcome>, note: OpWaveRestNote | undefined, before: number = Number.MAX_SAFE_INTEGER): Map<string, ChainedOutcome> {
  const out = new Map<string, ChainedOutcome>();
  for (const [member, o] of Object.entries(note?.chain ?? {})) if (o.wave < before) out.set(member, o as ChainedOutcome);
  for (const [member, o] of members) {
    const had = out.get(member);
    if (!had || had.at <= o.at) out.set(member, o);
  }
  return out;
}

/** Where the record job writes the note. */
export function opWaveRestNotePath(spec: Pick<OpWavesSpec, "name">): string {
  return `${opWaveOutcomeDir(spec)}/${OP_WAVE_REST_NOTE}`;
}

/** The note under `dirs` (downloaded artifacts keep it in a directory of their own, four deep at most), the newest wave's when there are more. */
export function readOpWaveRestNote(dirs: readonly string[]): OpWaveRestNote | undefined {
  let found: OpWaveRestNote | undefined;
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
        continue;
      }
      if (name !== OP_WAVE_REST_NOTE) continue;
      let v: Partial<OpWaveRestNote> | null;
      try {
        v = JSON.parse(readFileSync(abs, "utf-8")) as Partial<OpWaveRestNote> | null;
      } catch {
        continue;
      }
      if (!v || v.version !== 1 || typeof v.op !== "string" || !Number.isInteger(v.wave) || !Number.isInteger(v.found)) continue;
      if (v.next !== undefined && (!Number.isInteger(v.next) || v.next !== v.wave! + 1)) continue;
      const chain = chainOf(v.chain);
      if (!found || v.wave! > found.wave) found = { version: 1, op: v.op, wave: v.wave!, found: v.found!, ...(v.next !== undefined ? { next: v.next } : {}), ...(chain ? { chain } : {}) };
    }
  };
  for (const d of dirs) if (existsSync(d)) walk(d, 0);
  return found;
}

/** A started run, as the forge links it. */
export interface StartedFollowOn {
  url?: string;
}

/** What {@link followOnAfterRecord} takes. */
export interface FollowOnAfterRecordInput {
  spec: OpWavesSpec;
  /** The wave the record job wrote. */
  wave: number;
  /** The record job's exit. */
  exitCode: number;
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Start the follow-on; default the forge's API ({@link startFollowOn}). */
  start?: (target: OpWavesFollowOnTarget, wave: number, env: Record<string, string | undefined>) => Promise<StartedFollowOn>;
  /** Where the chain's record is read and written (#4998); default `chant/lifecycle` through the checkout's git. */
  chain?: FollowOnChainPort;
  now?: () => Date;
  log?: (line: string) => void;
}

/** What a chain is keyed by and what its record names (#4998): before merge the decision, for a push the commit the run applied. */
export function followOnChainOf(forge: OpWavesFollowOnTarget["forge"], env: Record<string, string | undefined>): Pick<FollowOnRecord, "key" | "pr" | "digest" | "commit"> | undefined {
  const run = beforeMergeRunFromEnv(env);
  if (isBeforeMergeRun(run)) return run.head ? { key: run.head, ...(run.pr && /^[1-9][0-9]*$/.test(run.pr) ? { pr: Number(run.pr) } : {}), ...(run.digest ? { digest: run.digest } : {}) } : undefined;
  const commit = env[OP_WAVES_COMMIT_ENV]?.trim() || (forge === "gitlab" ? env.CI_COMMIT_SHA : env.GITHUB_SHA)?.trim();
  return commit ? { key: commit, commit } : undefined;
}

/** The run a record job runs in, as the record names it: GitHub and Forgejo `GITHUB_RUN_ID`, GitLab `CI_PIPELINE_ID`, and its page when the forge says. */
function runOf(forge: OpWavesFollowOnTarget["forge"], env: Record<string, string | undefined>): Pick<FollowOnRecord, "run" | "url"> {
  if (forge === "gitlab") {
    const url = env.CI_PIPELINE_URL?.trim();
    return { run: env.CI_PIPELINE_ID?.trim() || "unknown", ...(url && /^https?:\/\//.test(url) ? { url } : {}) };
  }
  const id = env.GITHUB_RUN_ID?.trim();
  const server = env.GITHUB_SERVER_URL?.trim().replace(/\/+$/, "");
  const repo = env.GITHUB_REPOSITORY?.trim();
  return { run: id || "unknown", ...(forge === "github" && id && server && repo && /^https?:\/\//.test(server) ? { url: `${server}/${repo}/actions/runs/${id}` } : {}) };
}

/**
 * After the rest wave's record job wrote its run records (#4992): leave the
 * note, and when the run applied every wave it ran and the plan found more,
 * start the follow-on for the next one. Resolves to the job's exit: the
 * record job's own, or failed when the follow-on could not be started (the
 * note still says it was to be, so nothing after the run takes it for the
 * last). A job that is not the rest wave's, or whose pipeline sets no
 * {@link OP_WAVES_FOLLOW_ON_ENV}, is left as it is.
 */
export async function followOnAfterRecord(i: FollowOnAfterRecordInput): Promise<number> {
  const env = i.env ?? process.env;
  const log = i.log ?? ((line: string) => console.error(line));
  const rest = opWavesRestWave(i.spec);
  if (rest === undefined || i.wave < rest) return i.exitCode;
  const target = parseFollowOnTarget(env[OP_WAVES_FOLLOW_ON_ENV]);
  if (!target) return i.exitCode;
  const cwd = i.cwd ?? process.cwd();
  let found: number | undefined;
  try {
    const decision = JSON.parse(readFileSync(join(cwd, opWaveRecordPath(i.spec, i.wave)), "utf-8")) as { discovered?: { waves?: unknown } };
    const w = decision?.discovered?.waves;
    if (Number.isInteger(w)) found = w as number;
  } catch {
    found = undefined;
  }
  const outcomeDir = opWaveOutcomeDir(i.spec);
  const dir = isAbsolute(outcomeDir) ? outcomeDir : join(cwd, outcomeDir);
  const { earlierWaveOutcomes } = await import("../wave-blocked");
  const { applyOutcomeOf } = await import("../control/applied");
  const own = earlierWaveOutcomes([dir], Number.MAX_SAFE_INTEGER).members;
  const summary = applyOutcomeOf(own);
  const through = summary.outcome === "applied" || summary.outcome === "unchanged";
  const next = i.exitCode === CHANT_EXIT.done && through && found !== undefined && found > i.wave ? i.wave + 1 : undefined;
  // #4998: a follow-on's record job reads the record that started it, for the outcomes of the chain's earlier runs.
  const chainKey = followOnChainOf(target.forge, env);
  let port = i.chain;
  const chainPort = async (): Promise<FollowOnChainPort> => (port ??= (await import("./follow-on-store")).gitFollowOnChainPort({ cwd }));
  let chain: Record<string, FollowOnOutcome> = {};
  if (i.wave > rest && chainKey) {
    try {
      const started = await (await chainPort()).read(i.spec.name, chainKey.key);
      if (started && started.wave === i.wave) chain = started.outcomes;
      else log(`wave ${i.wave}: no record on chant/lifecycle started this wave for ${chainKey.key.slice(0, 12)}, so the outcomes of the chain's earlier runs are not added up`);
    } catch (err) {
      log(`wave ${i.wave}: the record that started this run could not be read (${(err instanceof Error ? err.message : String(err)).split("\n")[0]}), so the outcomes of the chain's earlier runs are not added up`);
    }
  }
  mkdirSync(dir, { recursive: true });
  const note: OpWaveRestNote = { version: 1, op: i.spec.name, wave: i.wave, found: found ?? i.wave, ...(next !== undefined ? { next } : {}), ...(Object.keys(chain).length > 0 ? { chain } : {}) };
  writeFileSync(join(dir, OP_WAVE_REST_NOTE), JSON.stringify(note, null, 2) + "\n");
  if (next === undefined) {
    if (found !== undefined && found > i.wave) log(`wave ${i.wave}: the plan found ${found} waves, and this run ended ${summary.outcome} (exit ${i.exitCode}), so no run starts wave ${i.wave + 1}`);
    return i.exitCode;
  }
  // #4998: record the follow-on before it starts: its guard admits the wave this record names, and no other.
  try {
    if (!chainKey) throw new Error("the run names no decided head and no commit to go on with");
    const outcomes: Record<string, FollowOnOutcome> = {};
    for (const [member, o] of withChainOutcomes(own, note)) outcomes[member] = { status: o.status, ...(o.by !== undefined ? { by: o.by } : {}), wave: o.wave, at: o.at };
    const record: FollowOnRecord = { ...chainKey, wave: next, from: i.wave, ...runOf(target.forge, env), at: (i.now ?? (() => new Date()))().toISOString(), outcomes };
    await (await chainPort()).write(i.spec.name, record);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`wave ${i.wave} applied, and the follow-on for wave ${next} could not be recorded on chant/lifecycle (${message.split("\n")[0]}), so none is started: its guard would refuse it`);
    return CHANT_EXIT.failed;
  }
  try {
    const started = await (i.start ?? startFollowOn)(target, next, env);
    log(`wave ${i.wave} applied; the plan found ${found} waves, so a follow-on run${started.url ? ` (${started.url})` : ""} goes on with wave ${next}`);
    return i.exitCode;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`wave ${i.wave} applied, and the follow-on run for wave ${next} could not be started (${message.split("\n")[0]}); start the waves workflow by hand with ${OP_WAVES_WAVE_ENV}=${next} and this run's other inputs`);
    return CHANT_EXIT.failed;
  }
}

/**
 * Start the follow-on run for wave `wave` through the forge's API: the
 * values the run carries come from the record job's own variables (the
 * decision, or the commit the run applied).
 */
export async function startFollowOn(target: OpWavesFollowOnTarget, wave: number, env: Record<string, string | undefined>, fetchFn: typeof fetch = fetch): Promise<StartedFollowOn> {
  const run = beforeMergeRunFromEnv(env);
  const bm = isBeforeMergeRun(run);
  const commit = bm ? undefined : followOnChainOf(target.forge, env)?.commit;
  if (!bm && !commit) throw new Error("the run names no commit to go on with");
  const values: Record<string, string> = bm ? { pr: run.pr!, head: run.head!, digest: run.digest!, wave: String(wave) } : { wave: String(wave), commit: commit! };
  const { forgeTargetFromEnv } = await import("../pr-forge");
  const tokenEnv = [FOLLOW_ON_TOKEN_ENV, FORGE_TOKEN_VAR].find((n) => env[n]?.trim());
  const t = forgeTargetFromEnv(env, { kind: target.forge, ...(tokenEnv ? { tokenEnv } : {}) });
  const post = async (url: string, headers: Record<string, string>, body: unknown): Promise<unknown> => {
    const res = await fetchFn(url, { method: "POST", headers: { ...headers, Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) throw new Error(`POST ${url} answered ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  };
  if (target.forge === "gitlab") {
    const ref = env.CI_COMMIT_REF_NAME;
    if (!ref) throw new Error("the job names no branch (no CI_COMMIT_REF_NAME)");
    const names: Record<string, string> = { pr: "CHANT_BEFORE_MERGE_PR", head: "CHANT_BEFORE_MERGE_HEAD", digest: "CHANT_BEFORE_MERGE_DIGEST", wave: OP_WAVES_WAVE_ENV, commit: OP_WAVES_COMMIT_ENV };
    const variables = Object.entries(values).map(([k, value]) => ({ key: names[k]!, value, variable_type: "env_var" }));
    const project = encodeURIComponent(decodeURIComponent(t.repo));
    const v = (await post(`${t.apiBase}/projects/${project}/pipeline`, { [t.tokenHeader ?? "PRIVATE-TOKEN"]: t.token }, { ref, variables })) as { web_url?: unknown } | null;
    return typeof v?.web_url === "string" && /^https?:\/\//.test(v.web_url) ? { url: v.web_url } : {};
  }
  const ref = env.GITHUB_REF_NAME?.trim() || env.GITHUB_REF?.replace(/^refs\/heads\//, "");
  if (!ref) throw new Error("the job names no branch (no GITHUB_REF_NAME)");
  await post(`${t.apiBase}/repos/${t.repo}/actions/workflows/${encodeURIComponent(target.workflow!)}/dispatches`, { Authorization: `token ${t.token}` }, { ref, inputs: values });
  return {};
}
