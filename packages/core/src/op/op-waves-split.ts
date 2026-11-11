/**
 * Op waves before merge, split so the change's code never runs beside a
 * write token (#4987).
 *
 * Maintainer decision (2026-11-10): in a pipeline with `beforeMerge` each
 * wave is four jobs.
 *
 * 1. `<wave>-plan` runs the change's code and holds no write token: the
 *    checkout keeps no credentials, the job's token can only read (GitHub),
 *    and on GitLab its script drops `CHANT_FORGE_TOKEN` and the job token.
 *    `chant run wave --phase plan` plans the wave and saves the plan
 *    ({@link opWaveSavedPlanPath}, beside the plan files) as an artifact.
 * 2. `<wave>-gate` runs the default branch's code alone, with the token:
 *    `--phase gate` reads the rules at base, takes the saved plan, refuses
 *    it when its digest is not the one its plan files give, writes the
 *    gate's pending fact or spends the approval on `chant/lifecycle`, and
 *    keeps the decision record, as a wide wave's deciding job does.
 * 3. `<wave>` (or each share and job group's job) applies the saved plan,
 *    with no write token: `--phase apply` checks each plan file's digest
 *    against the decision and applies the ones that match. Its run record
 *    goes to a file ({@link opWaveRunRecordFileName}) in place of the ledger.
 * 4. `<wave>-record` runs the default branch's code with the token:
 *    `--phase record` writes those run records to the run ledger and exits
 *    as the wave's applying jobs did.
 *
 * A push run of the same pipeline takes the same four jobs. A pipeline
 * without `beforeMerge` keeps one job per wave (or a deciding job and its
 * shares), since a push runs merged code.
 *
 * A `step` spec (#4992) plans in the plan job's process; the saved plan
 * keeps each run's step plan (its digest, effects and lock rows) without the
 * engine's artifact. The gate job leases the rows the runs wait for and
 * change, with no heartbeat, before it spends the approval, and the
 * decision names the lease. The applying job plans its runs again through
 * the step, as a share job does, and applies each whose plan digest the
 * decision holds; it hands the release records to the record job, which
 * writes them and lets go of the lease. A run whose plan moved is exit 4.
 *
 * A hook that holds the wave on another gate (#4992) in the plan or apply
 * job reads that gate with no write token: approved, the wave goes on; still
 * waiting, the job leaves the gate's pending fact to the gate job (a plan
 * job's hold) or the record job (an apply job's), which records it, and the
 * wave waits. A hold that asks chant to `record` the gate is spent before
 * its hook runs again, so it fails in those jobs once approved.
 *
 * A `rest` wave runs the waves its plan finds in one job; before merge each
 * wave needs jobs of its own, so {@link assertOpWavesSplit} refuses it.
 */

import { opWaveOutcomePath, opWaveRecordPath, type OpWaveJob, type OpWavesSpec } from "./op-waves";

/** The four jobs of a split wave (#4987). */
export type OpWavePhase = "plan" | "gate" | "apply" | "record";

export const OP_WAVE_PHASES: readonly OpWavePhase[] = ["plan", "gate", "apply", "record"];

/** One job of a split wave. `kind` is `decide` for the plan and gate jobs, `share` for an applying job and `wave` for the record job. */
export interface OpWaveSplitJob extends OpWaveJob {
  phase: OpWavePhase;
  /** The job checks out and runs the change's code: the plan and apply jobs. It holds no write token. */
  runsChange: boolean;
}

/** Where a wave's plan job saves its plan, beside the run plan files the apply reads (#4987). */
export function opWaveSavedPlanDir(spec: Pick<OpWavesSpec, "name">, wave: number): string {
  return `.chant/op-waves/${spec.name}/wave-${wave}`;
}

/** The saved plan file itself. */
export function opWaveSavedPlanPath(spec: Pick<OpWavesSpec, "name">, wave: number): string {
  return `${opWaveSavedPlanDir(spec, wave)}/saved-plan.json`;
}

/** The file an applying job leaves its run record in, in the outcome directory, for the record job (#4987). */
export function opWaveRunRecordFileName(wave: number, part: { group?: string; share?: number } = {}): string {
  const group = part.group !== undefined ? `-group-${part.group.replace(/[^A-Za-z0-9._-]/g, "_")}` : "";
  const share = part.share !== undefined ? `-share-${part.share}` : "";
  return `run-record-wave-${wave}${group}${share}.json`;
}

/** A run record file's name, as {@link opWaveRunRecordFileName} gives it; group 1 is the wave. */
export const OP_WAVE_RUN_RECORD_FILE = /^run-record-wave-(\d+)(?:-group-[A-Za-z0-9._-]+)?(?:-share-\d+)?\.json$/;

/** Refuse a spec whose waves cannot run as four jobs each, naming why. A `step` spec splits (#4992). */
export function assertOpWavesSplit(spec: Pick<OpWavesSpec, "name" | "waves">): void {
  const where = `Op waves "${spec.name}" with beforeMerge`;
  const rest = spec.waves.find((w) => w.rest === true);
  if (rest) {
    throw new Error(`${where}: wave "${rest.name}" has \`rest\`, which runs the waves its plan finds in one job; before merge each wave is a plan, a gate, an apply and a record job, so the pipeline needs a job for every wave it runs.`);
  }
}

/** A wave job's command without `--decide`, which the plan and gate jobs take the place of. */
function baseCommand(job: OpWaveJob): string[] {
  return job.command.filter((w) => w !== "--decide");
}

/** The job after which the waves after wave `k` start: its record job. */
export function opWaveRecordJobName(spec: Pick<OpWavesSpec, "waves">, k: number): string {
  return `wave-${k}-${spec.waves[k - 1]!.name}-record`;
}

/**
 * The split jobs of a before-merge pipeline (#4987), from `opWaveJobs`, in
 * order: for each wave its plan job, its gate job, its applying jobs (the
 * wave's own job, or each share and job group's job) and its record job.
 * The plan job of each wave after the first needs the record job of the
 * wave before; the gate needs the plan, each applying job the gate, and the
 * record job every applying job and the gate, whose decision names the rows
 * it leased (#4992).
 */
export function opWaveSplitJobs(spec: OpWavesSpec, jobs: readonly OpWaveJob[]): OpWaveSplitJob[] {
  assertOpWavesSplit(spec);
  const out: OpWaveSplitJob[] = [];
  for (let k = 1; k <= spec.waves.length; k++) {
    const own = jobs.filter((j) => j.wave === k);
    const first = own[0]!;
    const prefix = `wave-${k}-${first.waveName}`;
    const needs = k === 1 ? [] : [opWaveRecordJobName(spec, k - 1)];
    const base = baseCommand(first);
    const plan = `${prefix}-plan`;
    const gate = `${prefix}-gate`;
    out.push({ jobName: plan, wave: k, waveName: first.waveName, kind: "decide", needs, command: [...base, "--phase", "plan"], outcome: opWaveOutcomePath(spec, k), phase: "plan", runsChange: true });
    out.push({ jobName: gate, wave: k, waveName: first.waveName, kind: "decide", needs: [plan], command: [...base, "--phase", "gate"], record: opWaveRecordPath(spec, k), outcome: opWaveOutcomePath(spec, k), phase: "gate", runsChange: false });
    const applying = first.kind === "wave" ? [first] : own.filter((j) => j.kind === "share");
    for (const job of applying) {
      // The wave's own applying job writes `-apply`, so it never reads its own outcome as the gate job's.
      const outcome = job.kind === "wave" ? opWaveOutcomePath(spec, k, { apply: true }) : job.outcome;
      out.push({ ...job, kind: "share", needs: [gate], command: [...baseCommand(job), "--phase", "apply"], record: opWaveRecordPath(spec, k), outcome, phase: "apply", runsChange: true });
    }
    out.push({ jobName: opWaveRecordJobName(spec, k), wave: k, waveName: first.waveName, kind: "wave", needs: [...applying.map((j) => j.jobName), gate], record: opWaveRecordPath(spec, k), command: [...base, "--phase", "record"], outcome: opWaveOutcomePath(spec, k), phase: "record", runsChange: false });
  }
  return out;
}

/** The jobs a job after the waves needs in a split pipeline: the last wave's record job. */
export function opWaveSplitLastJobs(spec: Pick<OpWavesSpec, "waves">): string[] {
  return [opWaveRecordJobName(spec, spec.waves.length)];
}

/** What a split job calls itself in its guard's lines: `the plan job of wave 2 (prod) of tf-apply`, `share 1 of wave 2 (prod) of tf-apply`. */
export function opWaveSplitJobLabel(spec: string, job: Pick<OpWaveSplitJob, "phase" | "wave" | "waveName" | "share" | "group">): string {
  const wave = `wave ${job.wave} (${job.waveName}) of ${spec}`;
  if (job.phase !== "apply") return `the ${job.phase} job of ${wave}`;
  const share = job.share !== undefined ? `share ${job.share} of ` : "";
  if (job.group !== undefined) return `${share}job group ${job.group} of ${wave}`;
  return share ? `${share}${wave}` : `the apply job of ${wave}`;
}

/** The split jobs of wave `k`, by name, for a job after it (an apply status). */
export function opWaveSplitWaveJobs(jobs: readonly OpWaveSplitJob[], k: number): string[] {
  return jobs.filter((j) => j.wave === k).map((j) => j.jobName);
}
