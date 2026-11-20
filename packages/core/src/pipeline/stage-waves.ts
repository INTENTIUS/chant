/**
 * A stage's op waves, run by `chant components promote` (#5427).
 *
 * A member whose stages apply through a `step` and that declares no
 * components (a yodel project's `sql-migrate`) has nothing for the
 * component driver to deploy. Its promote runs the stage's op waves
 * instead, once the stage's pause, rejections, soaks, agent steps and gate
 * let the release in, as `chant run wave` runs them in a wave job:
 *
 * - The spec is the stage's, `stageWavesSpec` of the pipeline folded at the
 *   default branch, written over the stage's rendered spec file
 *   (`pipelineStageSpecFile`, the file a wave job of `chant pipeline
 *   generate` writes with `pipeline spec --stage`). A step input named
 *   `spec` names that file ({@link stageRunSpec}), so an engine that reads
 *   chant's decision by its spec file (`sql-migrate`) reads this stage's.
 * - Each wave's gate, approval mode, holds and hooks are read at the
 *   default branch's commit from the same fold ({@link pipelineStageShow}),
 *   so the gate is the one the merged pipeline declares. A wave plans,
 *   decides its own gate on its plan digest and applies the plan it
 *   decided; one that waits stops the promote with exit 3, and the same
 *   promote carries on once it is approved.
 * - The waves run in order in the one job, and the first that does not end
 *   with exit 0 ends the promote with its exit code.
 * - The release records the step writes name the release promoted, with the
 *   step's plan digest, so later stages find the release applied here.
 *
 * The stand-down for a newer commit is off: a promote takes a release, not
 * the branch's tip.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, posix } from "node:path";
import { NEXT_RELEASE } from "../release-floors";
import type { OpWavesSpec } from "../op/op-waves";
import type { OpWaveShowAtBase, RunOpWaveOptions, RunOpWaveResult } from "../op/op-waves-run";
import type { ReleaseRecord } from "../lifecycle/release-ledger";
import { pipelineStageSpecFile } from "./generate";
import { gitShowPipeline, readPipelineAt, type PipelineShow } from "./read";
import { PIPELINE_FILE, type PipelineSpec } from "./spec";
import { pipelineStage, stageWavesSpec } from "./stages";

/**
 * The first chant whose `components promote` runs a stage's op waves for a
 * member that declares no components (#5427): the stage's spec written to
 * its rendered spec file with a step's `spec` input naming it, each wave's
 * gate read from the pipeline at the default branch, release records under
 * the release promoted, `pipelineStageShow` for an engine that reads a
 * stage's gate at base, a stage's records under the pipeline's component
 * when its targets name environments, and `idTokens` on a promote job
 * (`PipelinePromoteStageInputs`). A product feature-detects the promote of
 * its stages on this name.
 */
export const PROMOTE_STAGE_WAVES_FLOOR = NEXT_RELEASE;

/** Whether stage `stage` of the pipeline applies through a `step`, so a member with no components promotes into it by its op waves. */
export function stageRunsWaves(spec: PipelineSpec, stage: string): boolean {
  return pipelineStage(spec, stage) !== undefined && spec.defaults?.step !== undefined;
}

/**
 * The op-waves spec a promote runs for `stage`: `stageWavesSpec`, with a
 * step input `spec` set to the stage's rendered spec file, the file the
 * promote writes it to. A step without that input is left as it is.
 */
export function stageRunSpec(spec: PipelineSpec, stage: string): OpWavesSpec {
  const out = stageWavesSpec(spec, stage);
  if (!out.step || typeof out.step.spec !== "string") return out;
  return { ...out, step: { ...out.step, spec: pipelineStageSpecFile(spec, stage) } };
}

const STAGE_SPEC_FILE = /^\.chant\/op-waves\/[^/]+\.spec\.json$/;

const posixPath = (p: string): string => p.replace(/^\.\//, "").split("\\").join(posix.sep);

/** `git show <base>:<path>` in `cwd`, with the commit resolved; text null when the commit has no such file. */
const gitShowFile: OpWaveShowAtBase = (base, path, cwd) => {
  let sha: string;
  try {
    sha = execFileSync("git", ["rev-parse", "--verify", `${base}^{commit}`], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    throw new Error(`the gate policy is read at ${base}, which this checkout does not have. Check out the full history (fetch-depth: 0 on GitHub and Forgejo, GIT_DEPTH: "0" on GitLab).`);
  }
  try {
    return { sha, text: execFileSync("git", ["show", `${sha}:./${path}`], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch {
    return { sha, text: null };
  }
};

/**
 * An `OpWaveShowAtBase` that reads a stage's rendered spec file
 * (`.chant/op-waves/<pipeline>-<stage>.spec.json`) at a commit from the
 * pipeline folded there: {@link stageRunSpec} of the stage whose file it
 * is. A commit whose pipeline is absent, does not fold, or has no such stage
 * reads as a spec absent at base, so every wave's gate is `always`. Every
 * other file is read through `fallback`, which also resolves the commit.
 *
 * `readOpWavePolicy(specFile, wave, base, cwd, pipelineStageShow())` is how
 * an engine that checks chant's decision again (`sql-migrate`) reads a
 * stage's gate at base.
 */
export function pipelineStageShow(fallback: OpWaveShowAtBase = gitShowFile, show: PipelineShow = gitShowPipeline): OpWaveShowAtBase {
  return (base, path, cwd) => {
    const file = posixPath(path);
    if (!STAGE_SPEC_FILE.test(file)) return fallback(base, path, cwd);
    const { sha } = fallback(base, PIPELINE_FILE, cwd);
    const read = readPipelineAt(sha, cwd, show);
    if (read.status !== "folded") return { sha, text: null };
    const stage = read.spec.stages.find((s) => pipelineStageSpecFile(read.spec, s.name) === file);
    return { sha, text: stage ? `${JSON.stringify(stageRunSpec(read.spec, stage.name), null, 2)}\n` : null };
  };
}

/**
 * What stage `stage` applied of a release (#5427), for a soak's clock: the
 * newest record of each component on its ledger that names the release, or
 * that was applied at the commit the release was cut from (the first
 * stage's apply, recorded before the cut).
 */
export function stageReleaseItems(records: readonly ReleaseRecord[], stage: string, release: { releaseDigest: string; commit: string }): Array<{ component: string; digest: string; source: ReleaseRecord }> {
  const newest = new Map<string, ReleaseRecord>();
  for (const r of records) {
    if (r.env !== stage || (r.releaseDigest !== release.releaseDigest && r.gitSha !== release.commit)) continue;
    const prior = newest.get(r.component);
    if (!prior || Date.parse(r.timestamp) >= Date.parse(prior.timestamp)) newest.set(r.component, r);
  }
  return [...newest.values()].sort((a, b) => a.component.localeCompare(b.component)).map((source) => ({ component: source.component, digest: source.digest, source }));
}

/** One wave a promote ran (#5427). */
export interface StageWaveRan {
  wave: number;
  name: string;
  result: RunOpWaveResult;
}

/** What {@link runStageWaves} did: the spec file it wrote, each wave it ran, and the exit code of the first that did not end with 0, else 0. */
export interface StageWavesRun {
  specFile: string;
  spec: OpWavesSpec;
  waves: StageWaveRan[];
  exitCode: number;
}

/**
 * Run stage `stage`'s op waves for a release (#5427), in order, through
 * `run` (`runOpWave`), as a wave job of the stage would. `spec` is the
 * pipeline folded at `base`, the default branch's commit. Call it only once
 * the stage's gate passed. `options` are the runner's seams (the gate
 * ledger, the capabilities, the release port); `afterWave` is told how each
 * wave ended, as `chant run wave` tells the spec's notify.
 */
export async function runStageWaves(input: {
  spec: PipelineSpec;
  stage: string;
  base: string;
  cwd: string;
  release: { releaseDigest: string };
  options?: Omit<Partial<RunOpWaveOptions>, "spec" | "specFile" | "wave" | "base" | "cwd">;
  run?: (options: RunOpWaveOptions) => Promise<RunOpWaveResult>;
  afterWave?: (ran: StageWaveRan, spec: OpWavesSpec) => Promise<void>;
}): Promise<StageWavesRun> {
  const spec = stageRunSpec(input.spec, input.stage);
  const specFile = pipelineStageSpecFile(input.spec, input.stage);
  const path = isAbsolute(specFile) ? specFile : join(input.cwd, specFile);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(spec, null, 2)}\n`);
  const run = input.run ?? (await import("../op/op-waves-run")).runOpWave;
  const own = input.options ?? {};
  const releases = own.releases ?? (await import("../op/op-waves-release-port")).gitOpWaveReleasePort({ cwd: input.cwd, release: input.release });
  const waves: StageWaveRan[] = [];
  for (const [i, wave] of spec.waves.entries()) {
    const result = await run({
      ...own,
      spec,
      specFile,
      wave: i + 1,
      base: input.base,
      cwd: input.cwd,
      show: own.show ?? pipelineStageShow(),
      standDown: false,
      releases,
    });
    const ran = { wave: i + 1, name: wave.name, result };
    waves.push(ran);
    await input.afterWave?.(ran, spec);
    if (result.exitCode !== 0) return { specFile, spec, waves, exitCode: result.exitCode };
  }
  return { specFile, spec, waves, exitCode: 0 };
}
