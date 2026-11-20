/**
 * The delivery pipeline's declaration and the spec it folds to (#5324).
 *
 * A pipeline is the whole path from merge to the last environment: its
 * stages in promotion order, the waves inside each stage, a gate per stage,
 * the stage's hooks, and its holds. "Stage" means an environment in
 * promotion order, not a CI step.
 *
 * The declaration is written in `.chant/pipeline.ts` inside the
 * TypeScript-as-data subset (`./fold.ts`), and `chant build` folds it to
 * this spec without running it. The spec is plain data, so a reviewer, the
 * gates and the plan note read it before anything runs. Each stage becomes
 * an op-waves spec (`./stages.ts`) that `chant run wave` runs, and the stage
 * order is the promotion order `chant components promote` follows.
 *
 * The shape stays open: a key a later pass adds to a stage, its gate or the
 * pipeline is one line in {@link STAGE_KEYS}, {@link GATE_KEYS} or
 * {@link PIPELINE_KEYS} and its own check. An unknown key is refused, so a
 * folded spec never carries a setting no chant reads.
 */

import { opWavesControlProblems, type GateApprovalSource, type OpWave, type OpWaveGatePolicy, type OpWaveHooks, type OpWavePoint, type OpWavesControl, type OpWavesSpec } from "../op/op-waves";
import { opWaveHoldsProblems, type OpWaveHolds } from "../op/op-waves-capability-spec";
import { quorumProblems, QUORUM_MAX_DEPTH, type GateQuorumNode } from "../op/gate-quorum";
import type { OpEnvironment } from "../lexicon";
import { stageArtifactsSpecProblems, stagePublishProblems, stageReadsProblems, type StageArtifactRead, type StageArtifactSource } from "./artifacts";
import { soakCheckCount, soakProblems, type Soak } from "./soak";

/** The `kind` a folded pipeline carries. A reader refuses any other. */
export const PIPELINE_SPEC_KIND = "chant.pipeline/v1";

/** Where a member keeps its pipeline declaration, from the member's directory (beside `chant.config.ts`). */
export const PIPELINE_FILE = ".chant/pipeline.ts";

/** Where `chant build` writes the folded spec, from the member's directory. */
export const PIPELINE_SPEC_FILE = ".chant/pipeline.json";

/**
 * A run count a wave of many targets may fail and still let the stage go on:
 * a whole number of runs, or a share of the wave's runs as `"<n>%"`.
 */
export type PipelineFailureTolerance = number | `${number}%`;

/**
 * A manual hold. `true` holds the stage until a change to the pipeline lifts
 * it; `until` lifts it at that time by itself. `description` (#5354) is
 * what the person who lifts the hold reads first, such as what to check
 * before the stage goes on: the plan note of the change that lifts it, the
 * promote it refuses and `workspace status` show it.
 */
export type PipelineHold = true | { reason?: string; until?: string; description?: string };

/** A freeze window: no promotion into the stage from `from` until `until` (ISO 8601 times). */
export interface PipelineFreezeWindow {
  from: string;
  until: string;
  reason?: string;
}

/** The gate a stage's waves and its promotion pass through. Read at the base commit. */
export interface PipelineGate {
  /** When the stage waits for an approval. Default `"always"`. */
  policy?: OpWaveGatePolicy;
  /** Which approvals of the stage's digest count. Default `"ledger"`. */
  approval?: GateApprovalSource;
  /**
   * Approval rules: distinct approvers, from roles, one not the author. All
   * must be met. Rules combine in `{ all: [...] }` and `{ any: [...] }`
   * groups, nested up to three deep, and each rule and group may take a
   * `name` (#5354).
   */
  quorum?: GateQuorumNode[];
  /** A decision point the gate asks in place of the ledger. */
  point?: string | OpWavePoint;
  /** The policy, cost and risk holds the stage's waves run over their plans. `risk` (#5325) holds a wave over its threshold and adds its `quorum` rules. */
  holds?: OpWaveHolds;
  /**
   * The urgent rule (#5355): `chant components promote --urgent` passes the
   * stage's gate on one proven approval from `role`, in place of its quorum.
   * Absent: a promote has no urgent path into the stage.
   */
  urgent?: PipelineUrgentRule;
}

/**
 * A stage's urgent rule (#5355). One approval passes it, from an approver
 * who holds `role` in `.chant/trust.json` at base and whose approval is
 * proven by a seal against the signers at base. A plain `chant approve`
 * line never counts, under any approval mode.
 */
export interface PipelineUrgentRule {
  /** The role the one approver holds. */
  role: string;
}

/** A wave inside a stage: an op wave, with the stage's failure tolerance on it unless it names its own. */
export interface PipelineWave extends OpWave {
  failureTolerance?: PipelineFailureTolerance;
}

/**
 * The scheduled re-run of pending promotions (#5326): a promote held by a
 * soak exits 3 and records its pending fact, and a job on this schedule
 * runs each stage's pending promotion again. Absent: no scheduled job.
 */
export interface PipelineRecheck {
  /** A five-field cron line, such as `"0 * * * *"` (every hour). */
  schedule: string;
}

/** One stage: an environment in promotion order. */
export interface PipelineStage {
  /**
   * The environment's name. It is the name `chant components promote --to`
   * takes, the release ledger the stage records on, and the key a step's
   * per-environment inputs are read by. Lowercase letters, digits, `-` and `_`.
   */
  name: string;
  /**
   * The canary stage (#5327): its soak holds every stage after it. A
   * promote into any stage downstream of the canary reads the canary's
   * soak, through its gate `<canary>-soak`, before that stage's gate, so a
   * promote from a later stage or one that skips the canary waits for it
   * too. A canary stage takes a `soak` with at least one check.
   */
  canary?: boolean;
  /** The waves the stage applies, in order. */
  waves: PipelineWave[];
  /** The stage's gate. Absent: every wave waits for an approval, as an op wave does. */
  gate?: PipelineGate;
  /** Hooks around the stage's waves, after the pipeline's own. */
  hooks?: OpWaveHooks;
  /** A manual hold. A held stage refuses promotion with exit 3. */
  hold?: PipelineHold;
  /** Freeze windows. A stage in one refuses promotion with exit 3 until it ends. */
  freeze?: PipelineFreezeWindow[];
  /**
   * A rollback of the stage pauses it (#5355), so the next release waits for
   * `chant stage resume`. Default false.
   */
  pauseAfterRollback?: boolean;
  /** Failed runs a wave of many targets tolerates before the stage stops. Default 0. A wave's own wins. */
  failureTolerance?: PipelineFailureTolerance;
  /** The forge deployment environment the stage's jobs run in, unless a wave names its own. */
  forgeEnvironment?: OpEnvironment;
  /**
   * The members whose dependents are planned again when one of their
   * outputs changes in this stage (#5345): member names, or patterns where
   * `*` matches within one path segment and `**` across. In place of the
   * pipeline's `defaults.replanDependents`. Absent: none. A re-plan only
   * plans; the plan waits at its gate.
   */
  replanDependents?: string[];
  /**
   * The release artifacts the stage publishes once it applied (#5356), by
   * name: a member's output, or where a secret is kept. Recorded on
   * `<stage>/artifacts.jsonl` with the release digest. Absent: none.
   */
  publish?: Record<string, StageArtifactSource>;
  /**
   * The artifacts of upstream stages the stage reads, of the release it takes
   * (#5356), keyed by the variable its deploy gets each in. `chant build`
   * refuses a read of a stage that is not upstream (an ancestor through
   * `after`, else earlier in `stages`) or that does not publish it (#5385).
   * Absent: none.
   */
  reads?: Record<string, StageArtifactRead>;
  /**
   * The stages a release succeeds in before this one opens (#5353), by
   * name: a release fans out to the stages that name one stage, and joins
   * again at a stage that names several. The stage opens for a release only
   * once that same release applied in each of them, and then through its
   * own gate. Absent: the stage before it in `stages`. The first stage is
   * the one a merge applies, and takes none.
   */
  after?: string[];
  /**
   * How the stage takes releases (#5353). `"replace"`: one release at a
   * time. A newer release waiting for the stage replaces an older one still
   * waiting, and a release already in the stage finishes before the next
   * one enters. Absent: each promote goes through on its own.
   */
  queue?: PipelineStageQueue;
  /**
   * The soak (#5326): checks that must keep passing for `duration` after
   * the stage's last apply before a promotion into the next stage passes
   * its gate. A promotion during the soak exits 3 with the time left.
   */
  soak?: Soak;
}

/** The values a stage's `queue` takes (#5353). */
export const PIPELINE_STAGE_QUEUES = ["replace"] as const;
export type PipelineStageQueue = (typeof PIPELINE_STAGE_QUEUES)[number];

/**
 * The op-waves settings every stage shares: the Op, the plan and apply
 * commands or the capability step, the runner, the notify and responses.
 * A stage's gate, hooks and waves are its own.
 */
export type PipelineDefaults = Partial<Omit<OpWavesSpec, "name" | "waves" | "control">>;

/** What a merge does once the first stage applied. */
export interface PipelineRelease {
  /** Cut a release from the applied commit. Default true. */
  cut?: boolean;
  /** The cut's label. Default `auto`, the next version `release next` computes. */
  label?: string;
  /** The command the cut runs as, in place of `chant`: a product's bin, such as `["npx", "--no-install", "plywood"]`. */
  bin?: string[];
}

/** The declaration a member's `.chant/pipeline.ts` writes. */
export interface PipelineDeclaration {
  /** The pipeline's name, and the op its stage gates and skips are recorded under. */
  name: string;
  /** Stages in promotion order, first to last. The merge applies the first. */
  stages: PipelineStage[];
  /** Op-waves settings every stage shares. */
  defaults?: PipelineDefaults;
  /** What the merge does after the first stage applies. */
  release?: PipelineRelease;
  /** The control repo told once the first stage applied: the `<product>-applied` dispatch. */
  control?: OpWavesControl;
  /** The scheduled re-run of promotions a soak holds (#5326). */
  recheck?: PipelineRecheck;
}

/** The folded spec: the declaration as data, with its kind. */
export interface PipelineSpec extends PipelineDeclaration {
  kind: typeof PIPELINE_SPEC_KIND;
}

const NAME = /^[a-z0-9][a-z0-9_-]*$/;
const TOLERANCE = /^(100|[1-9]?[0-9])%$/;
const CRON = /^\S+(\s+\S+){4}$/;

/** The keys a pipeline takes. A later pass adds its key here with its check. */
export const PIPELINE_KEYS: readonly string[] = ["kind", "name", "stages", "defaults", "release", "control", "recheck"];
/** The keys a stage takes. */
export const STAGE_KEYS: readonly string[] = ["name", "canary", "waves", "gate", "hooks", "hold", "freeze", "failureTolerance", "forgeEnvironment", "replanDependents", "publish", "reads", "after", "queue", "pauseAfterRollback", "soak"];
/** The keys a stage's gate takes. */
export const GATE_KEYS: readonly string[] = ["policy", "approval", "quorum", "point", "holds", "urgent"];
const RELEASE_KEYS: readonly string[] = ["cut", "label", "bin"];
const DEFAULTS_REFUSED: readonly string[] = ["name", "waves", "control"];

const isMap = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Whether `value` is an ISO 8601 time `Date` reads. */
function isTime(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
}

/** What is wrong with a failure tolerance, or undefined. */
export function failureToleranceProblem(value: unknown, where: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return undefined;
  if (typeof value === "string" && TOLERANCE.test(value)) return undefined;
  return `${where} must be a whole number of runs, or a share of the wave's runs such as "10%"`;
}

/** What is wrong with a `replanDependents` list, or undefined (#5345). */
export function replanDependentsProblem(value: unknown, where: string): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value) && value.every((v) => typeof v === "string" && v.trim() !== "")) return undefined;
  return `${where} must be a list of member names or patterns`;
}

/** The members a stage plans the dependents of when their outputs change (#5345): the stage's list, else the pipeline's default, else none. */
export function stageReplanDependents(spec: Pick<PipelineSpec, "stages" | "defaults">, stage: string): string[] {
  const own = spec.stages.find((s) => s.name === stage)?.replanDependents;
  return [...(own ?? spec.defaults?.replanDependents ?? [])];
}

function unknownKeys(value: Record<string, unknown>, keys: readonly string[], where: string): string[] {
  return Object.keys(value).filter((k) => !keys.includes(k)).map((k) => `${where} has an unknown key "${k}"; it takes ${keys.join(", ")}`);
}

function holdProblems(hold: unknown, where: string): string[] {
  if (hold === undefined || hold === true) return [];
  if (!isMap(hold)) return [`${where}.hold must be true or { "reason"?, "until"?, "description"? }`];
  const out = unknownKeys(hold, ["reason", "until", "description"], `${where}.hold`);
  if (hold.reason !== undefined && typeof hold.reason !== "string") out.push(`${where}.hold.reason must be text`);
  if (hold.description !== undefined && (typeof hold.description !== "string" || hold.description.trim() === "")) out.push(`${where}.hold.description must be text`);
  if (hold.until !== undefined && !isTime(hold.until)) out.push(`${where}.hold.until must be an ISO 8601 time, such as "2026-12-01T00:00:00Z"`);
  return out;
}

function freezeProblems(freeze: unknown, where: string): string[] {
  if (freeze === undefined) return [];
  if (!Array.isArray(freeze)) return [`${where}.freeze must be a list of { "from", "until", "reason"? }`];
  const out: string[] = [];
  freeze.forEach((w, i) => {
    const at = `${where}.freeze[${i}]`;
    if (!isMap(w)) {
      out.push(`${at} must be { "from", "until", "reason"? }`);
      return;
    }
    out.push(...unknownKeys(w, ["from", "until", "reason"], at));
    if (!isTime(w.from)) out.push(`${at}.from must be an ISO 8601 time`);
    if (!isTime(w.until)) out.push(`${at}.until must be an ISO 8601 time`);
    if (isTime(w.from) && isTime(w.until) && Date.parse(w.until) <= Date.parse(w.from)) out.push(`${at} ends before it starts`);
    if (w.reason !== undefined && typeof w.reason !== "string") out.push(`${at}.reason must be text`);
  });
  return out;
}

function gateProblems(gate: unknown, where: string): string[] {
  if (gate === undefined) return [];
  if (!isMap(gate)) return [`${where}.gate must be { "policy"?, "approval"?, "quorum"?, "point"?, "holds"?, "urgent"? }`];
  const out = unknownKeys(gate, GATE_KEYS, `${where}.gate`);
  if (gate.policy !== undefined && !["always", "on-destructive", "never"].includes(gate.policy as string)) out.push(`${where}.gate.policy is always, on-destructive or never`);
  if (gate.approval !== undefined && !["ledger", "pr-review", "sealed", "pull-request"].includes(gate.approval as string)) out.push(`${where}.gate.approval is ledger, pr-review, sealed or pull-request`);
  if (gate.quorum !== undefined && !Array.isArray(gate.quorum)) out.push(`${where}.gate.quorum must be a list of rules`);
  else if (gate.quorum !== undefined) out.push(...quorumProblems(gate.quorum, `${where}.gate.quorum`, { notAuthor: true, proven: true, combine: true }).map((p) => p.replace(/`/g, "")));
  if (gate.point !== undefined && typeof gate.point !== "string" && !isMap(gate.point)) out.push(`${where}.gate.point must name a decision point`);
  if (gate.holds !== undefined && !isMap(gate.holds)) out.push(`${where}.gate.holds must be { "policy"?, "cost"?, "risk"? }`);
  // #5387: a later stage's holds are read at promote, where no op-waves spec checks them, so they are checked here.
  else if (gate.holds !== undefined) out.push(...opWaveHoldsProblems(gate.holds).map((p) => `${where}.gate: ${p}`));
  if (gate.urgent !== undefined) {
    if (!isMap(gate.urgent)) out.push(`${where}.gate.urgent must be { "role" }`);
    else {
      out.push(...unknownKeys(gate.urgent, ["role"], `${where}.gate.urgent`));
      if (typeof gate.urgent.role !== "string" || gate.urgent.role.trim() === "") out.push(`${where}.gate.urgent.role must name a role in .chant/trust.json`);
    }
  }
  return out;
}

function stageProblems(stage: unknown, i: number, seen: Set<string>): string[] {
  const where = `stages[${i}]`;
  if (!isMap(stage)) return [`${where} must be a stage: { "name", "waves", ... }`];
  const name = typeof stage.name === "string" ? stage.name : undefined;
  const at = name ? `stage "${name}"` : where;
  const out = unknownKeys(stage, STAGE_KEYS, at);
  if (name === undefined || !NAME.test(name)) out.push(`${where}.name must be an environment's name: lowercase letters, digits, "-" and "_"`);
  else if (seen.has(name)) out.push(`${at} is named twice; each environment is one stage`);
  else seen.add(name);
  if (stage.canary !== undefined && typeof stage.canary !== "boolean") out.push(`${at}.canary must be true or false`);
  if (stage.pauseAfterRollback !== undefined && typeof stage.pauseAfterRollback !== "boolean") out.push(`${at}.pauseAfterRollback must be true or false`);
  if (!Array.isArray(stage.waves) || stage.waves.length === 0) out.push(`${at}.waves must list at least one wave`);
  else {
    const waveNames = new Set<string>();
    stage.waves.forEach((w, k) => {
      if (!isMap(w) || typeof w.name !== "string" || !NAME.test(w.name)) out.push(`${at}.waves[${k}] must be a wave with a name of lowercase letters, digits, "-" and "_"`);
      else if (waveNames.has(w.name)) out.push(`${at} has two waves named "${w.name}"`);
      else waveNames.add(w.name);
      if (isMap(w)) {
        const p = failureToleranceProblem(w.failureTolerance, `${at}.waves[${k}].failureTolerance`);
        if (p) out.push(p);
        out.push(...soakProblems(w.soak, `${at}.waves[${k}]`));
        if (w.soak !== undefined && w.rest === true) out.push(`${at}.waves[${k}] has soak and rest; the waves a rest wave walks run in its one job, so none of them can wait for a soak`);
        if (w.soak !== undefined && k === (stage.waves as unknown[]).length - 1) out.push(`${at}.waves[${k}] has soak and is the stage's last wave; a wave's soak holds the wave after it, so the last wave's goes on the stage (${at}.soak)`);
        out.push(...canaryWaveProblems(w, k, (stage.waves as unknown[]).length, stage.soak, at));
      }
    });
  }
  // #5327: a canary holds the stages after it through its soak, so a canary with no check holds nothing.
  if (stage.canary === true && soakCheckCount(isMap(stage.soak) ? stage.soak : undefined) === 0) {
    out.push(`${at} is the canary and its soak has no checks; the canary's soak holds every stage after it, so give the stage a soak with at least one check (${at}.soak.checks)`);
  }
  out.push(...gateProblems(stage.gate, at));
  if (stage.hooks !== undefined && !isMap(stage.hooks)) out.push(`${at}.hooks must be { "before"?, "after"?, "apply"? }`);
  out.push(...holdProblems(stage.hold, at), ...freezeProblems(stage.freeze, at));
  if (stage.forgeEnvironment !== undefined && (!isMap(stage.forgeEnvironment) || typeof stage.forgeEnvironment.name !== "string" || stage.forgeEnvironment.name === "")) out.push(`${at}.forgeEnvironment must be { "name", "url"? }`);
  const tolerance = failureToleranceProblem(stage.failureTolerance, `${at}.failureTolerance`);
  if (tolerance) out.push(tolerance);
  const replan = replanDependentsProblem(stage.replanDependents, `${at}.replanDependents`);
  if (replan) out.push(replan);
  out.push(...stagePublishProblems(stage.publish, at), ...stageReadsProblems(stage.reads, at));
  if (stage.after !== undefined) {
    if (!Array.isArray(stage.after) || stage.after.length === 0 || !stage.after.every((n) => typeof n === "string" && NAME.test(n))) out.push(`${at}.after must list the names of one or more stages`);
    else {
      if (i === 0) out.push(`${at} is the first stage, the one a merge applies, so it takes no after`);
      if (name !== undefined && stage.after.includes(name)) out.push(`${at}.after names the stage itself`);
      const twice = stage.after.filter((n, k) => stage.after !== undefined && (stage.after as string[]).indexOf(n) !== k);
      if (twice.length > 0) out.push(`${at}.after names ${[...new Set(twice)].join(", ")} twice`);
    }
  }
  if (stage.queue !== undefined && !(PIPELINE_STAGE_QUEUES as readonly unknown[]).includes(stage.queue)) out.push(`${at}.queue is ${PIPELINE_STAGE_QUEUES.join(", ")}`);
  out.push(...soakProblems(stage.soak, at));
  return out;
}

/**
 * A canary wave inside a stage (#5327): the stage's first wave, with a wave
 * after it to hold, and soak checks of its own or, when it declares no
 * soak, the stage's, which it then takes (`./stages.ts`).
 */
function canaryWaveProblems(w: Record<string, unknown>, k: number, count: number, stageSoak: unknown, at: string): string[] {
  if (w.canary === undefined) return [];
  if (typeof w.canary !== "boolean") return [`${at}.waves[${k}].canary must be true or false`];
  if (!w.canary) return [];
  const out: string[] = [];
  if (k !== 0) out.push(`${at}.waves[${k}] is a canary wave and not the stage's first wave; the canary applies before every other wave`);
  if (count === 1) out.push(`${at}.waves[${k}] is a canary wave and the stage's only wave, so no wave waits for it; mark the stage canary instead (${at}.canary)`);
  if (w.rest === true) out.push(`${at}.waves[${k}] is a canary wave and has rest; the waves a rest wave walks run in its one job, so none of them could wait for the canary's soak`);
  const soak = w.soak !== undefined ? w.soak : stageSoak;
  if (soakCheckCount(isMap(soak) ? soak : undefined) === 0) {
    out.push(`${at}.waves[${k}] is a canary wave with no soak checks, of its own or the stage's; its soak holds the waves after it, so give it a soak with at least one check (${at}.waves[${k}].soak, or ${at}.soak)`);
  }
  return out;
}

/**
 * The canary stages a promote into `to` waits on (#5327), in pipeline
 * order: each stage marked `canary` that `to` follows, directly or through
 * the stages between ({@link stageUpstreams}). `to` itself is not one.
 */
export function canaryStagesBefore(spec: Pick<PipelineDeclaration, "stages">, to: string): PipelineStage[] {
  const seen = new Set<string>();
  const walk = (name: string): void => {
    for (const up of stageUpstreams(spec, name)) {
      if (seen.has(up)) continue;
      seen.add(up);
      walk(up);
    }
  };
  walk(to);
  return spec.stages.filter((s) => s.canary === true && s.name !== to && seen.has(s.name));
}

/**
 * The stages each stage follows (#5353): its `after`, else the stage before
 * it in the list, else none for the first.
 */
export function stageUpstreams(spec: Pick<PipelineDeclaration, "stages">, name: string): string[] {
  const index = spec.stages.findIndex((s) => s.name === name);
  if (index < 0) return [];
  const stage = spec.stages[index]!;
  if (stage.after !== undefined) return [...stage.after];
  return index === 0 ? [] : [spec.stages[index - 1]!.name];
}

/**
 * A cycle among the stages, as the stage names around it with the first
 * repeated at the end, or undefined when there is none. Each stage follows
 * {@link stageUpstreams}.
 */
export function stageCycle(spec: Pick<PipelineDeclaration, "stages">): string[] | undefined {
  const state = new Map<string, "open" | "done">();
  const path: string[] = [];
  const visit = (name: string): string[] | undefined => {
    if (state.get(name) === "done") return undefined;
    if (state.get(name) === "open") return [...path.slice(path.indexOf(name)), name];
    state.set(name, "open");
    path.push(name);
    for (const up of stageUpstreams(spec, name)) {
      if (!spec.stages.some((s) => s.name === up)) continue;
      const found = visit(up);
      if (found) return found;
    }
    path.pop();
    state.set(name, "done");
    return undefined;
  };
  for (const s of spec.stages) {
    const found = visit(s.name);
    if (found) return found.reverse();
  }
  return undefined;
}

/** Whether a promote records its stages in the stage log (#5353): some stage declares `after` or `queue`. */
export function pipelineTracksStages(spec: Pick<PipelineDeclaration, "stages">): boolean {
  return spec.stages.some((s) => s.after !== undefined || s.queue !== undefined);
}

function graphProblems(stages: unknown[]): string[] {
  const named = stages.filter((s): s is PipelineStage => isMap(s) && typeof s.name === "string" && Array.isArray(s.waves));
  const names = new Set(named.map((s) => s.name));
  const out: string[] = [];
  for (const s of named) {
    if (!Array.isArray(s.after)) continue;
    const unknown = s.after.filter((n) => typeof n === "string" && !names.has(n));
    if (unknown.length > 0) out.push(`stage "${s.name}".after names ${unknown.join(", ")}, which the pipeline has no stage for; its stages are ${[...names].join(", ")}`);
  }
  if (out.length > 0) return out;
  const cycle = stageCycle({ stages: named });
  if (cycle) out.push(`the stages ${cycle.join(" -> ")} form a cycle through after, so no release could open any of them; each stage follows its after, else the stage before it`);
  return out;
}

/**
 * A later stage's `holds.risk` reads the score its release carries (#5387),
 * and a release carries one only when the first stage's waves score it. A
 * later stage that sets `holds.risk` while the first stage has none, of its
 * own or from `defaults`, would never read a score, so it is refused.
 */
function laterRiskProblems(stages: unknown[], defaults: unknown): string[] {
  const holdsOf = (s: unknown): unknown => (isMap(s) && isMap(s.gate) ? s.gate.holds : undefined);
  const riskIn = (holds: unknown): boolean => isMap(holds) && holds.risk !== undefined;
  const first = stages[0];
  const own = holdsOf(first);
  const firstScores = own !== undefined ? riskIn(own) : isMap(defaults) && riskIn(defaults.holds);
  if (firstScores) return [];
  const firstName = isMap(first) && typeof first.name === "string" ? first.name : "the first stage";
  return stages
    .slice(1)
    .filter((s) => riskIn(holdsOf(s) ?? (isMap(defaults) ? defaults.holds : undefined)))
    .map((s) => `stage "${(s as { name: string }).name}" reads holds.risk at its gate, and the first stage "${firstName}" sets no holds.risk, of its own or from defaults; the first stage must score with holds.risk for a release to carry a score that a later stage reads`);
}

/**
 * Everything wrong with a folded pipeline, one line each; empty when it
 * reads. The stage-level checks are here; each stage's op-waves spec is
 * checked again by `assertOpWavesSpec` when it is derived (`./stages.ts`).
 */
export function pipelineSpecProblems(value: unknown): string[] {
  if (!isMap(value)) return ["a pipeline is { \"name\", \"stages\": [...] }"];
  const out = unknownKeys(value, PIPELINE_KEYS, "the pipeline");
  if (value.kind !== undefined && value.kind !== PIPELINE_SPEC_KIND) out.push(`the pipeline's kind is ${JSON.stringify(value.kind)}; this chant reads ${PIPELINE_SPEC_KIND}`);
  if (typeof value.name !== "string" || !NAME.test(value.name)) out.push("the pipeline's name must be lowercase letters, digits, \"-\" and \"_\"");
  if (!Array.isArray(value.stages) || value.stages.length === 0) out.push("the pipeline must list at least one stage");
  else {
    const seen = new Set<string>();
    value.stages.forEach((s, i) => out.push(...stageProblems(s, i, seen)));
    if (out.length === 0) out.push(...graphProblems(value.stages));
    if (out.length === 0) out.push(...laterRiskProblems(value.stages, value.defaults));
    out.push(...stageArtifactsSpecProblems(value));
  }
  if (value.defaults !== undefined) {
    if (!isMap(value.defaults)) out.push("the pipeline's defaults must be op-waves settings: { \"op\", \"step\", ... }");
    else for (const k of DEFAULTS_REFUSED) if (k in value.defaults) out.push(`defaults.${k} is set by the pipeline, not its defaults`);
  }
  if (value.release !== undefined) {
    if (!isMap(value.release)) out.push("the pipeline's release must be { \"cut\"?, \"label\"?, \"bin\"? }");
    else {
      out.push(...unknownKeys(value.release, RELEASE_KEYS, "release"));
      if (value.release.cut !== undefined && typeof value.release.cut !== "boolean") out.push("release.cut must be true or false");
      if (value.release.label !== undefined && (typeof value.release.label !== "string" || value.release.label.trim() === "")) out.push("release.label must name the release, or be auto");
      if (value.release.bin !== undefined && (!Array.isArray(value.release.bin) || value.release.bin.length === 0 || value.release.bin.some((w) => typeof w !== "string" || w === ""))) out.push("release.bin must be a list of words, such as [\"npx\", \"--no-install\", \"plywood\"]");
    }
  }
  if (value.control !== undefined) out.push(...opWavesControlProblems(value.control).map((p) => `the pipeline's ${p}`));
  if (value.recheck !== undefined) {
    if (!isMap(value.recheck)) out.push("the pipeline's recheck must be { \"schedule\" }");
    else {
      out.push(...unknownKeys(value.recheck, ["schedule"], "recheck"));
      if (typeof value.recheck.schedule !== "string" || !CRON.test(value.recheck.schedule.trim())) out.push("recheck.schedule must be a five-field cron line, such as \"*/30 * * * *\"");
    }
  }
  return out;
}

/** The spec, checked, with its kind. Throws naming every problem. */
export function asPipelineSpec(value: unknown, where = "the pipeline"): PipelineSpec {
  const problems = pipelineSpecProblems(value);
  if (problems.length > 0) throw new Error(`${where}: ${problems.join("; ")}`);
  return { ...(value as PipelineDeclaration), kind: PIPELINE_SPEC_KIND };
}

/** Whether a parsed JSON document is a folded pipeline, by its kind. */
export function isPipelineSpecDocument(value: unknown): value is PipelineSpec {
  return isMap(value) && value.kind === PIPELINE_SPEC_KIND;
}

/**
 * The folded spec's JSON Schema, for an editor or a reader in another
 * language. The stage's waves are op waves, checked in full when each
 * stage's op-waves spec is derived.
 */
export const PIPELINE_SPEC_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://intentius.io/chant/schemas/pipeline-v1.json",
  title: "chant pipeline",
  type: "object",
  required: ["kind", "name", "stages"],
  additionalProperties: false,
  properties: {
    kind: { const: PIPELINE_SPEC_KIND },
    name: { type: "string", pattern: NAME.source },
    defaults: { type: "object", not: { anyOf: DEFAULTS_REFUSED.map((k) => ({ required: [k] })) } },
    release: {
      type: "object",
      additionalProperties: false,
      properties: { cut: { type: "boolean" }, label: { type: "string", minLength: 1 }, bin: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } } },
    },
    control: { type: "object" },
    recheck: { type: "object", required: ["schedule"], additionalProperties: false, properties: { schedule: { type: "string", pattern: CRON.source } } },
    stages: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["name", "waves"],
        additionalProperties: false,
        properties: {
          name: { type: "string", pattern: NAME.source },
          canary: { type: "boolean" },
          waves: { type: "array", minItems: 1, items: { type: "object", required: ["name"], properties: { name: { type: "string", pattern: NAME.source }, failureTolerance: { $ref: "#/$defs/tolerance" }, soak: { $ref: "#/$defs/soak" }, canary: { type: "boolean" } } } },
          gate: {
            type: "object",
            additionalProperties: false,
            properties: {
              policy: { enum: ["always", "on-destructive", "never"] },
              approval: { enum: ["ledger", "pr-review", "sealed", "pull-request"] },
              quorum: { type: "array", minItems: 1, items: { $ref: "#/$defs/quorumNode" } },
              point: { type: ["string", "object"] },
              holds: { type: "object" },
              urgent: { type: "object", required: ["role"], additionalProperties: false, properties: { role: { type: "string", minLength: 1 } } },
            },
          },
          hooks: { type: "object" },
          hold: { oneOf: [{ const: true }, { type: "object", additionalProperties: false, properties: { reason: { type: "string" }, until: { type: "string", format: "date-time" }, description: { type: "string", minLength: 1 } } }] },
          freeze: {
            type: "array",
            items: { type: "object", required: ["from", "until"], additionalProperties: false, properties: { from: { type: "string", format: "date-time" }, until: { type: "string", format: "date-time" }, reason: { type: "string" } } },
          },
          failureTolerance: { $ref: "#/$defs/tolerance" },
          forgeEnvironment: { type: "object", required: ["name"], properties: { name: { type: "string", minLength: 1 }, url: { type: "string" } } },
          replanDependents: { type: "array", items: { type: "string", minLength: 1 } },
          publish: {
            type: "object",
            additionalProperties: {
              oneOf: [
                { type: "object", required: ["member", "output"], additionalProperties: false, properties: { member: { type: "string", minLength: 1 }, output: { type: "string", minLength: 1 } } },
                { type: "object", required: ["secret"], additionalProperties: false, properties: { secret: { type: ["string", "object"] } } },
              ],
            },
          },
          reads: {
            type: "object",
            additionalProperties: { type: "object", required: ["stage", "artifact"], additionalProperties: false, properties: { stage: { type: "string", pattern: NAME.source }, artifact: { type: "string", minLength: 1 } } },
          },
          after: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", pattern: NAME.source } },
          queue: { enum: [...PIPELINE_STAGE_QUEUES] },
          pauseAfterRollback: { type: "boolean" },
          soak: { $ref: "#/$defs/soak" },
        },
      },
    },
  },
  $defs: {
    // #5354: a rule, or an all/any group of them; the depth (QUORUM_MAX_DEPTH) is checked when the spec is read.
    quorumNode: {
      type: "object",
      properties: { name: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]*$" }, all: { type: "array", minItems: 1, items: { $ref: "#/$defs/quorumNode" } }, any: { type: "array", minItems: 1, items: { $ref: "#/$defs/quorumNode" } } },
      description: `a rule { name?, targets?, count, roles?, notAuthor?, proven? }, or a group { name?, all | any }, nested up to ${QUORUM_MAX_DEPTH} groups deep`,
    },
    tolerance: { oneOf: [{ type: "integer", minimum: 0 }, { type: "string", pattern: TOLERANCE.source }] },
    duration: { type: "string", pattern: "^(0|\\d+[mhd])$" },
    check: {
      type: "object",
      required: ["kind"],
      properties: {
        kind: { enum: ["drift", "apply", "policy", "http", "prometheus", "cloudwatch-alarm", "command", "health"] },
        name: { type: "string", minLength: 1 },
        onFail: { enum: ["restart", "hold"] },
      },
    },
    soak: {
      type: "object",
      required: ["duration"],
      additionalProperties: false,
      properties: {
        duration: { $ref: "#/$defs/duration" },
        checks: { type: "array", items: { $ref: "#/$defs/check" } },
        overrides: {
          type: "array",
          items: {
            type: "object",
            required: ["members"],
            additionalProperties: false,
            properties: { members: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } }, duration: { $ref: "#/$defs/duration" }, checks: { type: "array", items: { $ref: "#/$defs/check" } } },
          },
        },
      },
    },
  },
} as const;
