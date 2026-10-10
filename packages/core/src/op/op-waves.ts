/**
 * Gated waves of Op runs (#3679): a pipeline that applies one Op per
 * environment, or per target in a set, in order, each wave behind one gate.
 *
 * A product built on chant that applies a migration to dev, then staging, then
 * prod, or the same change to every tenant database of an environment, used to
 * render that ordering itself, once per forge, and compute each wave's set
 * digest itself. This module holds the forge-neutral part: the spec, the jobs
 * it becomes and the commands they run. Each forge lexicon (github, gitlab,
 * forgejo) renders these jobs with its own transport, so the three cannot
 * disagree about order or commands. `./op-waves-run.ts` is what the jobs run.
 *
 * ## Jobs
 *
 * A wave is one job, `wave-<k>-<name>`, running `chant run wave --spec <file>
 * --wave <k>`: plan every run, decide the wave's gate, apply. A wide wave
 * (`shares` > 1) is a deciding job that plans every run and decides the gate,
 * plus `shares` jobs that each apply a slice of the runs and refuse a run
 * whose plan moved since the decision. Each wave's jobs need the previous
 * wave's last jobs, so a wave that waits (exit 3) or fails stops every later
 * wave.
 *
 * ## The gate
 *
 * Wave k waits on `waveGateName(<gate>, k)`, recorded under the spec's name,
 * bound to {@link waveSetDigest} over its runs' plan digests (`../gated-waves.ts`,
 * the same digest a component fan-out's wave binds). Whether it waits at all
 * is the wave's gate policy, read from the base commit's copy of the spec
 * file, so a change cannot loosen the rule that gates its own merge.
 */

import type { OpEnvironment, OpSetupStep } from "../lexicon";

/** When a wave waits for an approval. */
export type OpWaveGatePolicy =
  /** Whenever the wave changes something. */
  | "always"
  /** When a run's plan says it is destructive. */
  | "on-destructive"
  /** Never: only review and branch protection stand in front of the wave. */
  | "never";

export const OP_WAVE_GATE_POLICIES: readonly OpWaveGatePolicy[] = ["always", "on-destructive", "never"];

/** One Op run in a wave: an Op applied to one target (an environment, a database, a tenant). */
export interface OpWaveRun {
  /** What the run applies to. Unique within its wave; it names the run in the set digest. */
  target: string;
  /** The Op to run. Default: the spec's `op`. */
  op?: string;
}

/** One wave: runs that apply together, behind one gate. */
export interface OpWave {
  /** The wave's name, usually its environment. Lowercase letters, digits, `-` and `_`. */
  name: string;
  runs: OpWaveRun[];
  /**
   * When the wave waits. Default `"always"`. The runner reads this from the
   * spec file at the base commit, never from the change being applied.
   */
  gate?: OpWaveGatePolicy;
  /**
   * Split the wave into a deciding job and this many share jobs, each
   * applying a slice of the runs. Default 1: one job plans, decides and
   * applies.
   */
  shares?: number;
  /** The forge deployment environment the wave's jobs run in (GitHub and GitLab; Forgejo has none). */
  environment?: OpEnvironment;
  /** Variables for this wave's jobs alone. */
  variables?: Record<string, string>;
  /** Steps this wave's jobs run after the checkout, as `ScheduledOpSpec.setup`. */
  setup?: OpSetupStep[];
}

/**
 * An ordered list of waves of Op runs, as a pipeline and as the file its jobs
 * read. Commands are argv templates; each `{op}`, `{target}`, `{wave}` and
 * `{plan}` is replaced per run.
 */
export interface OpWavesSpec {
  /** The pipeline's name, and the op the wave gates are recorded under (`chant approve <name> <gate>-wave-<k>`). */
  name: string;
  /** The Op a run runs when it names none. */
  op: string;
  /** The base gate name. Default: `name`. */
  gate?: string;
  /** Branches whose pushes run the waves. Default `["main"]`. */
  branches?: string[];
  /**
   * The commit the gate policy is read from. Default `HEAD^1`, the first
   * parent: on a merge or squash onto the branch, the branch before the change.
   */
  base?: string;
  /**
   * Plan one run and write its plan file to `{plan}`: JSON `{ "planDigest":
   * string, "destructive"?: boolean, "empty"?: boolean }`. `destructive` is
   * what `on-destructive` waits on; a wave whose runs are all `empty` never
   * waits.
   */
  plan: string[];
  /** Apply one run whose plan is at `{plan}`. Default `chant run {op} --env {target}`. */
  apply?: string[];
  waves: OpWave[];
  /**
   * A scheduled job that starts again a wave job whose approval has arrived
   * (#3683): it runs `chant run resume --op <name>`, which re-runs the
   * GitHub run, retries the GitLab job or dispatches the Forgejo workflow.
   * It approves nothing. Absent, no such job is rendered and an approval is
   * followed by `chant approve --resume` or a re-run by hand.
   */
  resume?: OpWavesResume;
}

/** The scheduled resume job of an Op waves pipeline (#3683). */
export interface OpWavesResume {
  /**
   * Five-field cron, such as `"*\/10 * * * *"`. GitHub and Forgejo put it
   * in the workflow; GitLab runs the job in a pipeline schedule you create,
   * which sets the cron.
   */
  schedule: string;
}

/** The command a resume job runs. */
export function opWavesResumeCommand(spec: Pick<OpWavesSpec, "name">): string[] {
  return ["chant", "run", "resume", "--op", spec.name];
}

/** The default apply command. */
export const OP_WAVE_DEFAULT_APPLY = ["chant", "run", "{op}", "--env", "{target}"];

/** Where the runner keeps a wave's decision; a wide wave's deciding job hands it to its share jobs. */
export function opWaveRecordPath(spec: Pick<OpWavesSpec, "name">, wave: number): string {
  return `.chant/op-waves/${spec.name}/wave-${wave}.json`;
}

/** One generated job. */
export interface OpWaveJob {
  jobName: string;
  /** 1-based wave number. */
  wave: number;
  /** The wave's name. */
  waveName: string;
  /** `wave`: plan, decide and apply. `decide`: plan and decide. `share`: apply one slice. */
  kind: "wave" | "decide" | "share";
  /** 1-based, on a share job. */
  share?: number;
  /** Jobs this one waits on. */
  needs: string[];
  /** The job's command, as argv. */
  command: string[];
  /** On a share job: the decision record to download. On a deciding job: the one to upload. */
  record?: string;
}

const NAME = /^[a-z0-9][a-z0-9_-]*$/;

/** Refuse a spec no job could run, naming what is wrong. */
export function assertOpWavesSpec(spec: OpWavesSpec): void {
  const where = `Op waves "${spec.name}"`;
  if (!NAME.test(spec.name)) throw new Error(`${where}: the name must be lowercase letters, digits, "-" and "_"`);
  if (!spec.op) throw new Error(`${where} names no \`op\`. Name the Op a run runs when it names none.`);
  if (!Array.isArray(spec.plan) || spec.plan.length === 0) {
    throw new Error(`${where} has no \`plan\` command. Each wave plans its runs to bind its gate to their plan digests.`);
  }
  if (!spec.plan.some((part) => part.includes("{plan}"))) {
    throw new Error(`${where}: the \`plan\` command never names {plan}, the file it writes the plan digest to.`);
  }
  if (spec.waves.length === 0) throw new Error(`${where} has no waves.`);
  if (spec.resume !== undefined && (typeof spec.resume.schedule !== "string" || spec.resume.schedule.trim().split(/\s+/).length !== 5)) {
    throw new Error(`${where}: resume.schedule must be a five-field cron expression, such as "*/10 * * * *".`);
  }
  const names = new Set<string>();
  for (const wave of spec.waves) {
    if (!NAME.test(wave.name)) {
      throw new Error(`${where}: wave "${wave.name}" must be named with lowercase letters, digits, "-" and "_"`);
    }
    if (names.has(wave.name)) throw new Error(`${where} names wave "${wave.name}" twice.`);
    names.add(wave.name);
    if (wave.gate !== undefined && !OP_WAVE_GATE_POLICIES.includes(wave.gate)) {
      throw new Error(`${where}: wave "${wave.name}" has gate "${wave.gate}"; use ${OP_WAVE_GATE_POLICIES.join(", ")}.`);
    }
    if (wave.runs.length === 0) throw new Error(`${where}: wave "${wave.name}" has no runs.`);
    const targets = new Set<string>();
    for (const run of wave.runs) {
      if (!run.target) throw new Error(`${where}: wave "${wave.name}" has a run with no target.`);
      if (targets.has(run.target)) throw new Error(`${where}: wave "${wave.name}" names target "${run.target}" twice.`);
      targets.add(run.target);
    }
    const shares = wave.shares ?? 1;
    if (!Number.isInteger(shares) || shares < 1) {
      throw new Error(`${where}: wave "${wave.name}" has shares ${wave.shares}; use a whole number from 1.`);
    }
    if (shares > wave.runs.length) {
      throw new Error(`${where}: wave "${wave.name}" has ${shares} shares for ${wave.runs.length} runs, so a share would apply nothing.`);
    }
  }
}

/**
 * The runs share `share` (1-based) of `shares` applies: the wave's runs sorted
 * by target, cut into contiguous slices whose sizes differ by at most one.
 */
export function opWaveShare<T extends { target: string }>(runs: readonly T[], share: number, shares: number): T[] {
  const sorted = [...runs].sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
  const base = Math.floor(sorted.length / shares);
  const extra = sorted.length % shares;
  const start = (share - 1) * base + Math.min(share - 1, extra);
  const size = base + (share <= extra ? 1 : 0);
  return sorted.slice(start, start + size);
}

/**
 * The jobs of an Op waves pipeline, in order. `specFile` is the spec's path
 * from the job's working directory, which every command names.
 */
export function opWaveJobs(spec: OpWavesSpec, specFile: string): OpWaveJob[] {
  assertOpWavesSpec(spec);
  const jobs: OpWaveJob[] = [];
  let previous: string[] = [];
  spec.waves.forEach((wave, index) => {
    const k = index + 1;
    const command = ["chant", "run", "wave", "--spec", specFile, "--wave", String(k), ...(spec.base ? ["--base", spec.base] : [])];
    const prefix = `wave-${k}-${wave.name}`;
    const shares = wave.shares ?? 1;
    if (shares === 1) {
      jobs.push({ jobName: prefix, wave: k, waveName: wave.name, kind: "wave", needs: previous, command });
      previous = [prefix];
      return;
    }
    const record = opWaveRecordPath(spec, k);
    const decide = `${prefix}-decide`;
    jobs.push({ jobName: decide, wave: k, waveName: wave.name, kind: "decide", needs: previous, command: [...command, "--decide"], record });
    const shareJobs: string[] = [];
    for (let share = 1; share <= shares; share++) {
      const jobName = `${prefix}-share-${share}`;
      shareJobs.push(jobName);
      jobs.push({ jobName, wave: k, waveName: wave.name, kind: "share", share, needs: [decide], command: [...command, "--share", String(share)], record });
    }
    previous = shareJobs;
  });
  return jobs;
}

/** The wave a job belongs to. */
export function opWaveOf(spec: OpWavesSpec, job: Pick<OpWaveJob, "wave">): OpWave {
  return spec.waves[job.wave - 1]!;
}
