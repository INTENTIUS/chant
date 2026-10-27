/**
 * The product pipeline (#4550): the one chant generator terragucci's and
 * plywood's pull request jobs come from. The two differ only in the words
 * and presets each passes.
 *
 * Under the 2026-10-27 ruling (A, hybrid) the plan side is the pull request
 * loop's: the plan job (`pr-plan`), the plan-note job (`pr-post`) and the
 * comment jobs. The apply on merge runs on op waves: one job per wave, each
 * running `chant run wave`, whose plan and apply steps come from chant's
 * capabilities (#4545 for Terraform, #4541 for Pulumi and plunge). The spec
 * names the steps; this module fills the op and gate names from the words
 * and leaves the steps as the spec gives them.
 *
 * Approvals (ruling B) are a preset: `per-wave` keeps each wave's own digest
 * (terragucci), and `pull-request` lets the pull request's approval apply
 * every wave whose plan its change set covers (plywood), through the op
 * waves' `pull-request` approval source (../op/op-waves.ts).
 *
 * The jobs come back as the descriptors the forge lexicons already
 * serialize (`PrLoopJob`, `OpWaveJob`). A product adds its own jobs to the
 * same map before it writes the file.
 */

import type { ForgeKind } from "../pr-forge";
import { layerWaves } from "../gated-waves";
import { opWaveJobs, type OpWave, type OpWaveJob, type OpWavesSpec } from "../op/op-waves";
import {
  assertProductWords,
  CHANT_WORDS,
  commentLine,
  type CiProductCommand,
  type CiProductWords,
  type CiProductWordsInput,
} from "../ci-product-words";
import { prLoopJobs, prLoopPostJob, withProductBin, type PrLoopJob, type PrLoopPipelineOptions } from "./pr-pipeline";
import type { DriverComponent } from "./driver";

/** Where the generator writes a product's waves spec, which chant reads at base (#4550). */
export const PRODUCT_WAVES_SPEC_DIR = ".chant/op-waves";

/** The waves spec file of op `name`: `.chant/op-waves/<name>.spec.json`. */
export function productWavesSpecFile(name: string): string {
  return `${PRODUCT_WAVES_SPEC_DIR}/${name}.spec.json`;
}

/** What {@link productPipelineJobs} takes: the pull request loop's options, the words, and the waves the merge applies. */
export interface ProductPipelineOptions extends Omit<PrLoopPipelineOptions, "words" | "waveGate" | "applyOnMerge"> {
  words: CiProductWordsInput | CiProductWords;
  /** The workspace member the pipeline is for. */
  member?: string;
  /**
   * The waves the apply on merge runs, as the product's config maps onto
   * them. Absent: a merge records the plan (the record job), and a release
   * deploys it.
   */
  waves?: OpWavesSpec;
  /** Where the spec is written, from the job's directory. Default {@link productWavesSpecFile}. */
  wavesSpecFile?: string;
  /** The product runs an agent job that answers its agent command. */
  agent?: boolean;
}

/** The jobs of one product pipeline. */
export interface ProductPipelineJobs {
  /** The words, every slot filled and checked. */
  words: CiProductWords;
  /** The plan job: `pr-plan` with the words. */
  plan: PrLoopJob;
  /** The plan-note job: `pr-post`. */
  post: { command: string; env: Record<string, string> };
  /** The record job, when no waves apply on merge. */
  record?: PrLoopJob;
  /** The apply before merge, answering the apply comment, with `applyBeforeMerge`. */
  applyBeforeMerge?: PrLoopJob;
  /** The comment each command answers, `/<product> <word>`, for the commands the pipeline has a job for. */
  comments: Partial<Record<CiProductCommand, string>>;
  /** The apply on merge: the spec with the words' names, its file, and a job per wave (per share or group). */
  waves?: { spec: OpWavesSpec; specFile: string; jobs: OpWaveJob[] };
}

/**
 * The waves spec with the product's names (#4550): the op the gates are
 * recorded under, the wave gate pattern, and under the `pull-request`
 * preset each wave's approval taken from the pull request's gate. A wave
 * that names its own approval keeps it. Nothing else changes, so the plan
 * and apply steps stay the capability steps the spec names.
 */
export function productWavesSpec(spec: OpWavesSpec, wordsIn: CiProductWordsInput | CiProductWords): OpWavesSpec {
  const words = assertProductWords(wordsIn);
  const byPullRequest = words.approval === "pull-request";
  return {
    ...spec,
    name: words.op ?? spec.name,
    ...(words.gateName !== CHANT_WORDS.gateName ? { gateName: words.gateName } : {}),
    waves: spec.waves.map((w): OpWave => (byPullRequest && w.approval === undefined ? { ...w, approval: "pull-request" } : w)),
    ...(byPullRequest ? { approvals: { ...(spec.approvals ?? {}), pullRequest: { gate: words.prGate } } } : {}),
  };
}

/** An op wave job's argv with the product's bin in place of `chant` (#4550). */
function waveJobWithBin(job: OpWaveJob, bin: string | undefined): OpWaveJob {
  if (!bin || job.command[0] !== "chant") return job;
  return { ...job, command: [...bin.split(/\s+/).filter(Boolean), ...job.command.slice(1)] };
}

/**
 * The product pipeline's jobs for `forge` (#4550): the plan side from the
 * pull request loop with the words, and the apply on merge on op waves. The
 * words are refused when a command names a job the pipeline does not have.
 */
export function productPipelineJobs(forge: ForgeKind, env: string, options: ProductPipelineOptions): ProductPipelineJobs {
  const jobs: CiProductCommand[] = ["plan"];
  if (options.applyBeforeMerge || options.waves) jobs.push("apply");
  if (options.locks === "plan") jobs.push("lock", "unlock");
  if (options.agent) jobs.push("agent");
  const words = assertProductWords(options.words, { jobs });
  const { waves: spec, wavesSpecFile, member, agent: _agent, ...loop } = options;
  const prLoop: PrLoopPipelineOptions = { ...loop, words, gate: options.gate ?? words.prGate };
  const [plan, apply, record] = prLoopJobs(forge, env, prLoop, member);
  const comments: Partial<Record<CiProductCommand, string>> = {};
  for (const c of jobs) {
    const line = commentLine(words, c);
    if (line) comments[c] = line;
  }
  const out: ProductPipelineJobs = {
    words,
    plan: plan!,
    post: prLoopPostJob(forge, env, member, words),
    comments,
    ...(options.applyBeforeMerge ? { applyBeforeMerge: apply! } : {}),
  };
  if (!spec) return { ...out, record: record! };
  const named = productWavesSpec(spec, words);
  const specFile = wavesSpecFile ?? productWavesSpecFile(named.name);
  return { ...out, waves: { spec: named, specFile, jobs: opWaveJobs(named, specFile).map((j) => waveJobWithBin(j, words.bin)) } };
}

/** The capability steps a component waves spec runs (#4545, #4541): argv templates over `{runs}` and `{plans}`. */
export interface ComponentWaveSteps {
  /** Plan every run of a wave through the capability registry, writing `{plans}`. */
  planWave: string[];
  /** Apply a wave's approved set through the capability registry. */
  applyWave: string[];
}

/**
 * A waves spec from the component graph (#4550, ruling A: `pr-apply
 * --wave-gate` rebuilt on op waves): a wave per layer of the graph, each
 * run a component, under the words' op and gate names. The steps are the
 * capability seam #4545 and #4541 fill; until they land, `pr-apply
 * --wave-gate` keeps its own wave runner.
 */
export function componentWavesSpec(
  components: readonly Pick<DriverComponent, "name" | "dependsOn">[],
  wordsIn: CiProductWordsInput | CiProductWords,
  steps: ComponentWaveSteps,
  options: { gate?: string; branches?: string[] } = {},
): OpWavesSpec {
  const words = assertProductWords(wordsIn);
  const layers = layerWaves(components.map((c) => ({ name: c.name, dependsOn: c.dependsOn ?? [] })));
  const name = words.op ?? options.gate ?? words.prGate;
  const spec: OpWavesSpec = {
    name,
    op: name,
    gate: options.gate ?? words.prGate,
    planWave: steps.planWave,
    applyWave: steps.applyWave,
    ...(options.branches ? { branches: options.branches } : {}),
    waves: layers.map((layer, i) => ({ name: `wave-${i + 1}`, runs: layer.map((target) => ({ target })) })),
  };
  return productWavesSpec(spec, words);
}

/** A shell line with the product's bin in place of `chant`, for a product's own jobs beside these. */
export function productCommand(words: CiProductWords, line: string): string {
  return withProductBin(line, words.bin);
}
