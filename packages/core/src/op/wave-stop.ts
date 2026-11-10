/**
 * A wave stop on a re-run (#4979): `/<product> apply wave-<n>` on a merged
 * pull request runs its apply again and stops after wave n.
 *
 * A forge re-run cannot be told where to stop: GitHub's re-run of a run's
 * failed jobs runs every job after them, Forgejo's dispatch runs the whole
 * workflow, and GitLab runs the jobs after a retried one by itself. So the
 * comment's job writes the stop on `chant/lifecycle` before it starts the
 * run, `_waves/<op>.stops.json`, keyed by the commit the run applies, and
 * each wave job of op `<op>` at that commit reads it before it plans: a wave
 * after the stop waits, as a wave whose gate has no approval waits (exit 3),
 * so a later `/<product> apply` runs it. An apply comment without a wave
 * clears the commit's stop. The newest {@link WAVE_STOPS_KEPT} stops are
 * kept.
 */

import { fetchLifecycleStatus, getHeadCommit, pushLifecycleStatus, readBlobBySha, readPathSha, writeBlobToPath } from "../lifecycle/git";

/** The directory of the stops on `chant/lifecycle`. */
export const WAVE_STOPS_DIR = "_waves";

/** How many commits' stops the file keeps. */
export const WAVE_STOPS_KEPT = 50;

/** The stops file of op `op`. */
export function waveStopsFile(op: string): string {
  return `${op}.stops.json`;
}

/** One commit's stop: the last wave that runs, and who asked. */
export interface WaveStop {
  through: number;
  at: string;
  by?: string;
  pr?: number;
}

/** The stops file. */
export interface WaveStopsFile {
  version: 1;
  stops: Record<string, WaveStop>;
}

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const OP = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** Read a stops file; anything that is not one reads as no stops, and a malformed entry is dropped. */
export function parseWaveStops(text: string | null): WaveStopsFile {
  let doc: unknown;
  try {
    doc = JSON.parse(text ?? "null");
  } catch {
    return { version: 1, stops: {} };
  }
  const stops: Record<string, WaveStop> = {};
  const given = doc && typeof doc === "object" && (doc as { version?: unknown }).version === 1 ? (doc as { stops?: unknown }).stops : undefined;
  if (given && typeof given === "object") {
    for (const [sha, s] of Object.entries(given as Record<string, unknown>)) {
      const v = s as Partial<WaveStop> | null;
      if (!SHA.test(sha) || !v || !Number.isInteger(v.through) || (v.through as number) < 1 || typeof v.at !== "string") continue;
      stops[sha] = { through: v.through as number, at: v.at, ...(typeof v.by === "string" ? { by: v.by } : {}), ...(Number.isInteger(v.pr) ? { pr: v.pr as number } : {}) };
    }
  }
  return { version: 1, stops };
}

/** The file's text: the newest {@link WAVE_STOPS_KEPT} stops, by commit. */
export function renderWaveStops(file: WaveStopsFile): string {
  const newest = Object.entries(file.stops).sort((a, b) => b[1].at.localeCompare(a[1].at)).slice(0, WAVE_STOPS_KEPT);
  return `${JSON.stringify({ version: 1, stops: Object.fromEntries(newest.sort((a, b) => a[0].localeCompare(b[0]))) }, null, 2)}\n`;
}

/** Whether wave `k` waits under `stop`. */
export function waveStopped(stop: WaveStop | undefined, k: number): boolean {
  return stop !== undefined && k > stop.through;
}

/** The stop of op `op` at commit `sha`, from the local `chant/lifecycle` after a fetch. Undefined when there is none or the branch cannot be read. */
export async function waveStopAt(op: string, sha: string, opts: { cwd?: string } = {}): Promise<WaveStop | undefined> {
  if (!OP.test(op) || !SHA.test(sha)) return undefined;
  await fetchLifecycleStatus(opts);
  const blob = await readPathSha(WAVE_STOPS_DIR, waveStopsFile(op), opts);
  if (!blob) return undefined;
  return parseWaveStops(await readBlobBySha(blob, opts)).stops[sha];
}

/**
 * What a wave job of op `op` says when wave `k` waits behind a comment's
 * stop at the job's checkout (`git rev-parse HEAD`). Undefined when it runs:
 * no stop, no commit to read, or a branch that cannot be read, so a stop
 * never fails a wave that would have run. `sha` (#4987) names the commit
 * in place of the checkout's: a split wave's gate job runs at the default
 * branch and reads the stop of the decided head.
 */
export async function waveStopLine(op: string, k: number, opts: { cwd?: string; sha?: string } = {}): Promise<string | undefined> {
  let sha: string;
  try {
    sha = opts.sha ?? (await getHeadCommit(opts));
  } catch {
    return undefined;
  }
  let stop: WaveStop | undefined;
  try {
    stop = await waveStopAt(op, sha, opts);
  } catch {
    return undefined;
  }
  if (!waveStopped(stop, k)) return undefined;
  const who = stop!.by ? `${stop!.by}'s` : "a";
  const where = stop!.pr !== undefined ? ` on pull request ${stop!.pr}` : "";
  return `wave ${k} waits: ${who} comment${where} ran ${op} again at ${sha.slice(0, 12)} through wave ${stop!.through}; comment the apply again without a wave to run the waves after it`;
}

/**
 * Set op `op`'s stop at commit `sha`, or clear it (`stop` null), and push
 * `chant/lifecycle`. Read, written and pushed again when another writer
 * pushed first, up to three times.
 */
export async function setWaveStop(op: string, sha: string, stop: WaveStop | null, opts: { cwd?: string } = {}): Promise<{ changed: boolean; pushed: boolean }> {
  if (!OP.test(op)) throw new Error(`the op name ${JSON.stringify(op)} is not a stops file name`);
  if (!SHA.test(sha)) throw new Error(`${JSON.stringify(sha)} is not a commit sha`);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const fetched = await fetchLifecycleStatus(opts);
    if (fetched.status === "unreachable") throw new Error("chant/lifecycle could not be fetched, so the stop was not written");
    const blob = await readPathSha(WAVE_STOPS_DIR, waveStopsFile(op), opts);
    const file = parseWaveStops(blob ? await readBlobBySha(blob, opts) : null);
    const next: WaveStopsFile = { version: 1, stops: { ...file.stops } };
    if (stop) next.stops[sha] = stop;
    else delete next.stops[sha];
    if (renderWaveStops(next) === renderWaveStops(file)) return { changed: false, pushed: false };
    const what = stop ? `Stop ${op} after wave ${stop.through} at ${sha.slice(0, 12)}` : `Clear the stop of ${op} at ${sha.slice(0, 12)}`;
    await writeBlobToPath(WAVE_STOPS_DIR, waveStopsFile(op), renderWaveStops(next), what, { ...opts, expectPriorPathSha: blob });
    const pushed = await pushLifecycleStatus(opts);
    if (pushed.status === "stale") continue;
    if (pushed.status === "failed") throw new Error(`could not push the stop to chant/lifecycle (${pushed.stderr.trim()})`);
    return { changed: true, pushed: pushed.status === "pushed" };
  }
  throw new Error("chant/lifecycle kept moving, so the stop was not written; comment again");
}
