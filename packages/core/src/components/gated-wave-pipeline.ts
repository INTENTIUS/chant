/**
 * The jobs of a generated gated-wave pipeline (#3049): one CI job per wave.
 *
 * The ruling in #3347 puts gated waves on forge CI by default, a job per
 * wave, with approvals on `chant/lifecycle`. Each forge's generator (the
 * gitlab and github lexicons) takes these jobs and adds its own transport;
 * the commands and the order live here so the two cannot disagree.
 *
 * Job `wave-k` runs `chant components fan-out --wave-gate <gate> --wave k`.
 * It derives the fan-out from the change, plans wave k against the outputs
 * the record holds, decides that wave's gate and applies it. The attempt
 * record (`--resume`) is the artifact handed from job to job: it says which
 * components applied and what they exposed. A gate nobody approved exits 3,
 * which fails the job; after `chant approve fan-out <gate>-wave-<k> --plan
 * <digest>`, re-running that job carries on.
 *
 * How many jobs: the waves of the whole component graph, with the canary list
 * in front. A change selects a subset, and a subset never layers deeper than
 * the graph it came from, so a job past the change's last wave finds nothing
 * to run and exits 0.
 */

import type { DriverComponent } from "./driver";
import { layerWaves } from "../gated-waves";

/** Where each wave job keeps the attempt record it hands the next one. */
export const GATED_WAVE_RECORD = ".chant/fan-out.json";

/** The `gatedWaves` generator option (`ComponentPipelineOptions.gatedWaves`). */
export interface GatedWavePipelineOptions {
  /** The base gate name. Wave k waits on `<gate>-wave-<k>`. */
  gate: string;
  /** Components that form wave 1. */
  canary?: string[];
  /**
   * The ref the change is measured from (`--base`). Default `HEAD~1`: the
   * pipeline runs on the merge commit and fans out what it changed. Every
   * job must derive the same fan-out, so this must not move between jobs.
   */
  base?: string;
}

export interface GatedWaveJob {
  /** 1-based. */
  wave: number;
  /** `wave-<k>`. */
  jobName: string;
  /** The previous wave's job, if any. */
  needs: string[];
  /** The job's command, as argv. */
  command: string[];
}

/** One job per possible wave, in order, each needing the one before. */
export function gatedWaveJobs(
  components: DriverComponent[],
  env: string,
  options: GatedWavePipelineOptions,
): GatedWaveJob[] {
  const count = layerWaves(
    components.map((c) => ({ name: c.name, dependsOn: c.dependsOn ?? [] })),
    { ...(options.canary?.length ? { canary: options.canary } : {}) },
  ).length;
  const jobs: GatedWaveJob[] = [];
  for (let wave = 1; wave <= count; wave++) {
    jobs.push({
      wave,
      jobName: `wave-${wave}`,
      needs: wave > 1 ? [`wave-${wave - 1}`] : [],
      command: [
        "chant", "components", "fan-out",
        "--base", options.base ?? "HEAD~1",
        "--env", env,
        "--wave-gate", options.gate,
        ...(options.canary?.length ? ["--canary", options.canary.join(",")] : []),
        "--wave", String(wave),
        "--resume", GATED_WAVE_RECORD,
      ],
    });
  }
  return jobs;
}
