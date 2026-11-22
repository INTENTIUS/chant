/**
 * A component run into a pipeline stage (#5475).
 *
 * `chant run --components <selector> --env <env>` in a member whose
 * `.chant/pipeline.ts` names a stage `<env>` waits at that stage's gate, as
 * `chant components promote --to <env>` does: gate `<env>` under the
 * pipeline's op, read with {@link pipelinePromoteGates}, so its approval
 * mode, quorum, rejections and the release's risk count the same way. One
 * approval of that gate serves a promote and a run alike.
 *
 * - The pipeline is read where a promote reads it, at the default branch's
 *   tip (`./read.ts`'s `promoteBase`), so a change that drops its stage's
 *   gate is still judged by the gate at base.
 * - The gate binds the release's digest for a run under `--release`, the
 *   digest a promote of that release binds. A run without a release binds
 *   {@link runStageDigest}: each component's plan digest, in the shape
 *   `promotedDigest` takes.
 * - An environment the pipeline has no stage for, a stage whose gate is
 *   `never`, and a member with no pipeline at base run as before.
 *
 * A promote passes the stage's gate itself and deploys through its own
 * driver, so it never reaches this and waits once.
 */

import { componentDeployInputs } from "../components/deploy-inputs";
import type { DriverComponent } from "../components/driver";
import { componentPlanDigest } from "../components/gate-plan";
import type { GateSigners } from "../lifecycle/gate-seal";
import type { ReleaseRisk } from "../lifecycle/release-risk";
import type { GateLedgerPort } from "../op/gate";
import { pipelinePromoteGates, promotedDigest, type PipelineGateProof, type PipelinePromoteStop } from "./promote";
import { promoteBase, readPipelineAt, type PipelineRead } from "./read";
import type { PipelineSpec } from "./spec";

/** The pipeline a component run into `env` is judged by: its spec when it has a stage `env` whose gate can wait, else nothing; a stop when the pipeline at base does not fold. */
export type RunStage = { status: "none" } | { status: "gated"; spec: PipelineSpec; base: string } | { status: "refused"; stop: PipelinePromoteStop };

/** Which pipeline stage gates a component run into `env`, from the pipeline as `read` at `base`. */
export function runStageOf(read: PipelineRead, base: string, env: string): RunStage {
  if (read.status === "refused") {
    return { status: "refused", stop: { exitCode: 1, message: `the pipeline at ${base.slice(0, 12)} does not fold, so the gate of stage "${env}" cannot be read and nothing ran: ${read.line}` } };
  }
  if (read.status !== "folded") return { status: "none" };
  const stage = read.spec.stages.find((s) => s.name === env);
  // A stage whose gate is `never` still waits when the release's risk is over its threshold, which pipelinePromoteGates reads.
  return stage ? { status: "gated", spec: read.spec, base } : { status: "none" };
}

/** {@link runStageOf} for the member at `cwd`, its pipeline read at the default branch's tip. No commit to read at: no stage. */
export function runStageAtBase(cwd: string, env: string): RunStage {
  const base = promoteBase(cwd);
  if (!base) return { status: "none" };
  return runStageOf(readPipelineAt(base, cwd), base, env);
}

/** What proves an approver or a rejecter at a stage's gate: the signers and roles at `base`, as a promote reads them. */
export async function pipelineGateProofAt(cwd: string, base: string | undefined): Promise<PipelineGateProof | undefined> {
  try {
    const { scopeSource } = await import("../workspace/write-scope");
    const { policy } = scopeSource(cwd, base);
    return { signers: policy as GateSigners, roles: policy.roles };
  } catch {
    return undefined;
  }
}

/**
 * The digest a stage's gate binds for a component run without a release:
 * each component's plan digest in `env` (its steps, the files they deploy
 * from under `root`, and the addresses it narrows to), in the shape
 * {@link promotedDigest} takes. The same checkout and flags give the same
 * digest, so the run after the approval finds it.
 */
export function runStageDigest(components: readonly DriverComponent[], env: string, root: string, targets?: Readonly<Record<string, readonly string[]>>): string {
  return promotedDigest(
    components.map((component) => ({
      component: component.name,
      digest: componentPlanDigest({
        environment: env,
        component,
        inputs: componentDeployInputs(component.deploy, root).inputs,
        ...(targets?.[component.name] ? { targets: targets[component.name] } : {}),
      }),
    })),
  );
}

/** How {@link componentRunStageGate} ended: the run goes on, with the lines to print, or it stops. */
export type RunStageGateOutcome = { passed: true; lines: string[] } | { passed: false; lines: string[]; stop: PipelinePromoteStop };

/**
 * The stage's gate for a component run into stage `env` of `spec`: the
 * pipeline's gate `<env>`, bound to `digest` (the release's, under a
 * release), read as a promote into `env` reads it with no stage skipped.
 * A wait records its pending fact and stops with exit 3 and the approve line.
 */
export async function componentRunStageGate(input: {
  spec: PipelineSpec;
  env: string;
  digest: string;
  releaseDigest?: string;
  risk?: ReleaseRisk;
  port: GateLedgerPort;
  proof?: PipelineGateProof;
  gitSha?: string;
  now: Date;
}): Promise<RunStageGateOutcome> {
  const got = await pipelinePromoteGates({
    spec: input.spec,
    to: input.env,
    skipped: [],
    digest: input.digest,
    port: input.port,
    now: input.now,
    ...(input.releaseDigest !== undefined ? { releaseDigest: input.releaseDigest } : {}),
    ...(input.risk ? { risk: input.risk } : {}),
    ...(input.proof ? { proof: input.proof } : {}),
    ...(input.gitSha ? { gitSha: input.gitSha } : {}),
  });
  if (got.passed) return { passed: true, lines: got.lines };
  const { passed: _passed, lines, ...stop } = got;
  return { passed: false, lines: lines ?? [], stop };
}
