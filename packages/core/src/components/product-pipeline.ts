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
import { opWaveBinArgv, opWaveJobs, type OpWave, type OpWaveJob, type OpWavesSpec } from "../op/op-waves";
import {
  assertProductWords,
  CHANT_WORDS,
  commentLine,
  type CiProductApplyMode,
  type CiProductCommand,
  type CiProductWords,
  type CiProductWordsInput,
} from "../ci-product-words";
import { prCommentLockJobs, prLoopJobs, prLoopPostJob, withProductBin, type PrCommentLockJob, type PrLoopJob, type PrLoopPipelineOptions } from "./pr-pipeline";
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
  /**
   * The apply on merge from the component graph (#4588), when `waves` is
   * absent: the spec `pr-apply --wave-gate` runs, a wave per layer of
   * `components`, each run a component planned and applied through the
   * component plan-wave and apply-wave steps, a wave whose plan the approval
   * does not cover waiting at `<waveGate>-wave-<k>`. `base` is what the
   * steps measure the change from, by default `HEAD^1`, the commit before
   * the merge.
   */
  componentWaves?: { components: readonly Pick<DriverComponent, "name" | "dependsOn">[]; waveGate?: string; base?: string };
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
  /**
   * The comment lock and unlock jobs (#4588), under `locks: "plan"`:
   * `/<product> lock` keeps the locks the plan took, `/<product> unlock`
   * releases them. The forge lexicons render the same jobs.
   */
  locks?: PrCommentLockJob[];
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

/**
 * The product pipeline's jobs for `forge` (#4550): the plan side from the
 * pull request loop with the words, and the apply on merge on op waves. The
 * words are refused when a command names a job the pipeline does not have.
 */
export function productPipelineJobs(forge: ForgeKind, env: string, options: ProductPipelineOptions): ProductPipelineJobs {
  const jobs: CiProductCommand[] = ["plan"];
  if (options.applyBeforeMerge || options.waves || options.componentWaves) jobs.push("apply");
  if (options.locks === "plan") jobs.push("lock", "unlock");
  if (options.agent) jobs.push("agent");
  // #4601: the note's merge sentence follows the jobs built here: waves on merge, an apply before merge, else a record for a release.
  // Words that ask for before-merge keep it when the pipeline has that job beside its waves.
  const built: CiProductApplyMode = options.waves || options.componentWaves ? "on-merge" : options.applyBeforeMerge ? "before-merge" : "release";
  const applyMode: CiProductApplyMode = options.words.applyMode === "before-merge" && options.applyBeforeMerge ? "before-merge" : built;
  const words = assertProductWords({ ...options.words, applyMode }, { jobs });
  const { waves: given, wavesSpecFile, member, agent: _agent, componentWaves, ...loop } = options;
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
  const locks = prCommentLockJobs(forge, { locks: options.locks, words });
  if (locks.length > 0) out.locks = locks;
  // #4588: without a spec of the product's own, the component graph's waves on op waves.
  const op = words.op ?? componentWaves?.waveGate ?? words.prGate;
  const spec = given ?? (componentWaves
    ? componentWavesSpec(componentWaves.components, words, componentWaveSteps({ ...(words.bin ? { bin: words.bin } : {}), env, base: componentWaves.base ?? "HEAD^1", ...(member ? { member } : {}), op, gate: prLoop.gate }), { ...(componentWaves.waveGate ? { gate: componentWaves.waveGate } : {}) })
    : undefined);
  if (!spec) return { ...out, record: record! };
  const named = productWavesSpec(spec, words);
  const specFile = wavesSpecFile ?? productWavesSpecFile(named.name);
  return { ...out, waves: { spec: named, specFile, jobs: opWaveJobs(named, specFile, { bin: words.bin }) } };
}

/** The capability steps a component waves spec runs (#4545, #4541): argv templates over `{runs}` and `{plans}`. */
export interface ComponentWaveSteps {
  /** Plan every run of a wave through the capability registry, writing `{plans}`. */
  planWave: string[];
  /** Apply a wave's approved set through the capability registry. */
  applyWave: string[];
}

/** Where a component waves spec keeps the outputs each wave's components left, for the next wave's plans (#4588). */
export function componentWaveOutputsFile(op: string): string {
  return `${PRODUCT_WAVES_SPEC_DIR}/${op}/outputs.json`;
}

/** What {@link componentWaveSteps} names on each step's line (#4588). */
export interface ComponentWaveStepOptions {
  /** The command in place of `chant`, a product's `words.bin`. */
  bin?: string;
  env: string;
  /** The commit the change is measured from: what `pr-apply` was given. */
  base: string;
  /** The commit applied. Absent: the job's checkout. */
  head?: string;
  /** The workspace member. */
  member?: string;
  /** The file the waves hand outputs on in. Default {@link componentWaveOutputsFile} of `op`. */
  outputs?: string;
  /** The op the outputs file is named by. */
  op: string;
  /** The pull request's gate, whose rows file the apply leases on the resource grain. */
  gate?: string;
}

/**
 * The component plan-wave and apply-wave steps (#4588): `chant components
 * plan-wave` plans a wave's components through the project's capabilities
 * and writes the op-waves plans file with the wave's change set, and
 * `chant components apply-wave` plans the approved runs again, refuses any
 * whose plan moved (exit 4), and applies the rest. Both read the outputs
 * the waves before them left from the outputs file, and apply-wave adds its
 * own.
 */
export function componentWaveSteps(options: ComponentWaveStepOptions): ComponentWaveSteps {
  const bin = opWaveBinArgv(options.bin);
  const common = [
    "--env", options.env, "--base", options.base,
    ...(options.head ? ["--head", options.head] : []),
    ...(options.member ? ["--member", options.member] : []),
    ...(options.gate ? ["--gate", options.gate] : []),
    "--wave-outputs", options.outputs ?? componentWaveOutputsFile(options.op),
  ];
  return {
    planWave: [...bin, "components", "plan-wave", "--runs", "{runs}", "--plans", "{plans}", ...common],
    applyWave: [...bin, "components", "apply-wave", "--runs", "{runs}", "--plans", "{plans}", ...common],
  };
}

/** What {@link componentWavesSpec} takes beside the graph, the words and the steps. */
export interface ComponentWavesSpecOptions {
  /** The wave gate's base name: wave k waits at `<gate>-wave-<k>` (or the words' `gateName`). Default the words' `prGate`. */
  gate?: string;
  branches?: string[];
  /**
   * The op the gates are recorded under. `pr-apply --wave-gate` passes the
   * pull request's (`pr-<n>`), and then every wave takes the pull request's
   * approval whatever the words' preset. Default the words' `op`.
   */
  op?: string;
  /** The pull request's gate, whose approval a wave applies under when it covers the wave. Default the words' `prGate`. */
  prGate?: string;
  /** The layers, when the caller already has them (a derivation's `waves`). Default: layered from `dependsOn`. */
  waves?: readonly (readonly string[])[];
}

/**
 * A waves spec from the component graph (#4550, ruling A; #4588): a wave per
 * layer of the graph, each run a component, planned and applied through the
 * component plan-wave and apply-wave steps under the words' op and gate
 * names. `pr-apply --wave-gate` runs its waves on it.
 */
export function componentWavesSpec(
  components: readonly Pick<DriverComponent, "name" | "dependsOn">[],
  wordsIn: CiProductWordsInput | CiProductWords,
  steps: ComponentWaveSteps,
  options: ComponentWavesSpecOptions = {},
): OpWavesSpec {
  const words = assertProductWords(wordsIn);
  const layers = options.waves ?? layerWaves(components.map((c) => ({ name: c.name, dependsOn: c.dependsOn ?? [] })));
  const name = options.op ?? words.op ?? options.gate ?? words.prGate;
  const spec: OpWavesSpec = {
    name,
    op: name,
    gate: options.gate ?? words.prGate,
    planWave: steps.planWave,
    applyWave: steps.applyWave,
    ...(options.branches ? { branches: options.branches } : {}),
    waves: layers.map((layer, i) => ({ name: `wave-${i + 1}`, runs: layer.map((target) => ({ target })) })),
  };
  const named = productWavesSpec(spec, words);
  if (options.op === undefined) return named;
  // The pull request's own op: every wave applies under its approval when that covers the wave's plan, else at its own gate.
  return {
    ...named,
    name: options.op,
    op: options.op,
    waves: named.waves.map((w) => ({ ...w, approval: "pull-request" as const })),
    approvals: { ...(named.approvals ?? {}), pullRequest: { gate: options.prGate ?? words.prGate } },
  };
}

/** A shell line with the product's bin in place of `chant`, for a product's own jobs beside these. */
export function productCommand(words: CiProductWords, line: string): string {
  return withProductBin(line, words.bin);
}
