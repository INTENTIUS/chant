/**
 * `pulumi-up`, the pulumi lexicon's apply capability (#4541): a Pulumi or
 * plunge stack as a component step that plans and applies, the way
 * `terraform-apply` does a root. Ruling 1 on INTENTIUS/plywood#1 widened
 * #4450 and #4476 so chant runs `up`, from an apply job holding the apply
 * identity only; the argv go through `runApplyPulumi` and `runApplyPlunge`
 * (`./run.ts`), each one fixed form.
 *
 * The step is `{ kind: "pulumi-up", dir, stack }`, with optional `member`,
 * `config`, `engine`, `cwd`, `lockGrain` and `policyPacks`. One kind covers
 * both engines; `pulumiMemberEngine` (`./member-engine.ts`, #4559) picks
 * the binary from the step's `engine`, `plywood.yml`, `PULUMI_BACKEND_URL`
 * or `Pulumi.yaml`, and the artifact records which rule answered.
 *
 * ## plan
 *
 * The preview runs with `PULUMI_ENABLE_STREAMING_JSON_PREVIEW=true` (ruling
 * C), so one engine run gives the change set and CrossGuard's verdict
 * (`./engine-events.ts`). On plunge it also writes `--save-plan` into a
 * scratch directory under the OS temp dir, never the working tree, since the
 * file holds secret ciphertext. The plan answers:
 *
 * - `member`: `<member>/<stack>`, the name in the wave's set digest;
 * - `planDigest` and `changeSet` from `pulumiPreviewPart`; for a member on
 *   the resource lock grain (the step's `lockGrain`, else `ci.lockGrain`
 *   through `DeployContext.lockGrain`, else `resource` on plunge and
 *   `target` on stock Pulumi, #4552) the digest leaves `same` and `read`
 *   steps out (ruling B);
 * - `outputs` from the stack step's planned outputs;
 * - `shape` from `pulumiPlanShape` (`./plan-shape.ts`);
 * - `artifact`: the engine, the shape, the digest, CrossGuard's findings,
 *   and on plunge the plan file.
 *
 * A mandatory CrossGuard violation, or a preview Pulumi fails with its
 * policy code, throws {@link PulumiPolicyDeniedError}: no gate opens. Any
 * other failed preview throws, naming the engine's error.
 *
 * With `DeployContext.unresolvedInputs` set the member is a hole naming the
 * upstreams it waits on, as `terraform-apply`'s `waitingRoot` is. A stand-in
 * preview is later work.
 *
 * ## run
 *
 * - plunge, with the plan's artifact: `plunge up --plan <file> --yes --json
 *   --stack <s>`. plunge checks the plan's stamp and refuses a plan whose
 *   records moved, or one with no stamp, before anything changes (exit 40),
 *   which throws {@link PulumiPlanMovedError}: the table's moved code, 4.
 * - stock Pulumi, with the artifact: preview again and throw core's
 *   `PlanShapeMovedError` when the fresh shape goes beyond the approved one;
 *   then `pulumi up --yes --json --stack <s>`, and compare the steps in its
 *   event stream with the approved shape (ruling A). A difference fails the
 *   step with {@link PulumiAppliedShapeError}, whose message the apply
 *   record keeps. It is failed, never moved: resources changed.
 * - no approved plan (`chant run --components`, a release promote, a fan-out
 *   with no wave gate): preview and `up` in one go (ruling D), as
 *   `terraform-apply` does with no plan.
 *
 * Every engine exit goes through `pulumiExitOf` (`./exit-codes.ts`, #4553):
 * plunge's 40 is moved, Pulumi's policy code is denied, anything else is
 * failed with the stream's error and the URNs that landed.
 *
 * After `up`, the stack's outputs come from `stack output --json
 * --show-secrets=false`, secrets as `[secret]`. Then `stack export --stack
 * <s>` runs, its secrets are stripped, and it goes to the index store as
 * the member's snapshot (#4546, `./stack-export-snapshot.ts`), at
 * `<env>/<stack>__pulumi-export` on `refs/chant/snapshots` by default. The
 * graph and the member's reads take it from there, so the member needs no
 * checked-in `stack-export.json`. A failed export or write leaves the apply
 * standing and says why in `exportSnapshot`.
 *
 * ## policy packs at base (#4613)
 *
 * Under a pull request or an op wave the caller sets
 * `DeployContext.policyBase`, and the plan copies its CrossGuard packs out
 * of that commit into the step's scratch directory before the preview
 * (`@intentius/chant/policy-packs`): every `ci.policy.packs` entry of the
 * declaration at base (or of `ci.policy.source`), then each step pack that
 * is in the repository. A step pack the base lacks, or one that differs on
 * the head, is a note on stderr and in the artifact; the base's copy is the
 * one that runs. `run` hands `up` the same copies. A base or source that
 * cannot be read throws, so no gate opens on a plan no policy judged.
 *
 * ## config
 *
 * `config` (a dependent's `stackOutput()` wiring) is written into a scratch
 * copy of `Pulumi.<stack>.yaml` and passed with `--config-file`; `--config`
 * is never used, since it saves into the working tree's file. A key with no
 * `:` is the project's own (`<project>:<key>`).
 *
 * ## StackReference (#4547)
 *
 * `declaredReads` reads each step's export for its `StackReference`s
 * (`./stack-references.ts`) and reports each as a read of the other
 * `pulumi-up` step that applies the referenced stack, so core orders the
 * reader after it, holds the reader when it fails, and leaves the reader a
 * hole while the upstream's plan cannot say an output it reads. A reference
 * to a stack no step applies adds no edge and is named on the plan's
 * artifact under `stackReferences.outside`.
 *
 * ## releases (#4542)
 *
 * `releaseInputs` answers the stack's directory, so a release cut records it
 * and a promote or rollback under the release previews and applies the
 * recorded copy, under the release gate with that copy's plan. A stack whose
 * backend is a file path relative to its directory is unbound: a copy
 * elsewhere would read no state.
 *
 * The cut records tracked files, so a Node program's copy has no
 * `node_modules`. Before the copy's first preview, `plan` and `run` call
 * `prepareProgram` (`./release-copy.ts`), which runs `pulumi install`
 * (`plunge install`) in the copy when its runtime needs one, and refuses a
 * Node copy with no lockfile by name, since an install would take today's
 * versions rather than the release's.
 *
 * A CI job's checkout has the same gap, so the same call prepares the
 * step's own directory by the same rule (plywood#22): a Node program with
 * no `node_modules` in its directory or above it, and a lockfile beside its
 * package.json, gets one `<engine> install` before the job's first engine
 * run; with no lockfile the step refuses by name.
 *
 * ## review stacks (#4609)
 *
 * When `DeployContext.env` is a pull request's environment `pr-<n>` (`chant
 * components pr-env up`), the step applies its review stack instead of its
 * own: the step's stack with the last segment replaced by `pr-<n>` (or
 * `pr-<n>-<reviewSuffix>`), so `acme/shop/dev` becomes `acme/shop/pr-12`.
 * Before the first preview, `plan` runs `stack init <pr-stack> --no-select
 * --copy-config-from <template>` (`initReviewStack`, `./review-stack.ts`),
 * where the template is `CHANT_ENV_TEMPLATE`'s stack when it names a stack of
 * this project (`<project>/<stack>`, plywood's `review_stacks.template`),
 * else the step's own stack. A stack that exists already is updated. The
 * plan gives core the stack's `location`, `<engine>:<dir>#<stack>`, which
 * `pr-env up` keeps on the environment's record and `pr-env down` and the
 * TTL sweep read back to destroy and remove it (`reviewStackTeardown`).
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { ChangeSetPart } from "@intentius/chant/change-set";
import type {
  Capability,
  CapabilityPlan,
  DeclaredRead,
  DeclaredReadMember,
  DeclaredReadsContext,
  DeployContext,
  ReleaseInputs,
  ReleaseInputsContext,
  ReleaseInputsUnbound,
} from "@intentius/chant/components/capability";
import { PlanShapeMovedError, type PlanShape } from "@intentius/chant/components/covered-round";
import type { GatePolicyFindings } from "@intentius/chant/gate-policy";
import { computePlanDigest } from "@intentius/chant/lifecycle/plan-digest";
import type { SnapshotStore } from "@intentius/chant/lifecycle/snapshot-store";
import { parseYAML } from "@intentius/chant/yaml";
import { pulumiPreviewPart } from "./change-set";
import {
  PULUMI_STREAMING_PREVIEW_ENV,
  pulumiAppliedSteps,
  pulumiFailedUrns,
  pulumiLandedUrns,
  pulumiPolicyEvents,
  pulumiPolicyFindings,
  pulumiStreamError,
  pulumiStreamPreview,
  pulumiStreamSummary,
  pulumiStreamTimings,
  type PulumiApplySummary,
} from "./engine-events";
import { CHANT_EXIT } from "@intentius/chant/exit-codes";
import { pulumiExitOf } from "./exit-codes";
import { pulumiMemberEngine, type PulumiMemberEngine, type PulumiMemberEngineSource } from "./member-engine";
import { ciEngineDir, ciRelease, CI_ENGINE_ROOT } from "./ci-setup";
import { pulumiMemberPlannedOutputs } from "./member-outputs";
import type { PulumiOutputChange } from "./planned-output-changes";
import { pulumiPlanShape, pulumiShapeDifferences } from "./plan-shape";
import { pulumiLockRows } from "./lock-rows";
import { stackRowKey } from "@intentius/chant/lifecycle/lock-rows";
import { pulumiTraceFacts } from "./trace-facts";
import {
  defaultPlungeRunner,
  defaultPulumiRunner,
  engineRunnerAt,
  plungeUpArgs,
  pulumiMemberStackOutputs,
  pulumiRunFailure,
  pulumiUpArgs,
  pulumiUpPreviewArgs,
  memberExportOf,
  runAllowedPlunge,
  runAllowedPulumi,
  runApplyPlunge,
  runApplyPulumi,
  type PulumiPolicyPack,
  type PulumiRunner,
} from "./run";
import type { PulumiStep } from "./change-set";
import { writePulumiExportSnapshot, type PulumiExportWrite } from "./stack-export-snapshot";
import { pointerSegment, pulumiStackReferences, stackReferenceOwner } from "./stack-references";
import { isObject } from "./values";
import { prepareProgram } from "./release-copy";
import { initReviewStack, reviewConfigSource, reviewStackFor, reviewStackLocation } from "./review-stack";

/** The lock grain values of `ci.lockGrain` (#4552's ruling A). */
export type PulumiLockGrain = "target" | "resource" | "repo";

/** The `pulumi-up` step's input. */
export interface PulumiUpStepInput {
  /** The stack's directory, where `Pulumi.yaml` is. Relative paths resolve against `cwd`. */
  dir: string;
  /** The stack to preview and apply, passed as `--stack`. */
  stack: string;
  /** The member's name in the set digest. Default: `Pulumi.yaml`'s `name`, else the directory's name. */
  member?: string;
  /** Stack config values, written into a scratch copy of `Pulumi.<stack>.yaml` (never `--config`). */
  config?: Record<string, unknown>;
  /** `pulumi` or `plunge`; see `pulumiMemberEngine`. */
  engine?: PulumiMemberEngine;
  /**
   * The stack's backend URL (INTENTIUS/plywood#22), such as
   * `plunge+s3://...` or `s3://...`: every engine command the step runs
   * (preview, up, the stack output and export reads, a review stack's init)
   * gets it as `PULUMI_BACKEND_URL`, over the job's own. It also answers the
   * engine where `pulumiMemberEngine` would read `PULUMI_BACKEND_URL`.
   * Absent: the job's `PULUMI_BACKEND_URL` or `Pulumi.yaml`'s, as before.
   */
  backend?: string;
  /**
   * The engine release this stack is pinned to (#4592): the step runs
   * `<engineRoot>/<engine>-<engineVersion>/<engine>`, the path the pulumi
   * lexicon's install lines write (`pulumiInstallLine`, `plungeInstallLine`,
   * `ciEngineDir`), instead of the binary on PATH. A semver such as
   * `3.272.0`, or for plunge its own release such as `0.1.0`. Absent: the
   * binary on PATH, as before.
   */
  engineVersion?: string;
  /** Where the versioned installs live, as the install lines' `root` (#4592). Default `/opt/chant`. Needs `engineVersion`. */
  engineRoot?: string;
  /** Where a relative `dir` resolves from. Default: the process's working directory. */
  cwd?: string;
  /** The member's lock grain (#4552), over `ci.lockGrain`. Default: `ci.lockGrain`, else `resource` on plunge, `target` on stock Pulumi. */
  lockGrain?: PulumiLockGrain;
  /**
   * CrossGuard packs for the preview and `up` (ruling 7). Under a pull
   * request or an op wave (`DeployContext.policyBase`, #4613) each one in
   * the repository is read at base, and `ci.policy.packs` at base is added.
   */
  policyPacks?: PulumiPolicyPack[];
  /**
   * The outputs of other stacks this stack's program reads through
   * `StackReference` (#4547), by the reference's name, then output. Core
   * writes them from `declaredReads` as `stackOutput()` references, so the
   * stack plans after the ones it reads and waits while their plans cannot
   * say a value. Never passed to the engine: the program reads them itself.
   */
  stackReferences?: Record<string, Record<string, unknown>>;
  /**
   * In a pull request's environment (#4609), the review stack is
   * `pr-<n>-<reviewSuffix>` rather than `pr-<n>`: lowercase letters, digits
   * and `-`, as plywood's `review_stacks.name` allows. Ignored elsewhere.
   */
  reviewSuffix?: string;
}

/** What `run` returns. */
export interface PulumiUpStepOutput {
  /** `<member>/<stack>`. */
  member: string;
  stack: string;
  engine: PulumiMemberEngine;
  planDigest: string;
  /** Whether `run` applied the plan the wave handed it, rather than one it made itself. */
  fromWavePlan: boolean;
  /** `stack output --json --show-secrets=false` after `up`, secrets as `[secret]`. */
  outputs: Record<string, unknown>;
  /** The `summaryEvent` of `up --json`, with plunge's timings when present. */
  summary?: PulumiApplySummary;
  /** CrossGuard's findings from the preview the apply ran under. */
  policy?: GatePolicyFindings;
  /** The stack export written to the index store after `up` (#4546), or why it was not. */
  exportSnapshot?: PulumiExportWrite;
}

/** What `plan` hands `run` through `DeployContext.plans[member]`. */
export interface PulumiUpArtifact {
  kind: "pulumi-up";
  member: string;
  stack: string;
  engine: PulumiMemberEngine;
  /** The rule `pulumiMemberEngine` answered with (#4559), for the plan output. */
  engineSource: PulumiMemberEngineSource;
  engineBecause: string;
  planDigest: string;
  shape: PlanShape;
  /** The scratch directory holding the plan file and config copy. */
  scratch: string;
  /** plunge's saved plan. plunge only. */
  planFile?: string;
  /** The scratch copy of the stack's config, when the step has `config`. */
  configFile?: string;
  /** CrossGuard's findings from the plan's preview. */
  policy: GatePolicyFindings;
  /**
   * The packs the preview ran when they were read at base (#4613): the
   * commit, each pack's copy under `scratch` and where it came from, the
   * notes on step packs left out or read from base, and the shared source
   * `ci.policy.packs` came from. `run` passes the same copies to `up`.
   */
  policyPacks?: PulumiUpPolicyPacks;
  /**
   * The stack's `StackReference`s (#4547): `read`, wired to another step of
   * the project, and `outside`, which add no edge, each with why.
   * `lastUpdate` is when the stack last updated, from its export's
   * `deployment.manifest.time` (#4617): the pull request note compares it
   * with the control repo's record of the owner's last apply to mark each
   * outside reference stale, current or unknown.
   */
  stackReferences?: { read: string[]; outside: { name: string; why: string }[]; lastUpdate?: string };
  /**
   * Each stack output's verdict from the preview (#4635,
   * `./planned-output-changes.ts`): `changing` and `untraced` ones are
   * unknown to the stacks that read them, `unchanged` ones keep the
   * export's value. Absent when the preview planned nothing to apply.
   */
  plannedOutputs?: PulumiOutputChange[];
}

/** The CrossGuard packs a plan read at base (#4613). */
export interface PulumiUpPolicyPacks {
  base: string;
  packs: Array<{ dir: string; config?: string; from: "declaration" | "step"; name: string }>;
  notes: string[];
  source?: { repo: string; ref: string; commit: string; path: string };
}

/**
 * The packs a preview runs (#4613). With `ctx.policyBase` each step pack in
 * the repository and every `ci.policy.packs` entry is copied from base into
 * `scratch`, and the notes say which step packs did not run as the head has
 * them. Without it, the step's packs as they stand. Throws when the base or
 * the policy source cannot be read: the preview then does not run.
 */
async function policyPacksFor(ctx: DeployContext, r: Pick<Resolved, "dir" | "member">, input: PulumiUpStepInput, scratch: string): Promise<{ packs: PulumiPolicyPack[]; read?: PulumiUpPolicyPacks }> {
  const own = input.policyPacks ?? [];
  if (!ctx.policyBase) return { packs: own };
  let mod: typeof import("@intentius/chant/policy-packs") | undefined;
  try {
    mod = await import("@intentius/chant/policy-packs");
  } catch {
    mod = undefined;
  }
  if (!mod) throw new Error(`pulumi-up: "${r.member}": the policy packs are read at base ${ctx.policyBase.slice(0, 12)}, and this chant has no reader for them; update @intentius/chant`);
  const got = await mod.policyPacksAtBase({ cwd: r.dir, base: ctx.policyBase, stepPacks: own, tmp: scratch });
  if ("error" in got) throw new Error(`pulumi-up: "${r.member}": ${got.error}, so the preview did not run`);
  for (const note of got.notes) console.error(`pulumi-up: "${r.member}": ${note}`);
  if (got.source) console.error(`pulumi-up: "${r.member}": ci.policy.packs read from ${got.source.repo}@${got.source.ref} at commit ${got.source.commit}`);
  const read: PulumiUpPolicyPacks = {
    base: got.base,
    packs: got.packs.map((p) => ({ dir: p.dir, ...(p.config ? { config: p.config } : {}), from: p.from, name: p.name })),
    notes: got.notes,
    ...(got.source ? { source: { ...got.source } } : {}),
  };
  return { packs: got.packs.map((p) => ({ dir: p.dir, ...(p.config ? { config: p.config } : {}) })), read };
}

/** plunge refused a saved plan whose records moved, or one with no stamp (exit 40). `planMoved` is core's moved mark. */
export class PulumiPlanMovedError extends Error {
  readonly planMoved = true;
  constructor(
    public readonly member: string,
    message: string,
  ) {
    super(message);
    this.name = "PulumiPlanMovedError";
  }
}

/** CrossGuard denied the plan: a mandatory violation, or the engine's policy exit. No gate opens. */
export class PulumiPolicyDeniedError extends Error {
  readonly policyDenied = true;
  /** The table's code for it (#4553, ruling B: 7 everywhere). */
  readonly exitCode = CHANT_EXIT.denied;
  constructor(
    public readonly member: string,
    public readonly findings: GatePolicyFindings,
    detail?: string,
  ) {
    const denied = findings.denials.map((d) => `${d.rule}: ${d.message}`).join("; ");
    super(`"${member}": CrossGuard denied the plan${denied ? `: ${denied}` : ""}${detail ? ` (${detail})` : ""}`);
    this.name = "PulumiPolicyDeniedError";
  }
}

/**
 * A stock `pulumi up` ran steps the approved shape does not hold (ruling A).
 * The update has run, so this is a failure, not a moved plan: the step fails
 * and the differences land on the apply record through the message.
 */
export class PulumiAppliedShapeError extends Error {
  constructor(
    public readonly member: string,
    public readonly differences: string[],
    public readonly summary?: PulumiApplySummary,
  ) {
    super(`"${member}": pulumi up ran steps the approved plan did not hold: ${differences.join("; ")}. The update ran; check the stack and plan it again.`);
    this.name = "PulumiAppliedShapeError";
  }
}

/**
 * An `up` that failed (#4553's failed outcome). It carries the stream's
 * summary, plunge's per-resource timings included (#4579), so the run record
 * and the trace (`./trace-facts.ts` reads `member` and `summary` off the
 * error) keep what ran before it stopped.
 */
export class PulumiUpFailedError extends Error {
  constructor(
    public readonly member: string,
    message: string,
    public readonly summary?: PulumiApplySummary,
  ) {
    super(message);
    this.name = "PulumiUpFailedError";
  }
}

/** A stock Pulumi member set to the resource grain (#4552): the backend's stack lock already orders its updates. */
export class PulumiResourceGrainRefusedError extends Error {
  constructor(public readonly member: string) {
    super(`"${member}": the resource lock grain needs plunge; a stock Pulumi stack keeps the stack grain, since its backend's stack lock orders updates (ci.lockGrain: target)`);
    this.name = "PulumiResourceGrainRefusedError";
  }
}

/** The default lock grain for an engine (#4552's design): resource on plunge, the stack (target) on stock Pulumi. */
export function pulumiDefaultLockGrain(engine: PulumiMemberEngine): PulumiLockGrain {
  return engine === "plunge" ? "resource" : "target";
}

/** Runners and scratch, injectable so the tests run no binary. */
export interface PulumiUpOptions {
  run?: PulumiRunner;
  plunge?: PulumiRunner;
  /** The runner for a pinned binary (#4592), by its path. Default: {@link engineRunnerAt}. */
  runAt?: (bin: string) => PulumiRunner;
  /** The job environment the engine is picked from. Default: `process.env`. */
  env?: Record<string, string | undefined>;
  /** Where scratch directories go. Default: the OS temp dir. */
  tmp?: string;
  /** The index store the stack export goes to after `up` and the prior export is read from (#4546). Default: the project's; `null` writes nothing and reads the checked-in file only. */
  snapshots?: SnapshotStore | null;
}

const STREAMING = { [PULUMI_STREAMING_PREVIEW_ENV]: "true" };

function stackDir(input: PulumiUpStepInput): string {
  return isAbsolute(input.dir) ? input.dir : resolve(input.cwd ?? process.cwd(), input.dir);
}

function readProject(dir: string): Record<string, unknown> | undefined {
  for (const name of ["Pulumi.yaml", "Pulumi.yml"]) {
    const file = join(dir, name);
    if (!existsSync(file)) continue;
    try {
      return parseYAML(readFileSync(file, "utf-8"));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function requireInput(input: PulumiUpStepInput): void {
  if (typeof input?.dir !== "string" || input.dir === "") throw new Error('pulumi-up: the step needs "dir", the directory holding Pulumi.yaml');
  if (typeof input.stack !== "string" || input.stack === "" || input.stack.startsWith("-")) throw new Error('pulumi-up: the step needs "stack", the stack to apply');
}

/** `<member>/<stack>`: the member's name in the wave's set digest. */
export function pulumiUpMember(input: PulumiUpStepInput): string {
  const dir = stackDir(input);
  const named = input.member ?? (readProject(dir)?.name as string | undefined) ?? basename(dir);
  return `${named}/${input.stack}`;
}

/**
 * The stack's config with `config` written over it, as the text of a
 * `Pulumi.<stack>.yaml` (JSON, which YAML reads). A key with no `:` is the
 * project's own. A value left `undefined` or `null` is not written.
 */
export function pulumiScratchConfig(dir: string, stack: string, config: Record<string, unknown>): string {
  const project = readProject(dir)?.name;
  const file = join(dir, `Pulumi.${stack}.yaml`);
  let doc: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      doc = parseYAML(readFileSync(file, "utf-8")) ?? {};
    } catch (err) {
      throw new Error(`pulumi-up: ${file} does not read as YAML, so its config cannot be copied: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const merged: Record<string, unknown> = { ...((doc.config as Record<string, unknown> | undefined) ?? {}) };
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined || value === null) continue;
    const full = key.includes(":") || typeof project !== "string" ? key : `${project}:${key}`;
    merged[full] = value;
  }
  return `${JSON.stringify({ ...doc, config: merged }, null, 2)}\n`;
}

/** The variable `pr-env up` sets to `ci.prEnvironment.template` (core's `PR_ENV_TEMPLATE_VAR`). */
export const PR_ENV_TEMPLATE_VARIABLE = "CHANT_ENV_TEMPLATE";

/**
 * The step as it applies in `env` (#4609): with its review stack in place of
 * its own stack in a pull request's environment, and the stack it copies its
 * config from. The step unchanged, with no review, anywhere else.
 */
export function pulumiReviewStep(input: PulumiUpStepInput, env: string | undefined, template?: string): { step: PulumiUpStepInput; review?: { stack: string; copyConfigFrom?: string } } {
  requireInput(input);
  const stack = reviewStackFor(input.stack, env, input.reviewSuffix);
  if (!stack) return { step: input };
  const project = readProject(stackDir(input))?.name;
  const copyConfigFrom = reviewConfigSource({ stack: input.stack, ...(typeof project === "string" ? { project } : {}) }, template, stack);
  return { step: { ...input, stack }, review: { stack, ...(copyConfigFrom ? { copyConfigFrom } : {}) } };
}

function templateOf(opts: PulumiUpOptions): string | undefined {
  const v = (opts.env ?? process.env)[PR_ENV_TEMPLATE_VARIABLE];
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** The review stack's location on the environment's record: `<engine>:<dir>#<stack>`, `dir` relative to the working directory core runs in. */
function locationOf(r: Resolved, stack: string): string {
  return reviewStackLocation(r.engine, relative(process.cwd(), r.dir) || ".", stack);
}

/** A plan file name with nothing a path could read into. */
const fileSafe = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, "_");

/** What one streamed preview gave. */
interface StackPreview {
  part: ChangeSetPart;
  preview: { steps: PulumiStep[] };
  shape: PlanShape;
  policy: GatePolicyFindings;
  prior: unknown;
}

interface Resolved {
  dir: string;
  member: string;
  engine: PulumiMemberEngine;
  /** The pinned binary's absolute path (#4592), when the step names `engineVersion`. */
  engineBin?: string;
  engineSource: PulumiMemberEngineSource;
  engineBecause: string;
  grain: PulumiLockGrain;
  /** The step's `backend`, every engine command's `PULUMI_BACKEND_URL`. */
  backend?: string;
}

/** The environment the engine is picked from: the job's, with the step's backend as `PULUMI_BACKEND_URL`. */
function engineEnv(input: Pick<PulumiUpStepInput, "backend">, opts: PulumiUpOptions): { env?: Record<string, string | undefined> } {
  if (input.backend === undefined) return opts.env ? { env: opts.env } : {};
  return { env: { ...(opts.env ?? process.env), PULUMI_BACKEND_URL: input.backend } };
}

/** `run` with `PULUMI_BACKEND_URL` set to the step's backend over whatever env the call passes. */
function withBackend(run: PulumiRunner, backend: string): PulumiRunner {
  return (args, o) => run(args, { ...o, env: { ...(o.env ?? {}), PULUMI_BACKEND_URL: backend } });
}

function resolveStep(input: PulumiUpStepInput, opts: PulumiUpOptions, declared?: PulumiLockGrain): Resolved {
  requireInput(input);
  if (input.backend !== undefined && (typeof input.backend !== "string" || input.backend.trim() === "")) {
    throw new Error('pulumi-up: "backend" is the stack\'s backend URL, such as plunge+s3://<bucket> or s3://<bucket>');
  }
  const dir = stackDir(input);
  const member = pulumiUpMember(input);
  const picked = pulumiMemberEngine(dir, input.engine, engineEnv(input, opts));
  // #4552: the step's own grain, else ci.lockGrain as the caller read it at base, else the engine's default.
  const grain = input.lockGrain ?? declared ?? pulumiDefaultLockGrain(picked.engine);
  if (grain === "resource" && picked.engine === "pulumi") throw new PulumiResourceGrainRefusedError(member);
  const engineBin = pulumiUpEngineBin(input, picked.engine);
  return { dir, member, engine: picked.engine, ...(engineBin ? { engineBin } : {}), engineSource: picked.source, engineBecause: picked.because, grain, ...(input.backend ? { backend: input.backend } : {}) };
}

/**
 * The binary a step pinned with `engineVersion` runs (#4592): the versioned
 * path the install lines write. Undefined without `engineVersion`, so the
 * binary on PATH runs. A version or root a shell or path would read as
 * more is refused, as the install lines refuse it.
 */
export function pulumiUpEngineBin(input: Pick<PulumiUpStepInput, "engineVersion" | "engineRoot">, engine: PulumiMemberEngine): string | undefined {
  if (input.engineVersion === undefined) {
    if (input.engineRoot !== undefined) throw new Error('pulumi-up: "engineRoot" needs "engineVersion", the release installed under it');
    return undefined;
  }
  try {
    ciRelease(engine, input.engineVersion);
    return `${ciEngineDir(engine, input.engineVersion, input.engineRoot ?? CI_ENGINE_ROOT)}/${engine}`;
  } catch (err) {
    throw new Error(`pulumi-up: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The `run` and `plunge` options for the stack output and export reads: the pinned binary's for both when the step names one (#4592), else the caller's. */
function runnerOptions(r: Pick<Resolved, "engineBin" | "backend">, opts: PulumiUpOptions): { run?: PulumiRunner; plunge?: PulumiRunner } {
  if (r.engineBin || r.backend) {
    const { pulumi, plunge } = runnersFor(r, opts);
    return { run: pulumi, plunge };
  }
  return { ...(opts.run ? { run: opts.run } : {}), ...(opts.plunge ? { plunge: opts.plunge } : {}) };
}

/** The runners a resolved step uses: the pinned binary's when it names one, else the options' or the PATH default. */
function runnersFor(r: Pick<Resolved, "engineBin" | "backend">, opts: PulumiUpOptions): { pulumi: PulumiRunner; plunge: PulumiRunner } {
  let out: { pulumi: PulumiRunner; plunge: PulumiRunner };
  if (r.engineBin) {
    const pinned = opts.runAt ? opts.runAt(r.engineBin) : engineRunnerAt(r.engineBin);
    out = { pulumi: pinned, plunge: pinned };
  } else {
    out = { pulumi: opts.run ?? defaultPulumiRunner, plunge: opts.plunge ?? defaultPlungeRunner };
  }
  // plywood#22: the step's backend reaches every command, whichever call site runs it.
  return r.backend ? { pulumi: withBackend(out.pulumi, r.backend), plunge: withBackend(out.plunge, r.backend) } : out;
}

/** The scratch directory, the config copy in it and plunge's plan file path. */
function scratchFor(r: Resolved, input: PulumiUpStepInput, opts: PulumiUpOptions): { scratch: string; configFile?: string; planFile?: string } {
  const scratch = mkdtempSync(join(opts.tmp ?? tmpdir(), "chant-pulumi-up-"));
  let configFile: string | undefined;
  if (input.config && Object.keys(input.config).length > 0) {
    configFile = join(scratch, `Pulumi.${input.stack}.yaml`);
    writeFileSync(configFile, pulumiScratchConfig(r.dir, input.stack, input.config), { mode: 0o600 });
  }
  const planFile = r.engine === "plunge" ? join(scratch, `${fileSafe(r.member)}.plan.json`) : undefined;
  return { scratch, ...(configFile ? { configFile } : {}), ...(planFile ? { planFile } : {}) };
}

function dropScratch(scratch: string | undefined): void {
  if (!scratch) return;
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    // A scratch dir that stays behind holds nothing a later run reads.
  }
}

/** The streamed preview, as part, shape and CrossGuard findings. Throws for a failed preview or a denial. */
async function previewStack(
  ctx: DeployContext,
  r: Resolved,
  input: PulumiUpStepInput,
  opts: PulumiUpOptions,
  files: { configFile?: string; planFile?: string; policyPacks?: readonly PulumiPolicyPack[] },
): Promise<StackPreview> {
  const targets = ctx.targets && ctx.targets.length > 0 ? ctx.targets : undefined;
  // #4613: the packs read at base when the caller gave them, else the step's as they stand.
  const packs = files.policyPacks ?? input.policyPacks ?? [];
  const args = pulumiUpPreviewArgs({
    stack: input.stack,
    ...(files.planFile ? { savePlan: files.planFile } : {}),
    ...(files.configFile ? { configFile: files.configFile } : {}),
    // #4627: --refresh and --target-dependents pass to the preview as they came.
    ...(ctx.refresh ? { refresh: true } : {}),
    ...(targets ? { targets } : {}),
    ...(targets && ctx.targetDependents ? { targetDependents: true } : {}),
    ...(packs.length ? { policyPacks: packs } : {}),
  });
  let stdout: string;
  try {
    ({ stdout } =
      r.engine === "plunge"
        ? await runAllowedPlunge(runnersFor(r, opts).plunge, args, r.dir, STREAMING)
        : await runAllowedPulumi(runnersFor(r, opts).pulumi, args, r.dir, STREAMING));
  } catch (err) {
    const f = pulumiRunFailure(err);
    if (f.missingBinary) throw new Error(`pulumi-up: "${r.member}": the ${r.engine} binary was not found on PATH; install ${r.engine} to plan this stack`);
    const stream = f.stdout ?? "";
    const policy = pulumiPolicyFindings(pulumiPolicyEvents(stream));
    if (policy.denials.length > 0 || pulumiExitOf(f.exitCode) === CHANT_EXIT.denied) throw new PulumiPolicyDeniedError(r.member, policy, pulumiStreamError(stream));
    const why = pulumiStreamError(stream) ?? (f.stderr?.trim() || f.message);
    throw new Error(`pulumi-up: "${r.member}": ${r.engine} preview failed: ${why}`);
  }
  const preview = pulumiStreamPreview(stdout);
  const policy = pulumiPolicyFindings(pulumiPolicyEvents(stdout));
  // A mandatory violation that left the exit at 0 still denies: the gate reads the events, never the code alone.
  if (policy.denials.length > 0) throw new PulumiPolicyDeniedError(r.member, policy);
  const prior = await memberExportOf(r.dir, { stack: input.stack, ...(opts.snapshots !== undefined ? { store: opts.snapshots } : {}) });
  const part = pulumiPreviewPart({
    member: r.member,
    preview,
    stack: input.stack,
    ...(prior !== undefined ? { prior } : {}),
    ...(targets ? { targeted: true } : {}),
    ...(r.grain === "resource" ? { digest: { changedOnly: true } } : {}),
  });
  const shape = pulumiPlanShape(part, r.member);
  return { part, preview, shape, policy, prior };
}

/** The member of a stack whose `config` or `StackReference`s read outputs not known yet: a hole naming them, no plan. */
function waitingStack(ctx: DeployContext, r: Resolved, input: PulumiUpStepInput, unresolved: string[]): CapabilityPlan {
  const config = Object.fromEntries(Object.entries(input.config ?? {}).map(([k, v]) => [k, v === undefined ? null : v]));
  const planDigest = computePlanDigest("pulumi-up-unresolved", { env: ctx.env, member: r.member, stack: input.stack, config, unresolved });
  const changeSet: ChangeSetPart = {
    member: {
      member: r.member,
      lexicon: "pulumi",
      planner: "pulumi",
      scope: input.stack,
      status: "planned",
      planDigest,
      holes: [
        {
          address: r.member,
          type: "pulumi:pulumi:Stack",
          reason: `the stack reads ${unresolved.join(", ")}, known only once ${unresolved.length === 1 ? "that applies" : "those apply"}; it is planned again then`,
        },
      ],
    },
    entries: [],
  };
  return { member: r.member, planDigest, changeSet, ...(ctx.targets?.length ? { targets: ctx.targets } : {}) };
}

function isArtifact(value: unknown): value is PulumiUpArtifact {
  const v = value as Partial<PulumiUpArtifact> | undefined;
  return v?.kind === "pulumi-up" && typeof v.planDigest === "string" && typeof v.shape === "object" && v.shape !== null;
}

/** The program's directory, a release's copy (#4542) or the checkout in place (plywood#22), made runnable before its first engine run. */
async function readyProgram(r: Resolved, opts: PulumiUpOptions): Promise<void> {
  const runners = runnersFor(r, opts);
  await prepareProgram({ dir: r.dir, member: r.member, engine: r.engine, run: r.engine === "plunge" ? runners.plunge : runners.pulumi });
}

async function planStack(ctx: DeployContext, original: PulumiUpStepInput, opts: PulumiUpOptions): Promise<CapabilityPlan> {
  // #4609: in pr-<n>, the review stack, made from the template before its first preview.
  const { step: input, review } = pulumiReviewStep(original, ctx.env, templateOf(opts));
  const r = resolveStep(input, opts, ctx.lockGrain);
  const location = review ? { location: locationOf(r, review.stack) } : {};
  const unresolved = [...(ctx.unresolvedInputs ?? [])].sort();
  if (unresolved.length > 0) return { ...waitingStack(ctx, r, input, unresolved), ...location };
  await readyProgram(r, opts);
  if (review) {
    const runners = runnersFor(r, opts);
    await initReviewStack({
      dir: r.dir,
      stack: review.stack,
      engine: r.engine,
      run: r.engine === "plunge" ? runners.plunge : runners.pulumi,
      ...(review.copyConfigFrom ? { template: review.copyConfigFrom } : {}),
    });
  }
  const files = scratchFor(r, input, opts);
  let read: StackPreview;
  let packs: Awaited<ReturnType<typeof policyPacksFor>>;
  try {
    packs = await policyPacksFor(ctx, r, input, files.scratch);
    read = await previewStack(ctx, r, input, opts, { ...files, policyPacks: packs.packs });
  } catch (err) {
    dropScratch(files.scratch);
    throw err;
  }
  const planDigest = read.part.member.planDigest!;
  const references = stackReferencesOf(read.prior, input);
  const planned = pulumiMemberPlannedOutputs(r.member, {
    part: read.part,
    preview: read.preview,
    ...(read.prior !== undefined ? { exported: read.prior } : {}),
    ...(ctx.targets?.length ? { targeted: true } : {}),
  });
  const artifact: PulumiUpArtifact = {
    kind: "pulumi-up",
    member: r.member,
    stack: input.stack,
    engine: r.engine,
    engineSource: r.engineSource,
    engineBecause: r.engineBecause,
    planDigest,
    shape: read.shape,
    scratch: files.scratch,
    ...(files.planFile ? { planFile: files.planFile } : {}),
    ...(files.configFile ? { configFile: files.configFile } : {}),
    policy: read.policy,
    ...(packs.read ? { policyPacks: packs.read } : {}),
    ...(references ? { stackReferences: references } : {}),
    ...(planned.outputChanges ? { plannedOutputs: planned.outputChanges } : {}),
  };
  return {
    member: r.member,
    planDigest,
    artifact,
    changeSet: read.part,
    outputs: { known: planned.known, unknown: planned.unknown },
    shape: read.shape,
    ...(ctx.targets?.length ? { targets: ctx.targets } : {}),
    ...location,
  };
}

/** The export's `StackReference`s, split into the ones core wired into `stackReferences` and the rest; undefined when it holds none. */
function stackReferencesOf(exported: unknown, input: PulumiUpStepInput): PulumiUpArtifact["stackReferences"] | undefined {
  const refs = pulumiStackReferences(exported);
  if (refs.length === 0) return undefined;
  const wired = new Set(Object.keys(input.stackReferences ?? {}));
  const read = refs.filter((r) => wired.has(r.name)).map((r) => r.name);
  const outside = refs
    .filter((r) => !wired.has(r.name))
    .map((r) => ({
      name: r.name,
      why:
        r.outputs.length === 0 && r.secretOutputs.length > 0
          ? "every output the export recorded for it is secret, and chant reads outputs blind"
          : r.outputs.length === 0
            ? "the export recorded no output for it"
            : "no other pulumi-up step in this project applies that stack",
    }));
  const lastUpdate = exportUpdatedAt(exported);
  return { read: [...new Set(read)].sort(), outside, ...(lastUpdate ? { lastUpdate } : {}) };
}

/** When the exported stack last updated (#4617): `deployment.manifest.time`, when it is a time. */
export function exportUpdatedAt(exported: unknown): string | undefined {
  const deployment = isObject(exported) && isObject(exported.deployment) ? exported.deployment : undefined;
  const time = deployment && isObject(deployment.manifest) ? deployment.manifest.time : undefined;
  return typeof time === "string" && !Number.isNaN(Date.parse(time)) ? time : undefined;
}

/**
 * `declaredReads` (#4547): each step's `StackReference`s, read from its
 * export (the index store's, else the checked-in one), as reads of the one
 * other `pulumi-up` step whose project and stack the reference names, one
 * per output the export recorded that is not secret, placed at
 * `/stackReferences/<reference name>/<output>`.
 */
export async function pulumiDeclaredReads(
  ctx: DeclaredReadsContext,
  members: readonly DeclaredReadMember[],
  opts: { exportStore?: SnapshotStore | null } = {},
): Promise<DeclaredRead[]> {
  const steps = members
    .map((m) => {
      const step = m.step as unknown as PulumiUpStepInput;
      if (typeof step?.dir !== "string" || typeof step.stack !== "string") return undefined;
      const dir = isAbsolute(step.dir) ? step.dir : resolve(ctx.root, step.cwd ?? ".", step.dir);
      const project = readProject(dir)?.name;
      return { m, step, dir, project: typeof project === "string" ? project : basename(dir) };
    })
    .filter((x): x is NonNullable<typeof x> => x !== undefined);
  const owners = steps.map((s) => ({ component: s.m.component, project: s.project, stack: s.step.stack }));
  const out: DeclaredRead[] = [];
  for (const s of steps) {
    const exported = await memberExportOf(s.dir, { stack: s.step.stack, ...(opts.exportStore !== undefined ? { store: opts.exportStore } : {}) });
    for (const ref of pulumiStackReferences(exported)) {
      const found = stackReferenceOwner(ref, { component: s.m.component, project: s.project }, owners);
      if (!("owner" in found)) continue;
      for (const output of ref.outputs) {
        out.push({ reader: s.m.component, index: s.m.index, upstream: found.owner.component, output, at: `/stackReferences/${pointerSegment(ref.name)}/${pointerSegment(output)}` });
      }
    }
  }
  return out;
}

/** An `up` that exited non-zero, read through the exit-code table (#4553). */
function upFailure(r: Resolved, err: unknown, policy: GatePolicyFindings): Error {
  const f = pulumiRunFailure(err);
  if (f.missingBinary) return new Error(`pulumi-up: "${r.member}": the ${r.engine} binary was not found on PATH; nothing was applied`);
  const stream = f.stdout ?? "";
  const why = pulumiStreamError(stream) ?? (f.stderr?.trim() || f.message).split("\n").slice(-3).join("\n");
  const outcome = pulumiExitOf(f.exitCode);
  if (outcome === CHANT_EXIT.moved) {
    return new PulumiPlanMovedError(r.member, `"${r.member}": refusing to apply. plunge refused the saved plan, since a record it planned against moved or the plan has no stamp: ${why}. Plan it again.`);
  }
  const events = pulumiPolicyFindings(pulumiPolicyEvents(stream));
  if (outcome === CHANT_EXIT.denied || events.denials.length > 0) {
    return new PulumiPolicyDeniedError(r.member, events.denials.length > 0 ? events : policy, why);
  }
  const landed = pulumiLandedUrns(stream);
  const failed = pulumiFailedUrns(stream);
  const detail = [
    ...(failed.length > 0 ? [`failed: ${failed.join(", ")}`] : []),
    ...(landed.length > 0 ? [`landed before it stopped: ${landed.join(", ")}`] : ["nothing landed"]),
  ].join("; ");
  return new PulumiUpFailedError(r.member, `pulumi-up: "${r.member}": ${r.engine} up failed (exit ${f.exitCode ?? "unknown"}): ${why}. ${detail}`, failedUpSummary(stream));
}

/**
 * What a failed `up`'s stream still says (#4579): its `summaryEvent`, or,
 * when the engine stopped before printing one, the per-resource timings
 * plunge put on the steps that ran (`resOutputsEvent`, `resOpFailedEvent`),
 * under `result: "failed"`. Undefined when the stream holds neither.
 */
export function failedUpSummary(stream: string): PulumiApplySummary | undefined {
  const summary = pulumiStreamSummary(stream);
  if (summary) return summary;
  const timings = pulumiStreamTimings(stream);
  return Object.keys(timings).length > 0 ? { resourceChanges: {}, result: "failed", timings } : undefined;
}

async function runStack(ctx: DeployContext, original: PulumiUpStepInput, opts: PulumiUpOptions): Promise<PulumiUpStepOutput> {
  // #4609: in pr-<n>, the review stack the plan made and previewed.
  const { step: input } = pulumiReviewStep(original, ctx.env, templateOf(opts));
  const r = resolveStep(input, opts, ctx.lockGrain);
  const handed = ctx.plans?.[r.member];
  const fromWave = isArtifact(handed);
  const targets = ctx.targets && ctx.targets.length > 0 ? ctx.targets : undefined;
  await readyProgram(r, opts);

  // Ruling D: no approved plan handed in, so plan here and apply that.
  let approved: PulumiUpArtifact;
  if (fromWave) {
    approved = handed;
  } else {
    const planned = await planStack(ctx, original, opts);
    if (!isArtifact(planned.artifact)) {
      throw new Error(`pulumi-up: "${r.member}": the stack's config reads outputs not known yet (${(ctx.unresolvedInputs ?? []).join(", ")}), so it cannot apply`);
    }
    approved = planned.artifact;
  }

  // The config copy: the plan's when it is still there, else written again (its text is the same).
  const own = existsSync(approved.scratch) ? undefined : scratchFor(r, input, opts);
  const configFile = approved.configFile && existsSync(approved.configFile) ? approved.configFile : own?.configFile;
  // #4613: the packs the plan read at base, the same copies, else read again at that base; a plan that read none runs the step's own.
  let policyPacks: readonly PulumiPolicyPack[] | undefined = input.policyPacks;
  if (approved.policyPacks) {
    const copies = approved.policyPacks.packs;
    if (copies.every((p) => existsSync(p.dir) && (!p.config || existsSync(p.config)))) {
      policyPacks = copies.map((p) => ({ dir: p.dir, ...(p.config ? { config: p.config } : {}) }));
    } else {
      try {
        policyPacks = (await policyPacksFor({ ...ctx, policyBase: approved.policyPacks.base }, r, input, own?.scratch ?? approved.scratch)).packs;
      } catch (err) {
        dropScratch(approved.scratch);
        dropScratch(own?.scratch);
        throw err;
      }
    }
  }
  const tail = {
    ...(configFile ? { configFile } : {}),
    ...(targets ? { targets } : {}),
    ...(targets && ctx.targetDependents ? { targetDependents: true } : {}),
    ...(policyPacks?.length ? { policyPacks } : {}),
  };

  try {
    let stdout: string;
    if (r.engine === "plunge") {
      if (!approved.planFile || !existsSync(approved.planFile)) {
        throw new Error(`pulumi-up: "${r.member}": the saved plan ${approved.planFile ?? "(none)"} is not on this machine; plan the stack in the apply job, then apply`);
      }
      try {
        ({ stdout } = await runApplyPlunge(runnersFor(r, opts).plunge, plungeUpArgs({ plan: approved.planFile, stack: input.stack, ...tail }), r.dir));
      } catch (err) {
        throw upFailure(r, err, approved.policy);
      }
    } else {
      if (fromWave) {
        // Preview again, and hold it to the approved shape before anything changes.
        const fresh = await previewStack(ctx, r, input, opts, { ...(configFile ? { configFile } : {}), ...(policyPacks ? { policyPacks } : {}) });
        const differences = pulumiShapeDifferences(approved.shape, fresh.shape, fresh.preview.steps);
        if (differences.length > 0) throw new PlanShapeMovedError(r.member, differences);
      }
      try {
        // #4627: stock up plans again, so it refreshes as its preview did; plunge applies the saved plan, whose preview refreshed.
        ({ stdout } = await runApplyPulumi(runnersFor(r, opts).pulumi, pulumiUpArgs({ stack: input.stack, ...tail, ...(ctx.refresh ? { refresh: true } : {}) }), r.dir));
      } catch (err) {
        throw upFailure(r, err, approved.policy);
      }
      // Ruling A: the steps the update ran, held to the approved shape.
      const steps = pulumiAppliedSteps(stdout);
      const ran = pulumiPreviewPart({ member: r.member, preview: { steps }, stack: input.stack });
      const differences = pulumiShapeDifferences(approved.shape, pulumiPlanShape(ran, r.member), steps);
      if (differences.length > 0) throw new PulumiAppliedShapeError(r.member, differences, pulumiStreamSummary(stdout));
    }
    const outputs = await pulumiMemberStackOutputs({
      dir: r.dir,
      stack: input.stack,
      engine: r.engine,
      ...runnerOptions(r, opts),
    });
    const summary = pulumiStreamSummary(stdout);
    const exportSnapshot = await writePulumiExportSnapshot({
      dir: r.dir,
      stack: input.stack,
      environment: ctx.env,
      engine: r.engine,
      ...runnerOptions(r, opts),
      ...(opts.snapshots !== undefined ? { store: opts.snapshots } : {}),
    });
    const hasPolicy = approved.policy.warnings.length > 0 || approved.policy.denials.length > 0;
    return {
      member: r.member,
      stack: input.stack,
      engine: r.engine,
      planDigest: approved.planDigest,
      fromWavePlan: fromWave,
      outputs,
      ...(summary ? { summary } : {}),
      ...(hasPolicy ? { policy: approved.policy } : {}),
      exportSnapshot,
    };
  } finally {
    dropScratch(approved.scratch);
    dropScratch(own?.scratch);
  }
}

/** `releaseInputs` (#4542): the stack's directory, or unbound when its state is a file relative to it. */
export function pulumiReleaseInputs(input: PulumiUpStepInput, ctx: ReleaseInputsContext): ReleaseInputs | ReleaseInputsUnbound | null {
  if (typeof input?.dir !== "string" || input.dir === "" || typeof input.stack !== "string") return null;
  const base = resolve(ctx.memberDir, input.cwd ?? ".");
  const dir = isAbsolute(input.dir) ? input.dir : resolve(base, input.dir);
  const project = readProject(dir);
  if (!project) return null;
  const toPosix = (p: string): string => p.split("\\").join("/") || ".";
  const fromMember = (abs: string): string => toPosix(relative(ctx.memberDir, abs));
  const backend = (project.backend as { url?: unknown } | undefined)?.url;
  if (typeof backend === "string") {
    const m = /^(?:plunge\+)?file:\/\/(.*)$/.exec(backend);
    if (m && !m[1].startsWith("/") && !m[1].startsWith("~")) {
      return {
        unbound: `stack "${input.stack}" keeps its state at ${backend}, a path relative to ${fromMember(dir)}, so a preview of a recorded copy would read no state; roll it back with chant lifecycle rollback --to <ref>`,
      };
    }
  }
  const paths = [fromMember(dir)];
  const main = typeof project.main === "string" ? resolve(dir, project.main) : undefined;
  if (main && relative(dir, main).startsWith("..")) paths.push(fromMember(main));
  return { field: "dir", dir: fromMember(dir), paths: [...new Set(paths)].sort() };
}

/** The `pulumi-up` capability, with injectable runners for tests. */
export function createPulumiUpCapability(opts: PulumiUpOptions = {}): Capability<PulumiUpStepInput, PulumiUpStepOutput> {
  return {
    kind: "pulumi-up",
    // A stack's update has no undo short of applying the previous program, which is a change of its own.
    rollbackPolicy: "needs-opt-out",
    // Each target passes as `--target <urn>` to the preview and to `up`.
    targets: "accept",
    // #4627: `--refresh` and `--target-dependents` pass to the preview, and to `pulumi up`; the digest binds them.
    planFlags: { refresh: "accept", targetDependents: "accept" },
    plan: (ctx, input) => planStack(ctx, input, opts),
    run: (ctx, input) => runStack(ctx, input, opts),
    // The outputs standing now, for a dependent planned before this stack applies.
    async outputs(ctx, original) {
      const { step: input } = pulumiReviewStep(original, ctx.env, templateOf(opts));
      const r = resolveStep(input, opts);
      return pulumiMemberStackOutputs({
        dir: r.dir,
        stack: input.stack,
        engine: r.engine,
        ...runnerOptions(r, opts),
      });
    },
    releaseInputs: (input, ctx) => pulumiReleaseInputs(input, ctx),
    // #4552: resource on plunge, the stack (target) on stock Pulumi.
    defaultLockGrain(input) {
      requireInput(input);
      return pulumiDefaultLockGrain(pulumiMemberEngine(stackDir(input), input.engine, engineEnv(input, opts)).engine);
    },
    // Stock Pulumi keeps the stack grain: its backend's stack lock already orders updates, and nothing in it is per resource.
    lockGrainRefusal(input, grain) {
      if (grain !== "resource") return undefined;
      requireInput(input);
      const engine = pulumiMemberEngine(stackDir(input), input.engine, engineEnv(input, opts)).engine;
      return engine === "pulumi" ? new PulumiResourceGrainRefusedError(pulumiUpMember(input)).message : undefined;
    },
    // The ruling for ci-products (2026-10-28): a stock stack waits for its stack row on the ledger in place of the backend's lock.
    // plunge keeps the resource grain, and a plunge stack declared on the target grain waits on the same row.
    targetLockRow(input, plan) {
      requireInput(input);
      const project = readProject(stackDir(input))?.name;
      const stack = plan && isArtifact(plan.artifact) ? plan.artifact.stack : input.stack;
      if (typeof project !== "string" || !stack) return undefined;
      return { key: stackRowKey(project, stack), target: pulumiUpMember(input), address: `${project}/${stack}` };
    },
    // URN rows, object rows, and the stack row when something may appear only at apply (./lock-rows.ts).
    lockRows(input, plan) {
      if (!plan.changeSet) return [];
      const project = readProject(stackDir(input))?.name;
      // #4609: the stack the plan previewed, the review stack in pr-<n>.
      const stack = isArtifact(plan.artifact) ? plan.artifact.stack : input.stack;
      return pulumiLockRows(plan.changeSet, plan.member, { ...(typeof project === "string" ? { project } : {}), stack });
    },
    // #4555: the stack, the engine and the summary's counts, for the step's span and run record.
    traceFacts: (input, outcome) => pulumiTraceFacts(input, outcome),
    declaredReads: (ctx, members) => pulumiDeclaredReads(ctx, members, opts.snapshots !== undefined ? { exportStore: opts.snapshots } : {}),
  };
}

export const pulumiUpCapability = createPulumiUpCapability();
