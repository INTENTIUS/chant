/**
 * The helpers a product writes `.chant/pipeline.ts` with (#5324).
 *
 * A committed TypeScript file cannot read `terragucci.yml`, `plywood.yml` or
 * `yodel.config.ts` itself, so the product writes the file from its config,
 * the way it renders its workflows: {@link pipelineFromConfig} maps the
 * vocabulary's keys (`promotion`, `environments.<name>.gate`, `.hold`,
 * `.freeze`, `.failure_tolerance`, `.publish`, `.reads`, `.after`, `.queue`,
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
import type { GateQuorumRule } from "../op/gate-quorum";
import type { OpEnvironment } from "../lexicon";
import { foldPipelineSource, pipelineFindingLine, PIPELINE_MODULE } from "./fold";
import { lineDiff } from "./diff";
import { asPipelineSpec, PIPELINE_FILE, type PipelineDeclaration, type PipelineDefaults, type PipelineFailureTolerance, type PipelineFreezeWindow, type PipelineGate, type PipelineHold, type PipelineRelease, type PipelineStage, type PipelineWave } from "./spec";

/** One environment's settings, as a product's config spells them under `environments.<name>`, snake_case or camelCase. */
export interface PipelineEnvironmentConfig {
  gate?: PipelineGate["policy"];
  approval?: PipelineGate["approval"] | { mode?: PipelineGate["approval"] };
  approval_rules?: ApprovalRulesConfig;
  approvalRules?: ApprovalRulesConfig;
  hold?: boolean | { reason?: string; until?: string };
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
  [key: string]: unknown;
}

/** One approval rule as a config spells it: `count`, `roles`, `not_author`, `targets`. */
export interface ApprovalRuleConfig {
  count: number;
  roles?: string[];
  not_author?: boolean;
  notAuthor?: boolean;
  targets?: string[];
}

/** `approval_rules`: a list (terragucci) or a map of named rules (plywood). */
export type ApprovalRulesConfig = ApprovalRuleConfig[] | Record<string, ApprovalRuleConfig>;

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
}

function rulesOf(config: ApprovalRulesConfig | undefined): GateQuorumRule[] | undefined {
  if (config === undefined) return undefined;
  const list = Array.isArray(config) ? config : Object.keys(config).sort().map((k) => config[k]!);
  return list.map((r) => ({
    count: r.count,
    ...(r.roles ? { roles: [...r.roles] } : {}),
    ...(r.not_author ?? r.notAuthor ? { notAuthor: true } : {}),
    ...(r.targets ? { targets: [...r.targets] } : {}),
  }));
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

function holdOf(hold: PipelineEnvironmentConfig["hold"]): PipelineHold | undefined {
  if (hold === undefined || hold === false) return undefined;
  if (hold === true) return true;
  return { ...(hold.reason ? { reason: hold.reason } : {}), ...(hold.until ? { until: hold.until } : {}) };
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
    const gate: PipelineGate = { ...(policy ? { policy } : {}), ...(approval ? { approval } : {}), ...(quorum ? { quorum } : {}) };
    const hold = holdOf(env.hold);
    const tolerance = env.failure_tolerance ?? env.failureTolerance;
    const forgeRaw = env.forge_environment ?? env.forgeEnvironment;
    const forge = typeof forgeRaw === "string" ? { name: forgeRaw } : forgeRaw;
    return {
      name,
      ...(env.canary ? { canary: true } : {}),
      waves: waves.map((w) => structuredClone(w)),
      ...(Object.keys(gate).length > 0 ? { gate } : {}),
      ...(hold ? { hold } : {}),
      ...(env.freeze && env.freeze.length > 0 ? { freeze: env.freeze.map((w) => ({ ...w })) } : {}),
      ...(tolerance !== undefined ? { failureTolerance: tolerance } : {}),
      ...(forge ? { forgeEnvironment: forge } : {}),
      ...(publishOf(env.publish) ? { publish: publishOf(env.publish)! } : {}),
      ...(env.reads && Object.keys(env.reads).length > 0 ? { reads: Object.fromEntries(Object.entries(env.reads).map(([k, r]) => [k, { stage: r.stage, artifact: r.artifact }])) } : {}),
      ...(env.after && env.after.length > 0 ? { after: [...env.after] } : {}),
      ...(env.queue !== undefined ? { queue: env.queue } : {}),
    };
  });
  const declaration: PipelineDeclaration = {
    name: input.name,
    stages,
    ...(input.defaults ? { defaults: structuredClone(input.defaults) } : {}),
    ...(input.release ? { release: { ...input.release } } : {}),
    ...(input.control ? { control: structuredClone(input.control) } : {}),
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
