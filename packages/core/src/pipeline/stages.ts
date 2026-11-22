/**
 * What each stage of a folded pipeline becomes (#5324).
 *
 * A stage is an op-waves spec: the pipeline's shared settings, the stage's
 * waves, its gate on every wave, its hooks after the pipeline's, `labels.Env`
 * naming the stage so run and release records go on its environment's
 * ledger. `chant run wave` runs it, and the gate is read from the folded
 * pipeline at the base commit like any op-waves spec's.
 *
 * The merge path: a merge applies the first stage, as products do now, and
 * once its last wave applied cuts a release from the applied commit (an
 * after-apply hook on that wave, read at base with the others). The control
 * repo dispatch (`<product>-applied`) goes after the first stage. Each later
 * stage takes that release through `chant components promote --to <stage>
 * --release <label>` behind its gate. A member with no components takes it
 * by the stage's op waves, which the promote runs once that gate passed
 * (#5427, `./stage-waves.ts`).
 *
 * The stage order is the promotion order: `promotionOrderOf` gives it in the
 * shape `environments` in `chant.config.ts` gives it, so `components
 * promote`, `release cut`, `workspace status` and `workspace train promote`
 * read the same order from either.
 */

import { assertOpWavesSpec, type OpWave, type OpWaveHook, type OpWaveHooks, type OpWavesSpec } from "../op/op-waves";
import type { PromotionStep } from "../workspace/promotion-order";
import type { PipelineFreezeWindow, PipelineSpec, PipelineStage } from "./spec";

/** The op-waves spec name a stage runs under: `<pipeline>-<stage>`, so each stage's wave gates are its own. */
export function stageWavesName(spec: Pick<PipelineSpec, "name">, stage: string): string {
  return `${spec.name}-${stage}`;
}

/** The stage named `name`, or undefined. */
export function pipelineStage(spec: Pick<PipelineSpec, "stages">, name: string): PipelineStage | undefined {
  return spec.stages.find((s) => s.name === name);
}

/** The stages in promotion order, as `promotionOrder` reads `environments`. */
export function promotionOrderOf(spec: Pick<PipelineSpec, "stages">): PromotionStep[] {
  return spec.stages.map((s) => ({ name: s.name, canary: s.canary === true }));
}

/** The version a pipeline's `auto` cut takes when the member has no release yet (terragucci#1526). */
export const PIPELINE_FIRST_VERSION = "0.1.0";

/**
 * The hook a merge's first stage cuts its release with. It passes
 * `--wait-checks` (#5438): under `release.green: forge-checks` the cut waits
 * for the other push workflows still running on the merge commit, and the
 * other gates ignore it. An `auto` cut passes `--first <release.first>`
 * (default {@link PIPELINE_FIRST_VERSION}), as does another label when
 * `release.first` is set (a product's word for auto), so the merge of a member with no
 * release yet cuts its first one instead of failing after the apply
 * (terragucci#1526, sql-yodeler#406).
 */
export function releaseCutHook(spec: Pick<PipelineSpec, "release">): OpWaveHook | undefined {
  if (spec.release?.cut === false) return undefined;
  const bin = spec.release?.bin ?? ["chant"];
  const label = spec.release?.label ?? "auto";
  // A product's own word for auto takes --first when the product sets release.first.
  const first = spec.release?.first !== undefined ? ["--first", spec.release.first] : label === "auto" ? ["--first", PIPELINE_FIRST_VERSION] : [];
  return { name: "release-cut", command: [...bin, "release", "cut", label, ...first, "--yes", "--wait-checks"] };
}

/**
 * The hook a stage publishes its release artifacts with (#5356), run after
 * the release cut on the first stage's last wave: `chant pipeline artifacts
 * publish --stage <stage>`, through the cut's bin. Undefined when the stage
 * publishes nothing or the merge cuts no release.
 */
export function artifactsPublishHook(spec: Pick<PipelineSpec, "release" | "stages">, stage: string): OpWaveHook | undefined {
  if (spec.release?.cut === false) return undefined;
  const declared = spec.stages.find((s) => s.name === stage)?.publish;
  if (!declared || Object.keys(declared).length === 0) return undefined;
  const bin = spec.release?.bin ?? ["chant"];
  return { name: "artifacts-publish", command: [...bin, "pipeline", "artifacts", "publish", "--stage", stage] };
}

function joinHooks(first: OpWaveHooks | undefined, then: OpWaveHooks | undefined): OpWaveHooks | undefined {
  if (!first) return then;
  if (!then) return first;
  const both = <K extends "before" | "after">(k: K) => {
    const a = (first[k] ?? {}) as Record<string, OpWaveHook[]>;
    const b = (then[k] ?? {}) as Record<string, OpWaveHook[]>;
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    return keys.length === 0 ? undefined : Object.fromEntries(keys.map((m) => [m, [...(a[m] ?? []), ...(b[m] ?? [])]]));
  };
  const before = both("before");
  const after = both("after");
  const apply = then.apply ?? first.apply;
  return { ...(before ? { before } : {}), ...(after ? { after } : {}), ...(apply ? { apply } : {}) } as OpWaveHooks;
}

/**
 * The release names a stage's step records under (#5427), when the pipeline
 * fixes them: a stage with a `step` whose every run target is missing from
 * some other stage names an environment, not a component (a yodel project's
 * `dev` and `staging`), so its records take `release.component` of the
 * defaults, else the pipeline's name, and each stage's records name the same
 * component. Undefined when the defaults name a component or turn the
 * records off, when the stage has no step, or when a target is run by every
 * stage (a root or a stack, which names its own records).
 */
function stageReleaseNames(spec: PipelineSpec, stage: PipelineStage): OpWavesSpec["release"] | undefined {
  const own = spec.defaults?.release;
  if (!spec.defaults?.step || own === false || own?.component !== undefined) return undefined;
  const targets = stage.waves.flatMap((w) => (w.runs ?? []).map((r) => r.target));
  if (targets.length === 0 || spec.stages.length < 2) return undefined;
  const everywhere = (target: string) => spec.stages.every((s) => s.waves.some((w) => (w.runs ?? []).some((r) => r.target === target)));
  if (targets.some(everywhere)) return undefined;
  return { ...(own ?? {}), component: spec.name };
}

/**
 * The op-waves spec stage `name` runs: its waves under its gate. The first
 * stage also carries the release cut and the control dispatch, since it is
 * the stage a merge applies. A canary wave with no soak of its own takes
 * the stage's (#5327). A stage whose step's targets name environments
 * records its releases under the pipeline's component (#5427). Throws on a
 * stage the pipeline lacks, or a spec no job could run.
 */
export function stageWavesSpec(spec: PipelineSpec, name: string): OpWavesSpec {
  const index = spec.stages.findIndex((s) => s.name === name);
  if (index < 0) throw new Error(`the pipeline "${spec.name}" has no stage "${name}"; its stages are ${spec.stages.map((s) => s.name).join(", ")}`);
  const stage = spec.stages[index]!;
  const first = index === 0;
  const defaults = spec.defaults ?? {};
  const gate = stage.gate ?? {};
  const waves: OpWave[] = stage.waves.map((w, k) => {
    const tolerance = w.failureTolerance ?? stage.failureTolerance;
    const { failureTolerance: _own, ...rest } = w;
    const wave: OpWave = {
      ...rest,
      gate: w.gate ?? gate.policy ?? "always",
      ...(w.approval ?? gate.approval ? { approval: w.approval ?? gate.approval } : {}),
      ...(w.environment ?? stage.forgeEnvironment ? { environment: w.environment ?? stage.forgeEnvironment } : {}),
      ...(tolerance !== undefined && tolerance !== 0 ? { failureTolerance: tolerance } : {}),
      // #5327: a canary wave that declares no soak takes the stage's, so a product's waves.canary needs no key of its own.
      ...(w.canary && w.soak === undefined && stage.soak !== undefined ? { soak: structuredClone(stage.soak) } : {}),
    };
    const cut = first && k === stage.waves.length - 1 ? releaseCutHook(spec) : undefined;
    const publish = cut ? artifactsPublishHook(spec, stage.name) : undefined;
    if (cut) wave.hooks = joinHooks(wave.hooks, { after: { apply: publish ? [cut, publish] : [cut] } });
    return wave;
  });
  const approvals = gate.quorum !== undefined ? { ...defaults.approvals, quorum: gate.quorum } : defaults.approvals;
  const release = stageReleaseNames(spec, stage);
  const hooks = joinHooks(defaults.hooks, stage.hooks);
  const holds = gate.holds ?? defaults.holds;
  const point = gate.point ?? defaults.point;
  const out: OpWavesSpec = {
    ...(defaults as Omit<OpWavesSpec, "name" | "waves">),
    name: stageWavesName(spec, stage.name),
    op: defaults.op ?? spec.name,
    labels: { ...defaults.labels, Env: stage.name },
    ...(approvals ? { approvals } : {}),
    ...(release ? { release } : {}),
    ...(hooks ? { hooks } : {}),
    ...(holds ? { holds } : {}),
    ...(point ? { point } : {}),
    ...(first && spec.control ? { control: spec.control } : {}),
    ...(stage.replanDependents ? { replanDependents: [...stage.replanDependents] } : {}),
    waves,
  };
  assertOpWavesSpec(out);
  return out;
}

/** Why a stage refuses promotion now, and until when. */
export interface StageHeld {
  stage: string;
  kind: "hold" | "freeze";
  /** When it lifts by itself, or null when only a change to the pipeline lifts it. */
  until: string | null;
  reason?: string;
  /** What the person who lifts the hold reads first (#5354). */
  description?: string;
}

/** The hold or freeze window on `stage` at `now`, or undefined when promotion is open. A hold wins over a window. */
export function stageHeldAt(stage: Pick<PipelineStage, "name" | "hold" | "freeze">, now: Date): StageHeld | undefined {
  const hold = stage.hold;
  if (hold === true) return { stage: stage.name, kind: "hold", until: null };
  if (hold !== undefined && (hold.until === undefined || Date.parse(hold.until) > now.getTime())) {
    return { stage: stage.name, kind: "hold", until: hold.until ?? null, ...(hold.reason ? { reason: hold.reason } : {}), ...(hold.description ? { description: hold.description } : {}) };
  }
  const windows = (stage.freeze ?? []).filter((w: PipelineFreezeWindow) => Date.parse(w.from) <= now.getTime() && now.getTime() < Date.parse(w.until));
  if (windows.length === 0) return undefined;
  // Overlapping windows: the one that ends last says until when.
  const last = windows.reduce((a, b) => (Date.parse(b.until) > Date.parse(a.until) ? b : a));
  return { stage: stage.name, kind: "freeze", until: last.until, ...(last.reason ? { reason: last.reason } : {}) };
}

/** The line a held stage's refusal prints: what holds it, and until when. */
export function stageHeldLine(held: StageHeld): string {
  const what = held.kind === "hold" ? `stage "${held.stage}" is held` : `stage "${held.stage}" is in a freeze window`;
  const until = held.until ? ` until ${held.until}` : " until a change to the pipeline lifts the hold";
  const read = held.description ? `. Before it goes on: ${held.description}` : "";
  return `${what}${until}${held.reason ? ` (${held.reason})` : ""}, so nothing is promoted into it${read}`;
}
