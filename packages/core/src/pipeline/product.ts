/**
 * The helpers a product writes `.chant/pipeline.ts` with (#5324).
 *
 * A committed TypeScript file cannot read `terragucci.yml`, `plywood.yml` or
 * `yodel.config.ts` itself, so the product writes the file from its config,
 * the way it renders its workflows: {@link pipelineFromConfig} maps the
 * vocabulary's keys (`promotion`, `environments.<name>.gate`, `.hold`,
 * `.freeze`, `.failure_tolerance`, `.risk`, `.replan_dependents`, `.publish`, `.reads`, `.after`, `.queue`,
 * `.urgent`, `.pause_after_rollback`, `.hooks.<when>`, `.agent_steps`, `.on_verify_fail`,
 * `approval_rules`, `release.cut`) onto a
 * declaration, {@link pipelineSource} writes the file's text, and
 * {@link checkPipelineFile} is what `<product> ci --check` runs: it fails
 * when the committed file is not the one the config writes now.
 *
 * The file is generated output. Hand edits are overwritten the next time the
 * product writes it, and fail the check until then.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GateQuorumNode, GateQuorumRule } from "../op/gate-quorum";
import { OP_WAVE_HOOK_MOMENTS, type OpWaveHook, type OpWaveHooks } from "../op/op-waves";
import { NEXT_RELEASE } from "../release-floors";
import type { OpEnvironment } from "../lexicon";
import { foldPipelineSource, pipelineFindingLine, PIPELINE_MODULE } from "./fold";
import { lineDiff } from "./diff";
import { asPipelineSpec, PIPELINE_FILE, type PipelineDeclaration, type PipelineDefaults, type PipelineFailureTolerance, type PipelineFreezeWindow, type PipelineGate, type PipelineHold, type PipelineRecheck, type PipelineRelease, type PipelineStage, type PipelineWave } from "./spec";
import type { Soak, SoakCheck } from "./soak";

/**
 * The first chant whose `pipelineFromConfig` maps a stage's hooks (#5421):
 * `environments.<name>.hooks.<when>` in a product's config onto a stage's
 * `hooks` in `.chant/pipeline.ts`, with `<when>` one of `before-observe`,
 * `before-plan`, `after-plan`, `after-gate`, `before-apply` and
 * `after-apply`. A product feature-detects the key on this name before it
 * writes it.
 */
export const STAGE_HOOKS_KEY_FLOOR = NEXT_RELEASE;

/** One stage hook as a product's config spells it: the keys of {@link OpWaveHook}, snake_case or camelCase. */
export interface StageHookConfig {
  name?: string;
  command: string[];
  on_failure?: OpWaveHook["onFailure"];
  onFailure?: OpWaveHook["onFailure"];
  per_run?: boolean;
  perRun?: boolean;
  targets?: string[];
}

/** One environment's settings, as a product's config spells them under `environments.<name>`, snake_case or camelCase. */
export interface PipelineEnvironmentConfig {
  gate?: PipelineGate["policy"];
  approval?: PipelineGate["approval"] | { mode?: PipelineGate["approval"] };
  approval_rules?: ApprovalRulesConfig;
  approvalRules?: ApprovalRulesConfig;
  hold?: boolean | { reason?: string; until?: string; description?: string };
  freeze?: PipelineFreezeWindow[];
  failure_tolerance?: PipelineFailureTolerance;
  failureTolerance?: PipelineFailureTolerance;
  /** A name, or `{ name, url }`. */
  forge_environment?: string | OpEnvironment;
  forgeEnvironment?: string | OpEnvironment;
  canary?: boolean;
  /** `publish.<artifact>`: `{ member, output }`, or `{ secret }` in a set's secret words, snake_case or camelCase (#5356). */
  publish?: Record<string, { member?: string; output?: string; secret?: unknown }>;
  /** `reads.<variable>`: `{ stage, artifact }` (#5356). */
  reads?: Record<string, { stage: string; artifact: string }>;
  /** The stages a release applies in before this one opens (#5353). */
  after?: string[];
  /** `replace`: one release at a time, a newer one waiting replacing an older (#5353). */
  queue?: PipelineStage["queue"];
  /** `urgent.role` (#5355): the role whose one proven approval passes the stage's gate on `promote --urgent`. */
  urgent?: { role: string };
  /** `pause_after_rollback` (#5355): a rollback of the stage pauses it. */
  pause_after_rollback?: boolean;
  pauseAfterRollback?: boolean;
  /** `risk.approve_above` and `risk.approval_rules` (#5325): the score over which the stage's waves wait, and the rules they take on top of the gate's own. Land on the gate's `holds.risk`. */
  risk?: RiskConfig;
  /** `replan_dependents`: the members whose dependents are planned again when an output they read changes after an apply (#5345). Replaces `defaults.replanDependents` for the stage. */
  replan_dependents?: string[];
  replanDependents?: string[];
  /** `soak`: `{ duration, checks, overrides }`; a check's `on_fail` and `timeout_seconds` in snake_case or camelCase (#5326). */
  soak?: SoakConfig;
  /** `hooks.<when>` (#5421): the commands a stage runs at `before-observe`, `before-plan`, `after-plan`, `after-gate`, `before-apply` or `after-apply`, each a list of hooks. */
  hooks?: Partial<Record<(typeof OP_WAVE_HOOK_MOMENTS)[number], StageHookConfig[]>>;
  /** `agent_steps.<step>`: `prompt`, `reads`, `schema`, `command`, `key_secret`, `timeout`, `max_runs`, `max_cost_usd` (#5358), snake_case or camelCase. */
  agent_steps?: Record<string, AgentStepConfig>;
  agentSteps?: Record<string, AgentStepConfig>;
  /** `on_verify_fail` (#5328): `hold`, or `rollback` to request the rollback to the stage's previous release when its verify or soak fails. */
  on_verify_fail?: PipelineStage["onVerifyFail"];
  onVerifyFail?: PipelineStage["onVerifyFail"];
  [key: string]: unknown;
}

/** `environments.<name>.risk` as a product's config spells it, snake_case or camelCase (#5325). */
export interface RiskConfig {
  approve_above?: number;
  approveAbove?: number;
  /** Rules only; a group (`all`, `any`) is refused, since a risk hold takes plain rules. */
  approval_rules?: ApprovalRulesConfig;
  approvalRules?: ApprovalRulesConfig;
}

/** A stage's `gate.holds.risk` from `environments.<name>.risk` (#5325). */
function riskOf(risk: RiskConfig | undefined, stage: string): NonNullable<NonNullable<PipelineGate["holds"]>["risk"]> | undefined {
  if (!risk) return undefined;
  const approveAbove = risk.approve_above ?? risk.approveAbove;
  const rules = rulesOf(risk.approval_rules ?? risk.approvalRules);
  if (rules?.some((n) => "all" in n || "any" in n)) throw new Error(`environments.${stage}.risk.approval_rules holds a group; a risk hold takes rules only`);
  const out: NonNullable<NonNullable<PipelineGate["holds"]>["risk"]> = {
    ...(approveAbove !== undefined ? { approveAbove } : {}),
    ...(rules && rules.length > 0 ? { quorum: rules as GateQuorumRule[] } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

/** A soak as a product's config spells it (#5326): the keys of {@link Soak}, snake_case or camelCase. */
export interface SoakConfig {
  duration: string;
  checks?: Record<string, unknown>[];
  overrides?: { members: string[]; duration?: string; checks?: Record<string, unknown>[] }[];
}

const SOAK_CHECK_WORDS: Record<string, string> = { on_fail: "onFail", timeout_seconds: "timeoutSeconds" };

function soakChecksOf(checks: Record<string, unknown>[]): SoakCheck[] {
  return checks.map((c) => Object.fromEntries(Object.entries(c).map(([k, v]) => [SOAK_CHECK_WORDS[k] ?? k, structuredClone(v)])) as unknown as SoakCheck);
}

/** A stage's `soak` from `environments.<name>.soak` (#5326). */
function soakOf(soak: SoakConfig | undefined): Soak | undefined {
  if (!soak) return undefined;
  return {
    duration: soak.duration,
    ...(soak.checks ? { checks: soakChecksOf(soak.checks) } : {}),
    ...(soak.overrides ? { overrides: soak.overrides.map((o) => ({ members: [...o.members], ...(o.duration !== undefined ? { duration: o.duration } : {}), ...(o.checks ? { checks: soakChecksOf(o.checks) } : {}) })) } : {}),
  };
}

/** One agent step as a config spells it (#5358). */
export interface AgentStepConfig {
  prompt: string;
  reads?: Record<string, { stage: string; artifact: string } | { step: string }>;
  schema: Record<string, unknown>;
  command?: string;
  key_secret?: string;
  keySecret?: string;
  timeout?: number;
  max_runs?: number;
  maxRuns?: number;
  max_cost_usd?: number;
  maxCostUsd?: number;
}

/** A stage's `agentSteps` from `environments.<name>.agent_steps` (#5358). The schema is kept as written. */
function agentStepsOf(steps: Record<string, AgentStepConfig> | undefined): PipelineStage["agentSteps"] | undefined {
  if (!steps || Object.keys(steps).length === 0) return undefined;
  return Object.fromEntries(
    Object.entries(steps).map(([name, c]) => {
      const keyEnv = c.key_secret ?? c.keySecret;
      const maxRuns = c.max_runs ?? c.maxRuns;
      const maxCostUsd = c.max_cost_usd ?? c.maxCostUsd;
      return [
        name,
        {
          prompt: c.prompt,
          ...(c.reads && Object.keys(c.reads).length > 0 ? { reads: Object.fromEntries(Object.entries(c.reads).map(([k, r]) => [k, "step" in r ? { step: r.step } : { stage: r.stage, artifact: r.artifact }])) } : {}),
          schema: structuredClone(c.schema),
          ...(c.command ? { command: c.command } : {}),
          ...(keyEnv ? { keyEnv } : {}),
          ...(c.timeout !== undefined ? { timeout: c.timeout } : {}),
          ...(maxRuns !== undefined ? { maxRuns } : {}),
          ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
        },
      ];
    }),
  );
}

/** One approval rule as a config spells it: `count`, `roles`, `not_author`, `targets`, `proven`, `name`. */
export interface ApprovalRuleConfig {
  count: number;
  roles?: string[];
  not_author?: boolean;
  notAuthor?: boolean;
  targets?: string[];
  proven?: boolean;
  /** The rule's name (#5354). */
  name?: string;
}

/** A group of rules (#5354): met when all of them are, or when any one is. Each holds a list or a map of rules and groups. */
export type ApprovalGroupConfig = { name?: string; all: ApprovalRulesConfig } | { name?: string; any: ApprovalRulesConfig };

/** `approval_rules`: a list (terragucci) or a map of named rules (plywood), of rules and `all`/`any` groups (#5354). */
export type ApprovalRulesConfig = Array<ApprovalRuleConfig | ApprovalGroupConfig> | Record<string, ApprovalRuleConfig | ApprovalGroupConfig>;

/** What {@link pipelineFromConfig} reads. */
export interface PipelineConfigInput {
  /** The pipeline's name: the op its stage gates are recorded under. */
  name: string;
  /** `promotion`: the stages in order. */
  promotion: readonly string[];
  /** `environments`: each stage's settings by name. A stage with none takes the defaults. */
  environments?: Record<string, PipelineEnvironmentConfig | undefined>;
  /** `approval_rules` for every stage; an environment's own replace them. */
  approvalRules?: ApprovalRulesConfig;
  /** `gate` for every stage; an environment's own wins. */
  gate?: PipelineGate["policy"];
  /** `approval` for every stage; an environment's own wins. */
  approval?: PipelineGate["approval"];
  /** The waves each stage applies, by stage name, as the product works them out from its config (its members, stacks or databases). */
  waves: Record<string, PipelineWave[]>;
  /** Op-waves settings every stage shares: the Op, the step, the runner. */
  defaults?: PipelineDefaults;
  /** `release`: `{ cut, label }`, and the product's bin the cut runs as. */
  release?: PipelineRelease;
  /** `control`: the control repo told after the first stage. */
  control?: PipelineDeclaration["control"];
  /** `recheck`: `{ schedule }`, the cron line pending promotions are tried again on (#5326). */
  recheck?: PipelineRecheck;
}

function rulesOf(config: ApprovalRulesConfig | undefined): GateQuorumNode[] | undefined {
  if (config === undefined) return undefined;
  const list = Array.isArray(config) ? config : Object.keys(config).sort().map((k) => config[k]!);
  return list.map((r): GateQuorumNode => {
    // #5354: a rule or group is named by its own `name`. A map's key stays the config's own label, so a spec written before names stays the same.
    const named = r.name !== undefined ? { name: r.name } : {};
    if ("all" in r) return { ...named, all: rulesOf(r.all) ?? [] };
    if ("any" in r) return { ...named, any: rulesOf(r.any) ?? [] };
    const rule: GateQuorumRule = {
      ...named,
      count: r.count,
      ...(r.roles ? { roles: [...r.roles] } : {}),
      ...(r.not_author ?? r.notAuthor ? { notAuthor: true } : {}),
      ...(r.targets ? { targets: [...r.targets] } : {}),
      ...(r.proven ? { proven: true } : {}),
    };
    return rule;
  });
}

const SECRET_WORDS: Record<string, string> = { forge_secret: "forgeSecret", aws_secrets_manager: "awsSecretsManager", gcp_secret_manager: "gcpSecretManager", azure_key_vault: "azureKeyVault", json_key: "jsonKey" };

/** A secret's place in camelCase, as a set's secret takes it (#5348): a product's snake_case keys renamed, a string kept. */
function secretRefOf(ref: unknown): unknown {
  if (ref === null || typeof ref !== "object" || Array.isArray(ref)) return ref;
  return Object.fromEntries(Object.entries(ref).map(([k, v]) => [SECRET_WORDS[k] ?? k, v]));
}

/** A stage's `publish` from `environments.<name>.publish` (#5356). */
function publishOf(publish: PipelineEnvironmentConfig["publish"]): PipelineStage["publish"] | undefined {
  if (!publish || Object.keys(publish).length === 0) return undefined;
  return Object.fromEntries(
    Object.entries(publish).map(([name, source]) => [name, (source && "secret" in source ? { secret: secretRefOf(source.secret) } : { member: source?.member, output: source?.output }) as NonNullable<PipelineStage["publish"]>[string]]),
  );
}

/** A stage's `hooks` from `environments.<name>.hooks.<when>` (#5421). Throws on a `<when>` that is not a moment. */
function hooksOf(hooks: PipelineEnvironmentConfig["hooks"], stage: string): OpWaveHooks | undefined {
  if (!hooks) return undefined;
  const out: OpWaveHooks = {};
  for (const [when, list] of Object.entries(hooks)) {
    if (!(OP_WAVE_HOOK_MOMENTS as readonly string[]).includes(when)) throw new Error(`environments.${stage}.hooks.${when}: <when> is one of ${OP_WAVE_HOOK_MOMENTS.join(", ")}`);
    if (!Array.isArray(list) || list.length === 0) continue;
    const mapped: OpWaveHook[] = list.map((h) => {
      const onFailure = h.on_failure ?? h.onFailure;
      const perRun = h.per_run ?? h.perRun;
      return {
        ...(h.name !== undefined ? { name: h.name } : {}),
        command: [...h.command],
        ...(onFailure !== undefined ? { onFailure } : {}),
        ...(perRun ? { perRun: true } : {}),
        ...(h.targets && h.targets.length > 0 ? { targets: [...h.targets] } : {}),
      };
    });
    const [side, step] = when.split("-") as ["before" | "after", string];
    const group = (out[side] ??= {}) as Record<string, OpWaveHook[]>;
    group[step] = mapped;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function holdOf(hold: PipelineEnvironmentConfig["hold"]): PipelineHold | undefined {
  if (hold === undefined || hold === false) return undefined;
  if (hold === true) return true;
  return { ...(hold.reason ? { reason: hold.reason } : {}), ...(hold.until ? { until: hold.until } : {}), ...(hold.description ? { description: hold.description } : {}) };
}

/**
 * A declaration from a product's config, in the vocabulary's keys. Throws
 * when `promotion` names a stage `waves` has none for, or the declaration
 * does not check.
 */
export function pipelineFromConfig(input: PipelineConfigInput): PipelineDeclaration {
  const stages: PipelineStage[] = input.promotion.map((name) => {
    const env = input.environments?.[name] ?? {};
    const waves = input.waves[name];
    if (!waves || waves.length === 0) throw new Error(`promotion names ${name}, and no waves were given for it`);
    const policy = env.gate ?? input.gate;
    const approvalRaw = env.approval ?? input.approval;
    const approval = typeof approvalRaw === "object" ? approvalRaw.mode : approvalRaw;
    const quorum = rulesOf(env.approval_rules ?? env.approvalRules ?? input.approvalRules);
    const gate: PipelineGate = { ...(policy ? { policy } : {}), ...(approval ? { approval } : {}), ...(quorum ? { quorum } : {}), ...(env.urgent ? { urgent: { role: env.urgent.role } } : {}), ...(risk ? { holds: { risk } } : {}) };
    const risk = riskOf(env.risk, name);
    const replan = env.replan_dependents ?? env.replanDependents;
    const pauseAfterRollback = env.pause_after_rollback ?? env.pauseAfterRollback;
    const onVerifyFail = env.on_verify_fail ?? env.onVerifyFail;
    const hold = holdOf(env.hold);
    const hooks = hooksOf(env.hooks, name);
    const tolerance = env.failure_tolerance ?? env.failureTolerance;
    const forgeRaw = env.forge_environment ?? env.forgeEnvironment;
    const forge = typeof forgeRaw === "string" ? { name: forgeRaw } : forgeRaw;
    return {
      name,
      ...(env.canary ? { canary: true } : {}),
      ...(replan && replan.length > 0 ? { replanDependents: [...replan] } : {}),
      waves: waves.map((w) => structuredClone(w)),
      ...(Object.keys(gate).length > 0 ? { gate } : {}),
      ...(hooks ? { hooks } : {}),
      ...(hold ? { hold } : {}),
      ...(env.freeze && env.freeze.length > 0 ? { freeze: env.freeze.map((w) => ({ ...w })) } : {}),
      ...(tolerance !== undefined ? { failureTolerance: tolerance } : {}),
      ...(forge ? { forgeEnvironment: forge } : {}),
      ...(publishOf(env.publish) ? { publish: publishOf(env.publish)! } : {}),
      ...(agentStepsOf(env.agent_steps ?? env.agentSteps) ? { agentSteps: agentStepsOf(env.agent_steps ?? env.agentSteps)! } : {}),
      ...(env.reads && Object.keys(env.reads).length > 0 ? { reads: Object.fromEntries(Object.entries(env.reads).map(([k, r]) => [k, { stage: r.stage, artifact: r.artifact }])) } : {}),
      ...(env.after && env.after.length > 0 ? { after: [...env.after] } : {}),
      ...(env.queue !== undefined ? { queue: env.queue } : {}),
      ...(pauseAfterRollback ? { pauseAfterRollback: true } : {}),
      ...(env.soak ? { soak: soakOf(env.soak)! } : {}),
      // #5328: `hold` is the default, so it is left out; any other value is written, and the check refuses one it does not know.
      ...(onVerifyFail !== undefined && onVerifyFail !== "hold" ? { onVerifyFail } : {}),
    };
  });
  const declaration: PipelineDeclaration = {
    name: input.name,
    stages,
    ...(input.defaults ? { defaults: structuredClone(input.defaults) } : {}),
    ...(input.release ? { release: { ...input.release } } : {}),
    ...(input.control ? { control: structuredClone(input.control) } : {}),
    ...(input.recheck ? { recheck: { schedule: input.recheck.schedule } } : {}),
  };
  asPipelineSpec(declaration);
  return declaration;
}

/** What {@link pipelineSource} puts at the top of the file. */
export interface PipelineSourceOptions {
  /** The product that writes the file, such as `terragucci`. */
  product: string;
  /** The config file it is written from, such as `terragucci.yml`. */
  config: string;
  /** The command that writes it again, such as `terragucci ci`. */
  command: string;
}

/**
 * The text of `.chant/pipeline.ts` for a declaration: a header naming the
 * product and the command that writes it, the helper's import, and the
 * declaration as one object literal. Folds to the declaration. Throws on a
 * declaration that does not check.
 */
export function pipelineSource(declaration: PipelineDeclaration, options: PipelineSourceOptions): string {
  const { kind: _kind, ...plain } = asPipelineSpec(structuredClone(declaration));
  return [
    `// Written by ${options.product} from ${options.config}. Change the config and run \`${options.command}\`;`,
    `// \`${options.product} ci --check\` fails while this file differs from what the config writes.`,
    `import { pipeline } from "${PIPELINE_MODULE}";`,
    "",
    `export default pipeline(${JSON.stringify(plain, null, 2)});`,
    "",
  ].join("\n");
}

/** What {@link checkPipelineFile} found. */
export type PipelineFileCheck =
  | { status: "current"; file: string }
  | { status: "missing"; file: string; message: string }
  | { status: "stale"; file: string; message: string; diff: string[] };

/**
 * Whether the committed `.chant/pipeline.ts` in `dir` is `expected`, the
 * text {@link pipelineSource} writes from the config now. A stale file's
 * result carries the line diff and a message naming the command.
 */
export function checkPipelineFile(dir: string, expected: string, options: Pick<PipelineSourceOptions, "command">): PipelineFileCheck {
  const file = join(dir, PIPELINE_FILE);
  if (!existsSync(file)) return { status: "missing", file: PIPELINE_FILE, message: `${PIPELINE_FILE} is missing; run \`${options.command}\` to write it` };
  const actual = readFileSync(file, "utf-8");
  if (actual === expected) return { status: "current", file: PIPELINE_FILE };
  const folded = foldPipelineSource(actual, PIPELINE_FILE);
  const why = "finding" in folded ? `, and it does not fold: ${pipelineFindingLine(PIPELINE_FILE, folded.finding)}` : "";
  return {
    status: "stale",
    file: PIPELINE_FILE,
    message: `${PIPELINE_FILE} is not what the config writes${why}; run \`${options.command}\` and commit it`,
    diff: lineDiff(actual.split("\n"), expected.split("\n")),
  };
}

/** Write `text` to `.chant/pipeline.ts` in `dir`, creating `.chant`. Returns whether the file changed. */
export function writePipelineFile(dir: string, text: string): boolean {
  const file = join(dir, PIPELINE_FILE);
  if (existsSync(file) && readFileSync(file, "utf-8") === text) return false;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return true;
}
