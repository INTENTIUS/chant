/**
 * A promote under a release that plans again once an upstream applied, and a
 * gate per wave (#4168 step 4). Merging deploys nothing since step 1, so what
 * `pr-apply` did on merge happens here, at promote:
 *
 * - **Rounds** (#3999's rule, `../pr-loop.ts`). The release gate approves a
 *   change set in which each dependent was planned against its upstream's
 *   planned outputs (`planReleaseSet` in ./release-gate.ts). The promote runs
 *   a wave at a time. Before a wave runs, a component whose plan read an
 *   upstream output that the run left as another value
 *   (`movedWiringReferences`) is planned again against what stands. When the
 *   approved change set covers the new plan (`waveNotCovered`, the test a
 *   pull request's resume uses), it applies under the approval it has.
 *   Otherwise its gates are decided as `<gate>-round-<n>` (`prRoundGate`),
 *   bound to the new plan's digest.
 * - **A gate per wave** (`--wave-gate <gate>`, #4157's rule). Every wave
 *   after the first is planned again against what the waves before it left,
 *   and a wave the approved change set does not cover waits at
 *   `<gate>-wave-<k>` (`waveGateName`), one gate for the whole wave, bound to
 *   that wave's digest.
 *
 * A stage whose components declare no gate has nowhere to wait, so the
 * promote stops there with nothing more deployed.
 *
 * A promote that stops at a round's or a wave's gate writes a resume record
 * ({@link PromoteResume}): the components that applied and the outputs they
 * left. The same promote run again with it skips what applied and carries on
 * from the wave it stopped at, so an approval of the round or wave it waits on
 * is decided against the same plan.
 */

import { movedWiringReferences, type DriverComponent, type DriverGate, type DriverPhase, type DriverRunResult, type DriverStep, type ReleaseGateBinding } from "./driver";
import { resolveComponentGraph } from "./driver";
import { waveNotCovered } from "./pr-run";
import { prRoundGate } from "../pr-loop";
import { waveGateName } from "../gated-waves";
import { capabilitySteps } from "./wave-plan";
import type { ChangeSetDocument } from "../change-set";
import type { ReleasePlan } from "./release-gate";

export const PROMOTE_RESUME_SCHEMA = "chant-promote-resume/v1";

/** What a promote that stopped at a round's or a wave's gate leaves for the next attempt. */
export interface PromoteResume {
  schema: typeof PROMOTE_RESUME_SCHEMA;
  env: string;
  releaseDigest: string;
  /** The change set the release gate approved before anything applied. */
  approvedDigest: string;
  /** Components that applied, in run order. */
  completed: string[];
  /** The outputs standing after them. */
  outputs: Record<string, Record<string, unknown>>;
  /** ISO 8601. */
  at: string;
}

/** One round or wave that needed its own approval. */
export interface PromoteStage {
  kind: "round" | "wave";
  /** The round number (2 and up) or the wave number (1-based). */
  number: number;
  components: string[];
  /** The plan the stage's gates bind. */
  digest: string;
  /** Why the approved change set did not cover it, one line per member. */
  notCovered: string[];
  status: "applied" | "waiting" | "failed";
  /** With `failed` before anything ran: why. */
  message?: string;
}

export interface PromoteRoundsOptions {
  /** The promoted compositions, in no particular order. */
  components: DriverComponent[];
  /** Outputs standing before the run: the seeds, and on a resume the record's. */
  outputs: Record<string, Record<string, unknown>>;
  /** The release gate the change set was approved under. */
  binding: ReleaseGateBinding;
  /** The approved change set, and what each component's plan read. */
  approved: ChangeSetDocument;
  reads: ReleasePlan["reads"];
  /** Components an earlier attempt applied. Skipped. */
  completed?: readonly string[];
  /** `--wave-gate <gate>`: check every wave after the first, not only the components whose inputs moved, and name a wave's gate `<gate>-wave-<k>`. */
  waveGate?: string;
  /** Run one subset of the components with `outputs` standing (`runPromotion` with the binding). */
  run: (components: DriverComponent[], outputs: Record<string, Record<string, unknown>>, binding: ReleaseGateBinding) => Promise<DriverRunResult>;
  /** Plan `only` again with `outputs` standing (`planReleaseSet`). */
  replan: (only: ReadonlySet<string>, outputs: Record<string, Record<string, unknown>>) => Promise<ChangeSetDocument>;
  /** Store a stage's plan and bind its gates (empty resolutions included). */
  bind: (doc: ChangeSetDocument, gates: string[]) => Promise<ReleaseGateBinding>;
}

export interface PromoteRoundsResult {
  run: DriverRunResult;
  /** The rounds and waves that needed their own approval. */
  stages: PromoteStage[];
  /** Every component that applied, earlier attempts included, in run order. */
  completed: string[];
  outputs: Record<string, Record<string, unknown>>;
}

function isGate(step: DriverStep | DriverGate | DriverPhase): step is DriverGate {
  return (step as { kind?: unknown }).kind === "gate";
}

function isPhase(step: DriverStep | DriverGate | DriverPhase): step is DriverPhase {
  return typeof (step as { phase?: unknown }).phase === "string" && Array.isArray((step as DriverPhase).steps);
}

/** `component` with each gate renamed by `rename`, nested phases included. */
export function renameGates(component: DriverComponent, rename: (gate: string) => string): DriverComponent {
  const walk = (phase: DriverPhase): DriverPhase => ({
    ...phase,
    steps: phase.steps.map((step) => {
      if (isPhase(step)) return walk(step);
      if (!isGate(step)) return step;
      const { signalName: _old, ...rest } = step;
      return { ...rest, gate: rename(step.gate ?? step.signalName ?? "") };
    }),
  });
  return { ...component, deploy: component.deploy.map(walk) };
}

/** The gate names `components` declare, sorted and distinct. */
function gatesOf(components: readonly DriverComponent[]): string[] {
  const names = new Set<string>();
  const walk = (steps: DriverPhase["steps"]): void => {
    for (const step of steps) {
      if (isPhase(step)) walk(step.steps);
      else if (isGate(step)) names.add(step.gate ?? step.signalName ?? "");
    }
  };
  for (const c of components) for (const phase of c.deploy) walk(phase.steps);
  return [...names].sort();
}

/** The references `component`'s steps make that resolve to another value now than when its plan read them. */
export function movedInputs(component: DriverComponent, read: Record<string, Record<string, unknown>> | undefined, now: Record<string, Record<string, unknown>>): string[] {
  if (!read) return [];
  const moved = new Set<string>();
  for (const step of capabilitySteps(component.deploy)) {
    const { kind: _kind, ...rest } = step;
    for (const r of movedWiringReferences(rest, read, now)) if (!r.publish) moved.add(r.ref);
  }
  return [...moved].sort();
}

function joinRuns(runs: DriverRunResult[], outputs: Record<string, Record<string, unknown>>): DriverRunResult {
  const last = runs[runs.length - 1];
  const base: DriverRunResult = {
    order: runs.flatMap((r) => r.order),
    waves: runs.flatMap((r) => r.waves),
    results: runs.flatMap((r) => r.results),
    ok: runs.every((r) => r.ok),
    status: "ok",
    componentOutputs: outputs,
  };
  if (!last || last.status === "ok") return base;
  const { order: _o, waves: _w, results: _r, ok: _ok, componentOutputs: _c, ...stop } = last;
  return { ...base, ...stop, ok: false };
}

/**
 * Run the promote a wave at a time, planning again where an upstream applied
 * as another value, and with `waveGate`, checking each wave. Stops at the
 * first wave that fails or waits on a gate.
 */
export async function runPromotionInRounds(options: PromoteRoundsOptions): Promise<PromoteRoundsResult> {
  const byName = new Map(options.components.map((c) => [c.name, c]));
  const { waves } = resolveComponentGraph(options.components.map((c) => ({ ...c, dependsOn: (c.dependsOn ?? []).filter((d) => byName.has(d)) })));
  const completed = [...(options.completed ?? [])];
  const done = new Set(completed);
  let outputs = { ...options.outputs };
  const runs: DriverRunResult[] = [];
  const stages: PromoteStage[] = [];
  let round = 1;

  for (const [index, wave] of waves.entries()) {
    const waveNumber = index + 1;
    const pending = wave.filter((name) => !done.has(name));
    if (pending.length === 0) continue;
    const check = options.waveGate !== undefined && waveNumber > 1
      ? pending
      : pending.filter((name) => movedInputs(byName.get(name)!, options.reads[name], outputs).length > 0);
    const batches: Array<{ names: string[]; binding: ReleaseGateBinding; stage?: PromoteStage; rename?: (g: string) => string }> = [];
    const rest = pending.filter((name) => !check.includes(name));
    if (check.length > 0) {
      const fresh = await options.replan(new Set(check), outputs);
      const notCovered = waveNotCovered(options.approved, fresh);
      if (notCovered.length === 0) {
        rest.push(...check);
      } else {
        const kind: PromoteStage["kind"] = options.waveGate !== undefined ? "wave" : "round";
        if (kind === "round") round += 1;
        const number = kind === "wave" ? waveNumber : round;
        const base = options.waveGate;
        const rename = (g: string) => (base !== undefined ? waveGateName(base, number) : prRoundGate(g, number));
        const renamed = check.map((name) => renameGates(byName.get(name)!, rename));
        const gates = gatesOf(renamed);
        const stage: PromoteStage = { kind, number, components: check, digest: fresh.digest, notCovered, status: "waiting" };
        stages.push(stage);
        if (gates.length === 0) {
          stage.status = "failed";
          stage.message = `${check.join(", ")} planned again past the approved change set and declare${check.length === 1 ? "s" : ""} no gate to approve the new plan on`;
          const stop: DriverRunResult = { order: [], waves: [], results: [], ok: false, status: "fail", failedComponent: check[0], componentOutputs: outputs };
          return { run: joinRuns([...runs, stop], outputs), stages, completed, outputs };
        }
        const binding = await options.bind(fresh, gates);
        batches.push({ names: check, binding, stage, rename });
      }
    }
    if (rest.length > 0) batches.unshift({ names: pending.filter((n) => rest.includes(n)), binding: options.binding });

    for (const batch of batches) {
      const components = batch.names.map((name) => (batch.rename ? renameGates(byName.get(name)!, batch.rename) : byName.get(name)!));
      const run = await options.run(components, outputs, batch.binding);
      runs.push(run);
      outputs = { ...outputs, ...run.componentOutputs };
      for (const r of run.results) {
        if (r.status === "ok" && !done.has(r.component)) {
          done.add(r.component);
          completed.push(r.component);
        }
      }
      if (batch.stage) batch.stage.status = run.status === "ok" ? "applied" : run.status === "gated" ? "waiting" : "failed";
      if (run.status !== "ok") return { run: joinRuns(runs, outputs), stages, completed, outputs };
    }
  }
  return { run: joinRuns(runs, outputs), stages, completed, outputs };
}
