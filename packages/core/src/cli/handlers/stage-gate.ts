/**
 * The gate of the pipeline stage a component deploy into `env` goes through
 * (#5475), for every command that applies components into an environment
 * outside a promote: `chant run --components`, `chant components redeploy`,
 * `chant components rollback` (but `--requested`, which passed the stage's
 * rollback gate) and `chant components fan-out` without `--gate` or
 * `--wave-gate`. Each waits on the same fact, `<env>` under the pipeline's
 * op, bound the same way and printed with the same approve line.
 */

import type { DriverComponent } from "../../components/driver";
import { formatError, formatInfo } from "../format";

/** A stop's exit code, or undefined when the gate let the deploy through. */
export type StageGateCheck = (digest: string) => Promise<number | undefined>;

/**
 * The gate of the pipeline stage a component deploy into `env` goes
 * through: undefined when no stage at base gates `env`. Under a release it
 * is read here, bound to the release's digest, and gives an exit code when
 * it stops the deploy, else undefined. Without one it gives the reader the
 * caller calls with the digest of the components it applies
 * ({@link stageGateDigest}), which gives the exit code when the gate stops
 * the deploy. A stop is printed with its approve line.
 */
export async function runStageGate(projectPath: string, env: string, releaseDigest: string | undefined): Promise<number | undefined | StageGateCheck> {
  const { runStageAtBase, componentRunStageGate, pipelineGateProofAt } = await import("../../pipeline/run-gate");
  const stage = runStageAtBase(projectPath, env);
  if (stage.status === "none") return undefined;
  if (stage.status === "refused") {
    console.error(formatError({ message: stage.stop.message }));
    return stage.stop.exitCode;
  }
  const { gitGateLedgerPort } = await import("../../op/gate");
  const { getHeadCommit } = await import("../../lifecycle/git");
  const head = await getHeadCommit({ cwd: projectPath }).catch(() => undefined);
  const proof = await pipelineGateProofAt(projectPath, stage.base);
  // #5387: the change risk a cut of the release bound, which a stage gate with holds.risk reads, as a promote reads it.
  let risk: import("../../lifecycle/release-risk").ReleaseRisk | undefined;
  if (releaseDigest !== undefined) {
    const { readCuts } = await import("../../lifecycle/release-store");
    const cuts = await readCuts().then((r) => r.cuts, () => []);
    risk = cuts.find((c) => c.releaseDigest === releaseDigest && c.risk)?.risk;
  }
  const check: StageGateCheck = async (digest) => {
    const got = await componentRunStageGate({
      spec: stage.spec,
      env,
      digest,
      ...(releaseDigest !== undefined ? { releaseDigest } : {}),
      ...(risk ? { risk } : {}),
      port: gitGateLedgerPort(),
      ...(proof ? { proof } : {}),
      ...(head ? { gitSha: head } : {}),
      now: new Date(),
    });
    for (const line of got.lines) console.error(formatInfo(line));
    if (got.passed) return undefined;
    const { stop } = got;
    const hint = stop.hint ? (stop.code === "pipeline-gate-waiting" ? `Approve it with: ${stop.hint}` : stop.hint) : undefined;
    console.error(formatError({ message: `${stop.message}${stop.code ? ` [${stop.code}]` : ""}`, ...(hint ? { hint } : {}) }));
    return stop.exitCode;
  };
  return releaseDigest !== undefined ? check(releaseDigest) : check;
}

/**
 * {@link runStageGate} read to its end for a deploy of `components`: the
 * stop's exit code, or undefined when the deploy goes on. Without a release
 * the gate binds {@link runStageDigest} of the components, as a run binds it.
 */
export async function awaitStageGate(input: {
  projectPath: string;
  env: string;
  releaseDigest?: string;
  components: readonly DriverComponent[];
  targets?: Readonly<Record<string, readonly string[]>>;
}): Promise<number | undefined> {
  const gate = await runStageGate(input.projectPath, input.env, input.releaseDigest);
  if (gate === undefined || typeof gate === "number") return gate;
  const { runStageDigest } = await import("../../pipeline/run-gate");
  return gate(runStageDigest(input.components, input.env, input.projectPath, input.targets));
}
