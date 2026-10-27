/**
 * apply family — the most cloud-shaped family (see docs/components/cloud-boundary).
 * AWS leaves for this starter set: cfn-deploy, ecs-update-service,
 * lambda-deploy, s3-sync, cdn-invalidate, run-migration.
 *
 * `cfn-deploy` carries declarative safety options (changeset preview,
 * `onReplace`, `stageGsi`) — sticky per-resource knowledge (a DynamoDB GSI
 * updates one at a time; a key-schema change forces replacement) lives inside
 * the capability, configured by options, never scripted per component. See
 * docs/components/capabilities.mdx#stickiness-lives-in-the-capability.
 *
 * `cfn-deploy` and `ecs-update-service` are real implementations (#557, epic
 * #551) over the injectable `CloudExecutor` (./cloud-executor.ts).
 * `lambda-deploy` gained a real implementation in #558 (epic #551) — the one
 * new capability the fourth, genuinely different validation component
 * (image-processor-lambda) needed; see ../SPRAWL-VALIDATION.md. `s3-sync`,
 * `cdn-invalidate`, and `run-migration` are also real over the same executor —
 * `run-migration` dispatches on its target transport (ECS one-off task, Lambda
 * invoke, or SSM host command).
 */

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability, CapabilityPlan, DeclaredRead, DeployContext, PlannedOutputs } from "@intentius/chant/components/capability";
import type { ChangeSetEntry, ChangeSetHole, ChangeSetPart } from "@intentius/chant/change-set";
import { computePlanDigest } from "@intentius/chant/lifecycle/plan-digest";
import {
  normalizePlanShape,
  PlanShapeMovedError,
  planShapeDifferences,
  planShapeDigest,
  type PlanShape,
  type PlanShapeArtifact,
  type PlanShapeEntry,
  type ShapeReplacement,
} from "@intentius/chant/components/covered-round";
import { defaultCloudExecutor, type CfnChange, type CfnChangeSet, type CfnStackStatus, type CloudExecutor } from "./cloud-executor";
import { cfnExports, cfnImportPointer, cfnImports, cfnKnownValues, cfnTemplateWithStandIns, readCfnTemplate, resolveCfnName } from "./cfn-imports";

/** CloudFormation's wording when a change set has nothing to apply — the stack
 * is already current. AWS phrases it "The submitted information didn't contain
 * changes."; `aws cloudformation deploy` reports "No updates are to be
 * performed."; keep both plus a bare "no changes" for other backends/Floci. */
const NO_CHANGE_REASON = /(did ?n['’]?t|does ?n['’]?t|did not|does not) contain changes|no updates are to be performed|no changes/i;

/**
 * True when CloudFormation reports the change set has nothing to apply. AWS
 * surfaces this as a FAILED change set whose `StatusReason` names the empty
 * diff (executing it then errors); when no reason is available, a FAILED set
 * with zero proposed changes is the same no-op. A FAILED set with any other
 * reason is a genuine create failure and must NOT be treated as a no-op.
 */
export function isNoopChangeSet(changeSet: CfnChangeSet): boolean {
  if (changeSet.status !== "FAILED") return false;
  return changeSet.statusReason
    ? NO_CHANGE_REASON.test(changeSet.statusReason)
    : changeSet.changes.length === 0;
}

// ── cfn-deploy ───────────────────────────────────────────────────────────────

/**
 * Whether a proposed change replaces its resource. CloudFormation's
 * `Replacement: Conditional` counts: the replacement depends on a value it
 * resolves only while applying, so a reviewer has to read it as one (#4084).
 */
export function cfnChangeReplaces(change: CfnChange): boolean {
  return change.replacement || change.replacementMode === "Conditional";
}

/**
 * One CloudFormation resource change as a change-set entry (#4084). The
 * address is the logical id, which is also the entity name the aws
 * lexicon's graph IR gives the resource, so the entry maps onto its node
 * (#4022). `Add` is a create, `Modify` an update or (when it replaces) a
 * replace, `Remove` a delete, `Import` an import that changes nothing else,
 * and `Dynamic` an update CloudFormation could not describe further.
 */
export function cfnChangeEntry(member: string, change: CfnChange, unknown: readonly string[] = []): ChangeSetEntry {
  // A property an unknown input drives is known after apply (#4419); one the
  // change set did not list (a create names no properties) is added for it.
  const paths = [...new Set([...(change.details ?? []), ...unknown])].sort();
  const attributes = paths.map((path) => (unknown.includes(path) ? { path, unknown: true as const } : { path }));
  // A change inside a nested stack (#3997) sits under the nested stacks'
  // logical ids, the way a terraform address sits under its module.
  const module = change.nestedStack?.length ? change.nestedStack.join("/") : undefined;
  const base = {
    member,
    lexicon: "aws",
    planner: "chant" as const,
    address: module ? `${module}/${change.logicalResourceId}` : change.logicalResourceId,
    type: change.resourceType,
    name: change.logicalResourceId,
    ...(module ? { module } : {}),
    attributes,
  };
  switch (change.action) {
    case "Add":
      return { ...base, action: "create" };
    case "Remove":
      return { ...base, action: "delete", disruption: "destroy" };
    case "Import":
      return { ...base, action: "no-op", importing: true };
    case "Dynamic":
      return { ...base, action: cfnChangeReplaces(change) ? "replace" : "update", disruption: cfnChangeReplaces(change) ? "replace" : "unknown" };
    default:
      return cfnChangeReplaces(change)
        ? { ...base, action: "replace", disruption: "replace" }
        : { ...base, action: "update", disruption: "in-place" };
  }
}

/**
 * The changes `onReplace: "block"` refuses: those CloudFormation says replace
 * their resource (`Replacement: True`). `run` and `plan` refuse on the same
 * set, so a plan that passes is one `run` would not block (#3997).
 */
function blockedReplacements(changes: CfnChange[]): CfnChange[] {
  return changes.filter((c) => c.replacement);
}

/**
 * What a `cfn-deploy` plan hands `run` through `DeployContext.plans[stack]`
 * (#3997): the stack and a digest over the changes the plan's change set
 * proposed. `run` creates its change set, and executes it only when its
 * changes have the same digest.
 */
export interface CfnPlanArtifact {
  kind: "cfn-deploy-plan";
  stack: string;
  /** {@link cfnChangesDigest} of the planned change set's changes. */
  changesDigest: string;
}

function isCfnPlanArtifact(value: unknown): value is CfnPlanArtifact {
  const v = value as Partial<CfnPlanArtifact> | undefined;
  return v?.kind === "cfn-deploy-plan" && typeof v.stack === "string" && typeof v.changesDigest === "string";
}

/**
 * A digest over a change set's changes as entries, independent of the change
 * set's name and of the order CloudFormation lists them in. A change set with
 * nothing to apply digests as no entries.
 */
export function cfnChangesDigest(stack: string, changeSet: CfnChangeSet): string {
  const entries = isNoopChangeSet(changeSet) ? [] : changeSet.changes.map((c) => cfnChangeEntry(stack, c));
  entries.sort((a, b) => a.address.localeCompare(b.address) || a.action.localeCompare(b.action));
  return computePlanDigest("cfn-deploy-changes", { stack, entries });
}

/**
 * Thrown by `run` when the change set it created proposes other changes than
 * the change set its plan read (#3997): the stack, the template or the
 * parameters moved between the plan and the apply. The change set is deleted
 * unexecuted. `planMoved` is core's mark for a moved plan
 * (`isPlanMovedError`), so the command that applied it exits 3.
 */
export class CfnPlanMovedError extends Error {
  readonly planMoved = true;
  constructor(
    public readonly stack: string,
    public readonly planned: string,
    public readonly now: string,
  ) {
    super(
      `cfn-deploy "${stack}": refusing to apply. The change set proposes other changes than the plan that was approved ` +
        `(planned ${planned}, now ${now}); the stack, its template or its parameters changed since. Plan it again.`,
    );
    this.name = "CfnPlanMovedError";
  }
}

/** The template's bytes as a digest, or `null` when it cannot be read here (the change set then reports why). */
function templateDigest(path: string): string | null {
  try {
    return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
  } catch {
    return null;
  }
}

/**
 * What a `cfn-deploy` plan binds: the environment, the stack, the template's
 * bytes and the parameters as resolved, and the stacks whose outputs were
 * not known yet. The proposed changes are not in it; they are the member's
 * entries, which the change-set document's digest binds (#4084).
 */
function cfnPlanDigest(
  ctx: DeployContext,
  stack: string,
  input: CfnDeployInput,
  parameters: Record<string, string | null>,
  unresolved: string[],
  /** The digest of the preview's shape (#4423), so an approval binds what the reviewer saw of a member planned before its inputs were known. */
  preview?: string,
): string {
  return computePlanDigest("cfn-deploy-plan", {
    env: ctx.env,
    stack,
    template: input.template,
    templateDigest: templateDigest(input.template),
    parameters,
    unresolved,
    // #4466: the exports the template imports from stacks in the change, as resolved.
    ...(input.imports && Object.keys(input.imports).length > 0 ? { imports: importValues(input.imports) } : {}),
    ...(preview ? { preview } : {}),
  });
}

/**
 * Plan a `cfn-deploy` step without changing the stack (#4084): create a
 * change set for the template and the resolved parameters, read the changes
 * it proposes, and delete it without executing it. A stack that does not
 * exist yet gets a CREATE change set, so every resource reads as a create,
 * and the empty `REVIEW_IN_PROGRESS` stack CloudFormation made to hold it is
 * deleted too. A change set with nothing to apply (`isNoopChangeSet`) gives
 * a member with no entries. A step whose parameters or imports read outputs
 * that are not known yet, from a stack the same run applies first, is
 * previewed: its change set is made against a stand-in for each unknown
 * value (#4423), an import standing in as a parameter of a template copy
 * (#4466b), and `run` checks the real change set's shape against the
 * preview's before it executes. When no preview can be made, its member gets
 * a hole saying whose outputs it waits on, and no artifact, so `run` plans
 * it afresh.
 *
 * With `onReplace: "block"` (the default), a change set that replaces a
 * resource fails the plan with {@link CfnReplacementBlockedError}, so the
 * refusal shows in the pull request's plan rather than at apply (#3997).
 * Otherwise the result carries a {@link CfnPlanArtifact} that `run` checks
 * its own change set against.
 *
 * The plan answers the outputs the stack will have (#3999), from the
 * outputs it has now (`DescribeStacks`) and the change set: an output keeps
 * its value when every resource its template `Value` reads keeps its
 * physical resource, which an in-place `Modify` does and an `Add`, a
 * `Remove` or a replacement does not ({@link cfnPlannedOutputs}). An output
 * that reads a parameter, an import or a condition is known only after
 * apply. A wrong guess costs a round, never a wrong apply: a dependent whose
 * input applies as another value is held back and planned again.
 */
async function planCfnDeploy(executor: CloudExecutor, ctx: DeployContext, input: CfnDeployInput): Promise<CapabilityPlan> {
  const stack = input.stack ?? ctx.component;
  const raw: Record<string, unknown> = { ...(input.inputs ?? {}), ...(input.imageRef !== undefined ? { ImageRef: input.imageRef } : {}) };
  const parameters: Record<string, string | null> = {};
  const missing: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === null) {
      parameters[key] = null;
      missing.push(key);
    } else parameters[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  const unresolved = [...(ctx.unresolvedInputs ?? [])].sort();
  let planDigest = cfnPlanDigest(ctx, stack, input, parameters, unresolved);
  // #4466: an import whose name the plan cannot resolve is a hole that says why.
  const importHoles = unresolvedImportHoles(stack, input, knownParameters(parameters));
  // #4466c: an export another stack imports that the plan may change, said where it cannot tell.
  const exportHoles: ChangeSetHole[] = [];
  const member = (holes: ChangeSetHole[]): ChangeSetPart["member"] => ({
    member: stack,
    lexicon: "aws",
    planner: "chant",
    status: "planned",
    planDigest,
    holes: [...holes, ...importHoles, ...exportHoles],
  });
  const standing = standingReader(executor, stack);

  if (unresolved.length > 0 || missing.length > 0) {
    const hole = (why: string): CapabilityPlan => ({
      member: stack,
      planDigest,
      changeSet: { member: member([{ address: stack, type: "AWS::CloudFormation::Stack", reason: why }]), entries: [] },
    });
    const waiting = unknownImports(input);
    const fallback =
      unresolved.length > 0
        ? missing.length === 0 && waiting.length > 0
          ? `imports ${waiting.join(", ")}, exported by ${unresolved.join(", ")}, which apply first; re-checked on apply`
          : `inputs from ${unresolved.join(", ")}; re-checked on apply`
        : `inputs ${[...missing].sort().join(", ")} are known only at apply; re-checked on apply`;
    // Which parameters are unknown: the inputs that hold nothing yet, and a
    // stand-in for each import of an export not known yet (#4466b). When the
    // upstream is unresolved but neither says which, nothing can be previewed.
    if (missing.length === 0 && waiting.length === 0) return hole(fallback);
    const copy = waiting.length > 0 ? standInTemplate(stack, input, waiting, knownParameters(parameters)) : undefined;
    if (typeof copy === "string") return hole(`${fallback}; no preview: ${copy}`);
    let preview: Awaited<ReturnType<typeof previewCfnDeploy>>;
    try {
      const previewed = copy ? { ...input, template: copy.path } : input;
      preview = await previewCfnDeploy(executor, stack, previewed, [...missing, ...(copy?.parameters ?? [])].sort(), unresolved.length > 0 ? unresolved : undefined);
    } finally {
      copy?.remove();
    }
    if (typeof preview === "string") return hole(`${fallback}; no preview: ${preview}`);
    const { entries, shape, outputs } = preview;
    exportHoles.push(...(await exportsInUse(executor, stack, input, knownParameters(parameters), outputs, standing)));
    const artifact: CfnShapeArtifact = { kind: "cfn-deploy-shape", member: stack, shape, digest: planShapeDigest(shape) };
    // The preview's shape enters the digest (#4423); `member` reads it when called below.
    planDigest = cfnPlanDigest(ctx, stack, input, parameters, unresolved, artifact.digest);
    return { member: stack, planDigest, artifact, shape, changeSet: { member: member([]), entries }, ...(outputs ? { outputs } : {}) };
  }

  const changeSet = await executor.cloudformation.createChangeSet({
    stackName: stack,
    templatePath: input.template,
    parameters: flattenCfnInputs(input),
  });
  try {
    if (isNoopChangeSet(changeSet)) {
      const artifact: CfnPlanArtifact = { kind: "cfn-deploy-plan", stack, changesDigest: cfnChangesDigest(stack, changeSet) };
      // Nothing to apply, so the outputs the stack has are the ones it will have (#3999).
      const now = await standing();
      const outputs = now ? { known: { ...now.outputs }, unknown: [] } : undefined;
      return { member: stack, planDigest, artifact, changeSet: { member: member([]), entries: [] }, ...(outputs ? { outputs } : {}) };
    }
    if (changeSet.status === "FAILED") {
      throw new Error(
        `cfn-deploy "${stack}": CloudFormation could not create a change set to plan it${changeSet.statusReason ? `: ${changeSet.statusReason}` : ""}`,
      );
    }
    const blocked = blockedReplacements(changeSet.changes);
    if (blocked.length > 0 && (input.onReplace ?? "block") === "block") throw new CfnReplacementBlockedError(stack, blocked);
    const entries = changeSet.changes.map((c) => cfnChangeEntry(stack, c));
    const artifact: CfnPlanArtifact = { kind: "cfn-deploy-plan", stack, changesDigest: cfnChangesDigest(stack, changeSet) };
    const outputs = changeSet.stackCreated
      ? undefined
      : await plannedStackOutputs(standing, input.template, changeSet.changes, knownParameters(parameters), importValues(input.imports ?? {}));
    // #4466c: CloudFormation refuses to change or remove an export another stack imports; say so now, not at apply.
    if (!changeSet.stackCreated) exportHoles.push(...(await exportsInUse(executor, stack, input, knownParameters(parameters), outputs, standing)));
    // The real change set's shape, with the replacement CloudFormation reports,
    // for a round that checks it against a preview (#4419).
    const shape = cfnPlanShape(stack, changeSet, []);
    return { member: stack, planDigest, artifact, shape, changeSet: { member: member([]), entries }, ...(outputs ? { outputs } : {}) };
  } finally {
    await cleanUpPlanChangeSet(executor, changeSet);
  }
}

// ── preview of a member whose inputs are unknown (#4419) ────────────────────

/** What a previewed member hands `run`: the shape its change set had against stand-in values. */
export interface CfnShapeArtifact extends PlanShapeArtifact {
  kind: "cfn-deploy-shape";
}

function isCfnShapeArtifact(value: unknown): value is CfnShapeArtifact {
  const v = value as Partial<CfnShapeArtifact> | undefined;
  return v?.kind === "cfn-deploy-shape" && typeof v.digest === "string" && typeof v.shape === "object" && v.shape !== null;
}

/** The marker every stand-in carries, so a reader of a change set can tell it from a real value. */
export const CFN_UNKNOWN_MARK = "known-after-apply";

const ID_PREFIX: Record<string, string> = {
  "AWS::EC2::Subnet::Id": "subnet",
  "AWS::EC2::VPC::Id": "vpc",
  "AWS::EC2::SecurityGroup::Id": "sg",
  "AWS::EC2::Instance::Id": "i",
  "AWS::EC2::Image::Id": "ami",
  "AWS::EC2::Volume::Id": "vol",
};

/**
 * A stand-in for a parameter whose value is not known yet: valid for the
 * parameter's type and recognisable. An EC2 id type gets the id's prefix
 * (`subnet-00000000known-after-apply`), a number gets 0, anything else gets
 * `known-after-apply`. Real CloudFormation checks the AWS-specific types
 * against the account and refuses an id that does not exist; the preview
 * then falls back to a hole. Floci does not check.
 */
export function cfnPlaceholder(type: string | undefined): string {
  if (type && ID_PREFIX[type]) return `${ID_PREFIX[type]}-00000000${CFN_UNKNOWN_MARK}`;
  if (type === "Number") return "0";
  if (type?.startsWith("AWS::SSM::Parameter::Value<")) return `/${CFN_UNKNOWN_MARK}`;
  return CFN_UNKNOWN_MARK;
}

interface TemplateFacts {
  parameterTypes: Record<string, string>;
  /** Per logical id, the top-level properties whose value reads one of the keys. */
  driven: Map<string, Set<string>>;
}

function readsParameter(value: unknown, key: string): boolean {
  if (typeof value === "string") return false;
  if (Array.isArray(value)) return value.some((v) => readsParameter(v, key));
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (obj.Ref === key) return true;
    const sub = obj["Fn::Sub"];
    const text = typeof sub === "string" ? sub : Array.isArray(sub) && typeof sub[0] === "string" ? sub[0] : undefined;
    if (text !== undefined && (text.includes("${" + key + "}") || text.includes("${" + key + "."))) return true;
    return Object.values(obj).some((v) => readsParameter(v, key));
  }
  return false;
}

/** The parameter types and the properties that read `keys`, from the template. A template that cannot be read gives no facts. */
function templateFacts(path: string, keys: string[]): TemplateFacts {
  const facts: TemplateFacts = { parameterTypes: {}, driven: new Map() };
  try {
    const t = JSON.parse(readFileSync(path, "utf8")) as {
      Parameters?: Record<string, { Type?: string }>;
      Resources?: Record<string, { Properties?: Record<string, unknown> }>;
    };
    for (const k of keys) if (t.Parameters?.[k]?.Type) facts.parameterTypes[k] = t.Parameters[k].Type!;
    for (const [id, r] of Object.entries(t.Resources ?? {})) {
      for (const [prop, value] of Object.entries(r.Properties ?? {})) {
        if (keys.some((k) => readsParameter(value, k))) (facts.driven.get(id) ?? facts.driven.set(id, new Set()).get(id)!).add(prop);
      }
    }
  } catch {
    /* unreadable or not JSON: the change set reports why, and no property is attributed */
  }
  return facts;
}

/** The properties of one change that the unknown parameters drive. */
function drivenProperties(change: CfnChange, keys: string[], facts: TemplateFacts): string[] {
  const out = new Set<string>();
  for (const d of change.drivers ?? []) {
    if (d.changeSource === "ParameterReference" && d.causingEntity && keys.some((k) => d.causingEntity === k || d.causingEntity!.startsWith(`${k}.`))) {
      out.add(d.property);
    }
  }
  const scanned = facts.driven.get(change.logicalResourceId);
  if (scanned && change.action !== "Remove") {
    const listed = change.details ?? [];
    for (const p of scanned) if (change.action === "Add" || listed.length === 0 || listed.includes(p)) out.add(p);
  }
  return [...out].sort();
}

function shapeReplacement(change: CfnChange): ShapeReplacement {
  if (change.replacementMode === "True" || change.replacement) return "true";
  return change.replacementMode === "Conditional" ? "conditional" : "false";
}

/**
 * A change set's shape: each change's resource, action, replacement and
 * properties, with the ones the `unknown` parameters drive marked. `unknown`
 * is empty for the change set made against real values. `refs` are the
 * inputs the shape names as unknown (`<component>.<output>`), the parameters
 * themselves when nothing says better.
 */
export function cfnPlanShape(stack: string, changeSet: CfnChangeSet, unknown: string[], templatePath?: string, refs: string[] = unknown): PlanShape {
  const facts = unknown.length > 0 && templatePath ? templateFacts(templatePath, unknown) : { parameterTypes: {}, driven: new Map() };
  const entries: PlanShapeEntry[] = isNoopChangeSet(changeSet)
    ? []
    : changeSet.changes.map((c) => {
        const e = cfnChangeEntry(stack, c);
        return {
          logicalId: e.address,
          action: e.action,
          replacement: shapeReplacement(c),
          type: c.resourceType,
          properties: [...new Set(c.details ?? [])],
          unknown: drivenProperties(c, unknown, facts),
        };
      });
  return normalizePlanShape({ member: stack, unknownInputs: refs, entries });
}

/**
 * Preview a stack whose parameters `unknown` are not known yet: create its
 * change set with a stand-in for each, read the changes into entries that
 * mark the properties those parameters drive as known after apply, take the
 * shape, and delete the change set. Returns why instead when CloudFormation
 * would not make the change set (real CloudFormation refuses an id that does
 * not exist), so the caller plans a hole.
 *
 * Floci accepts a change set that real CloudFormation refuses (a missing
 * export, an id that does not exist), reports `Parameters: null`, and says
 * `Replacement: False` for a change that replaces. So a cross-stack value
 * goes through a parameter here, never an export: an import of an export
 * not known yet is planned from a copy of the template in which it is a
 * stand-in parameter (#4466b, `cfnTemplateWithStandIns`). The replacement a
 * preview reports is whatever the backend says; the shape check at apply
 * compares like with like.
 */
async function previewCfnDeploy(
  executor: CloudExecutor,
  stack: string,
  input: CfnDeployInput,
  unknown: string[],
  refs: string[] = unknown,
): Promise<{ entries: ChangeSetEntry[]; shape: PlanShape; outputs?: PlannedOutputs } | string> {
  const facts = templateFacts(input.template, unknown);
  const parameters: Record<string, string> = { ...(flattenCfnInputs(input) ?? {}) };
  for (const k of unknown) parameters[k] = cfnPlaceholder(facts.parameterTypes[k]);
  let changeSet: CfnChangeSet;
  try {
    changeSet = await executor.cloudformation.createChangeSet({ stackName: stack, templatePath: input.template, parameters });
  } catch (err) {
    return `CloudFormation refused the change set with stand-in values: ${err instanceof Error ? err.message : String(err)}`;
  }
  try {
    if (changeSet.status === "FAILED" && !isNoopChangeSet(changeSet)) {
      return `CloudFormation could not create the change set with stand-in values${changeSet.statusReason ? `: ${changeSet.statusReason}` : ""}`;
    }
    const noop = isNoopChangeSet(changeSet);
    const entries = noop ? [] : changeSet.changes.map((c) => cfnChangeEntry(stack, c, drivenProperties(c, unknown, facts)));
    // What the stack's outputs will be, for the members that read them: an
    // output that reads one of the unknown parameters is unknown, one that
    // reads a known parameter or states its value is not (#4419).
    const given = Object.fromEntries(Object.entries(parameters).filter(([k]) => !unknown.includes(k)));
    const outputs = noop || changeSet.stackCreated ? undefined : await plannedStackOutputs(standingReader(executor, stack), input.template, changeSet.changes, given);
    return { entries, shape: cfnPlanShape(stack, changeSet, unknown, input.template, refs), ...(outputs ? { outputs } : {}) };
  } finally {
    await cleanUpPlanChangeSet(executor, changeSet);
  }
}

/**
 * Delete a plan's change set, and the empty stack a CREATE change set made
 * when no stack existed before. A failure to clean up does not fail the
 * plan: the change set holds nothing that applies, and the next CREATE
 * change set reuses an empty stack left behind.
 */
async function cleanUpPlanChangeSet(executor: CloudExecutor, changeSet: CfnChangeSet): Promise<void> {
  try {
    await executor.cloudformation.deleteChangeSet({ stackName: changeSet.stackName, changeSetName: changeSet.changeSetName });
  } catch (err) {
    console.error(`cfn-deploy plan "${changeSet.stackName}": could not delete change set ${changeSet.changeSetName}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (changeSet.stackCreated && executor.cloudformation.deleteStackShell) {
    try {
      await executor.cloudformation.deleteStackShell(changeSet.stackName);
    } catch (err) {
      console.error(`cfn-deploy plan "${changeSet.stackName}": could not delete the empty stack its CREATE change set made: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** The stack as it stands, read once however often it is asked for, or `undefined` when it cannot be read. */
function standingReader(executor: CloudExecutor, stack: string): () => Promise<CfnStackStatus | undefined> {
  let read: Promise<CfnStackStatus | undefined> | undefined;
  return () =>
    (read ??= executor.cloudformation.describeStack(stack).then(
      (s) => s,
      () => undefined,
    ));
}

/**
 * What the plan says of the stack's outputs once `changes` apply: none to
 * say for a template with no `Outputs`, which needs no `DescribeStacks`.
 */
async function plannedStackOutputs(
  standing: () => Promise<CfnStackStatus | undefined>,
  templatePath: string,
  changes: readonly CfnChange[],
  parameters: Record<string, string> = {},
  imports: Record<string, string> = {},
): Promise<PlannedOutputs | undefined> {
  const template = readTemplate(templatePath) as { Outputs?: Record<string, unknown> } | undefined;
  if (!template || typeof template !== "object") return undefined;
  if (Object.keys(template.Outputs ?? {}).length === 0) return { known: {}, unknown: [] };
  const now = await standing();
  return cfnPlannedOutputs(template, changes, now ? { ...now.outputs } : undefined, parameters, imports);
}

/** The template at `path` as JSON, or `undefined` when it cannot be read or parsed here. */
function readTemplate(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * What a template's `Value` reads (#3999): the logical ids it names through
 * `Ref`, `Fn::GetAtt` and `Fn::Sub`, and whether it reads anything this plan
 * cannot follow (`Fn::ImportValue`, a condition's `Fn::If`, or an intrinsic
 * it does not know).
 */
function valueReads(value: unknown): { ids: Set<string>; opaque: boolean } {
  const ids = new Set<string>();
  let opaque = false;
  const sub = (text: string): void => {
    for (const m of text.matchAll(/\$\{([^}!][^}]*)\}/g)) ids.add(m[1]!.split(".")[0]!);
  };
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v === null || typeof v !== "object") return;
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length === 1) {
      const [key, arg] = entries[0]!;
      if (key === "Ref") {
        if (typeof arg === "string") ids.add(arg);
        else opaque = true;
        return;
      }
      if (key === "Fn::GetAtt") {
        if (Array.isArray(arg) && typeof arg[0] === "string") ids.add(arg[0]);
        else if (typeof arg === "string") ids.add(arg.split(".")[0]!);
        else opaque = true;
        return;
      }
      if (key === "Fn::Sub") {
        if (typeof arg === "string") sub(arg);
        else if (Array.isArray(arg) && typeof arg[0] === "string") {
          const vars = (arg[1] ?? {}) as Record<string, unknown>;
          for (const m of arg[0].matchAll(/\$\{([^}!][^}]*)\}/g)) if (!(m[1]! in vars)) ids.add(m[1]!.split(".")[0]!);
          walk(vars);
        } else opaque = true;
        return;
      }
      if (key === "Fn::Join" || key === "Fn::Select" || key === "Fn::Split" || key === "Fn::Base64") return walk(arg);
      if (key.startsWith("Fn::") || key === "Condition") {
        opaque = true;
        return;
      }
    }
    entries.forEach(([, x]) => walk(x));
  };
  walk(value);
  return { ids, opaque };
}

/**
 * The outputs a stack will have once `changes` apply (#3999), from its
 * template and the outputs it has now. An output is known, at the value it
 * has now, when its `Value` reads only pseudo parameters and resources whose
 * physical resource the change set keeps (no `Add`, `Remove`, `Import` or
 * `Dynamic`, no replacement, no change in a nested stack under it). One
 * that reads a parameter, an import or a condition, one the stack does not
 * have yet, and every output of a template this cannot read, is unknown.
 *
 * Two kinds of output need no standing value. An output whose `Value` is a
 * plain string is known at that string, changed or new: the template says it.
 * An output that is a `Ref` to a parameter the plan was given a value for is
 * known at that value (`given`, the inputs of this plan). Both are what
 * the stack's outputs will be, whatever they are now.
 *
 * An output that passes an import through (`Fn::ImportValue` of a name
 * `imports` holds, #4466) is known at the value the exporting stack's plan
 * gave it, which is the value core read for the import.
 *
 * `undefined` when there is no template or no standing stack to read from.
 */
export function cfnPlannedOutputs(
  template: unknown,
  changes: readonly CfnChange[],
  standing: Record<string, string> | undefined,
  given: Record<string, string> = {},
  imports: Record<string, string> = {},
): PlannedOutputs | undefined {
  if (!standing || template === null || typeof template !== "object") return undefined;
  const t = template as { Outputs?: Record<string, { Value?: unknown; Condition?: unknown }>; Parameters?: Record<string, unknown> };
  const parameters = new Set(Object.keys(t.Parameters ?? {}));
  const moved = new Set<string>();
  for (const c of changes) {
    const id = c.nestedStack?.[0] ?? c.logicalResourceId;
    const keeps = !c.nestedStack && c.action === "Modify" && !c.replacement && c.replacementMode !== "True" && c.replacementMode !== "Conditional";
    if (!keeps) moved.add(id);
  }
  const known: Record<string, unknown> = {};
  const unknown: string[] = [];
  for (const [name, output] of Object.entries(t.Outputs ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const stated = statedOutput(output, given, t.Parameters, imports);
    if (stated !== undefined) {
      known[name] = stated;
      continue;
    }
    const { ids, opaque } = valueReads(output?.Value);
    const stays =
      !opaque && output?.Condition === undefined && name in standing &&
      [...ids].every((id) => id.startsWith("AWS::") || (!parameters.has(id) && !moved.has(id)));
    if (stays) known[name] = standing[name];
    else unknown.push(name);
  }
  return { known, unknown };
}

/** The inputs a plan was given a value for: every parameter that is not null. */
function knownParameters(parameters: Record<string, string | null>): Record<string, string> {
  return Object.fromEntries(Object.entries(parameters).filter((e): e is [string, string] => e[1] !== null));
}

/**
 * What an output's `Value` says outright: a plain string, or a `Ref` to a
 * parameter this plan has a value for. `undefined` for anything that reads a
 * resource, an import or a condition, which the standing outputs speak for.
 */
function statedOutput(
  output: { Value?: unknown; Condition?: unknown } | undefined,
  parameters: Record<string, string>,
  declared: Record<string, unknown> | undefined,
  imports: Record<string, string> = {},
): string | undefined {
  if (output?.Condition !== undefined) return undefined;
  const value = output?.Value;
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const [key, arg] = entries[0] ?? [];
    if (entries.length === 1 && key === "Ref" && typeof arg === "string" && declared && arg in declared && arg in parameters) return parameters[arg];
    if (entries.length === 1 && key === "Fn::ImportValue") {
      const name = resolveCfnName(arg, parameters);
      if ("name" in name && name.name in imports) return imports[name.name];
    }
  }
  return undefined;
}

// ── Fn::ImportValue between stacks (#4466) ──────────────────────────────────

/** The imports core read a value for, as strings; one still unknown is left out. */
function importValues(imports: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, v] of Object.entries(imports).sort(([a], [b]) => a.localeCompare(b))) {
    if (v === undefined || v === null) continue;
    out[name] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return out;
}

/** The export names the step imports from a stack in the change whose value is not known yet, sorted. */
function unknownImports(input: CfnDeployInput): string[] {
  return Object.entries(input.imports ?? {})
    .filter(([, v]) => v === undefined || v === null)
    .map(([name]) => name)
    .sort();
}

/**
 * A hole for each `Fn::ImportValue` in the template whose name the plan
 * cannot resolve (#4466): it may name an export of a stack in this change,
 * and then nothing orders the two, so the plan says it cannot tell.
 */
function unresolvedImportHoles(stack: string, input: CfnDeployInput, parameters: Record<string, string>): ChangeSetHole[] {
  const template = readCfnTemplate(input.template);
  if (!template) return [];
  const resources = (template.Resources ?? {}) as Record<string, { Type?: unknown } | undefined>;
  const holes: ChangeSetHole[] = [];
  for (const i of cfnImports(template, cfnKnownValues(template, stack, parameters))) {
    if (!("unresolved" in i)) continue;
    const type = typeof resources[i.logicalId]?.Type === "string" ? (resources[i.logicalId]!.Type as string) : undefined;
    holes.push({
      address: i.logicalId,
      ...(type ? { type } : {}),
      reason: `the Fn::ImportValue at ${i.at} ${i.unresolved}, so the plan cannot say which export it reads or whether a stack in this change exports it`,
    });
  }
  return holes;
}

/**
 * The importer's template with each import of `names` as a stand-in
 * parameter (#4466b), written to a scratch file the preview creates its
 * change set from; or why there is none. `remove` deletes the file.
 */
function standInTemplate(
  stack: string,
  input: CfnDeployInput,
  names: readonly string[],
  parameters: Record<string, string>,
): { path: string; parameters: string[]; remove: () => void } | string {
  const template = readCfnTemplate(input.template);
  if (!template) return "the template could not be read as JSON to stand in for its imports";
  const { template: copy, standIns } = cfnTemplateWithStandIns(template, names, cfnKnownValues(template, stack, parameters));
  const params = Object.keys(standIns).sort();
  if (params.length === 0) return `the template imports none of ${names.join(", ")} by a name the plan resolves`;
  const dir = mkdtempSync(join(tmpdir(), "chant-cfn-preview-"));
  const path = join(dir, `${stack}.preview.template.json`);
  writeFileSync(path, JSON.stringify(copy, null, 2));
  return { path, parameters: params, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * `cfn-deploy`'s `declaredReads` (#4466): each `Fn::ImportValue` of a name
 * exactly one other `cfn-deploy` step's template exports is a read of that
 * component's output, placed under the step's `imports`. A name two steps
 * export is left alone (CloudFormation refuses the second export), and so
 * is a name no step in the project exports: it reads a stack outside it.
 */
export function cfnDeclaredReads(root: string, members: readonly { component: string; index: number; step: Record<string, unknown> }[]): DeclaredRead[] {
  const seen = members.map((m) => {
    const template = readCfnTemplate(m.step.template, root);
    const stack = typeof m.step.stack === "string" ? m.step.stack : m.component;
    const inputs = (m.step.inputs ?? {}) as Record<string, unknown>;
    const known = cfnKnownValues(template, stack, typeof m.step.imageRef === "string" ? { ...inputs, ImageRef: m.step.imageRef } : inputs);
    return { member: m, template, known };
  });
  const exporters = new Map<string, Array<{ component: string; output: string }>>();
  for (const { member, template, known } of seen) {
    for (const e of cfnExports(template, known)) {
      if (!("name" in e)) continue;
      (exporters.get(e.name) ?? exporters.set(e.name, []).get(e.name)!).push({ component: member.component, output: e.output });
    }
  }
  const out: DeclaredRead[] = [];
  for (const { member, template, known } of seen) {
    const done = new Set<string>();
    for (const i of cfnImports(template, known)) {
      if (!("name" in i) || done.has(i.name)) continue;
      done.add(i.name);
      const owners = (exporters.get(i.name) ?? []).filter((o) => o.component !== member.component);
      if (owners.length !== 1 || (exporters.get(i.name) ?? []).length !== 1) continue;
      out.push({ reader: member.component, index: member.index, upstream: owners[0]!.component, output: owners[0]!.output, at: cfnImportPointer(i.name) });
    }
  }
  return out;
}

/** Whether a CloudFormation error says the stack does not exist. */
const STACK_MISSING = /does not exist/i;

/**
 * How `cfn-deploy` handles a changeset that requires resource replacement.
 * - `block`: refuse to apply; surface the changeset for human review.
 * - `allow`: apply the replacement as CloudFormation proposes it.
 * - `snapshot-first`: take a `snapshot-before` capture, then allow the replacement.
 */
export type CfnReplacePolicy = "block" | "allow" | "snapshot-first";

export interface CfnDeployInput {
  /**
   * Stack name. Optional because an `infra`-archetype component with a single
   * stack per component (e.g. the DynamoDB pilot) may omit it and let it
   * default to `ctx.component` — the component name doubles as the stack
   * name, the same identifier the sibling `wait-for-stack` step in that
   * pilot's Verify phase references explicitly.
   */
  stack?: string;
  /** Path to the template, or an archive-relative reference (`archive:search.template.json`). */
  template: string;
  /** Template parameters, including wired references (e.g. `imageRef: "@Publish.digest"`). */
  inputs?: Record<string, string>;
  /** Image reference wired from a `docker-build`/`publish-image` step (e.g. `"@Publish.digest"`, already resolved by the driver). Passed through as the `ImageRef` template parameter. */
  imageRef?: string;
  /** Preview the changeset before applying. Default: true. */
  previewChangeset?: boolean;
  /** Replacement safety policy. Default: "block". */
  onReplace?: CfnReplacePolicy;
  /** Stage DynamoDB GSI changes (add-then-backfill-then-remove) instead of an in-place replace. Default: false. */
  stageGsi?: boolean;
  /**
   * The exports the template imports (`Fn::ImportValue`) from another
   * `cfn-deploy` step of the project, by export name (#4466). Core fills it
   * from `declaredReads` with a `stackOutput()` of the exporting component's
   * output, so a value is `undefined` while that stack's plan cannot say it.
   * Never passed to CloudFormation: the template imports the export itself.
   */
  imports?: Record<string, string | undefined>;
}

export interface CfnDeployOutput {
  /** Final stack status (`CREATE_COMPLETE`, `UPDATE_COMPLETE`, ...). */
  stackStatus: string;
  /** Stack outputs, available to downstream steps/components. */
  outputs: Record<string, string>;
  /** Snapshot id captured before an `onReplace: "snapshot-first"` replacement, if one was taken. */
  snapshotId?: string;
}

/** One export a plan changes or removes while other stacks import it (#4466c). */
export interface CfnExportInUse {
  exportName: string;
  /** What the plan does to it, as the refusal says it: "removes", or "changes ... from A to B". */
  change: string;
  /** The stacks that import it now, sorted. */
  importers: string[];
}

/**
 * Thrown at plan time when a change set would change or remove an export
 * that another stack still imports (#4466c). CloudFormation refuses that
 * update at apply; the plan refuses it first, naming both stacks.
 */
export class CfnExportInUseError extends Error {
  constructor(
    public readonly stack: string,
    public readonly uses: CfnExportInUse[],
  ) {
    const importers = [...new Set(uses.flatMap((u) => u.importers))].sort();
    super(
      `cfn-deploy "${stack}": refusing the plan: ` +
        uses
          .map((u) => `it ${u.change.replace("{export}", `export ${u.exportName}`)}, which ${u.importers.length === 1 ? "stack" : "stacks"} ${u.importers.join(", ")} still ${u.importers.length === 1 ? "imports" : "import"}`)
          .join("; ") +
        `. CloudFormation refuses to change or remove an export another stack imports. Change ${importers.join(", ")} to stop importing it first, then change ${stack}.`,
    );
    this.name = "CfnExportInUseError";
  }
}

/**
 * The exports `stack` has now that this plan changes or removes while
 * another stack imports them (#4466c). An export the new template no longer
 * declares is removed; one whose planned value differs from the value it
 * has is changed: both throw {@link CfnExportInUseError}. One the plan
 * cannot say about (its output's value is known only after apply, or an
 * export name in the new template does not resolve) is a hole naming the
 * importers. Asks `ListImports` only for exports at stake, and nothing at
 * all when the executor cannot list imports or the stack exports nothing.
 */
async function exportsInUse(
  executor: CloudExecutor,
  stack: string,
  input: CfnDeployInput,
  parameters: Record<string, string>,
  planned: PlannedOutputs | undefined,
  standing: () => Promise<CfnStackStatus | undefined>,
): Promise<ChangeSetHole[]> {
  const listImports = executor.cloudformation.listImports?.bind(executor.cloudformation);
  if (!listImports) return [];
  const was = (await standing())?.exports;
  if (!was || Object.keys(was).length === 0) return [];
  const template = readCfnTemplate(input.template);
  if (!template) return [];
  const declared = cfnExports(template, cfnKnownValues(template, stack, parameters));
  const now = new Map(declared.filter((e): e is { output: string; name: string } => "name" in e).map((e) => [e.name, e.output]));
  const unresolvedNow = declared.some((e) => "unresolved" in e);
  const refused: CfnExportInUse[] = [];
  const holes: ChangeSetHole[] = [];
  for (const [exportName, { output, value }] of Object.entries(was).sort(([a], [b]) => a.localeCompare(b))) {
    const at = now.get(exportName);
    let change: string | undefined;
    let maybe: string | undefined;
    if (at === undefined) {
      if (unresolvedNow) maybe = `may remove export ${exportName}: an export name the template declares does not resolve at plan`;
      else change = "removes {export}";
    } else {
      const next = planned?.known[at];
      if (next === undefined) maybe = `may change export ${exportName}: the value of output ${at} is known only after apply`;
      else if ((typeof next === "string" ? next : JSON.stringify(next)) !== value) change = `changes {export} from ${value} to ${typeof next === "string" ? next : JSON.stringify(next)}`;
    }
    if (change === undefined && maybe === undefined) continue;
    let importers: string[];
    try {
      importers = (await listImports(exportName)).filter((s) => s !== stack);
    } catch (err) {
      // A backend without ListImports (an emulator, say) cannot say who imports it; the plan says so instead of failing.
      holes.push({
        address: `Outputs.${at ?? output}`,
        reason: `the plan ${change?.replace("{export}", `export ${exportName}`) ?? maybe}, and the stacks that import it could not be listed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    if (importers.length === 0) continue;
    if (change !== undefined) refused.push({ exportName, change, importers });
    else {
      holes.push({
        address: `Outputs.${at ?? output}`,
        reason: `the plan ${maybe}, and ${importers.join(", ")} still ${importers.length === 1 ? "imports" : "import"} it; CloudFormation refuses the apply if it changes`,
      });
    }
  }
  if (refused.length > 0) throw new CfnExportInUseError(stack, refused);
  return holes;
}

/**
 * Thrown when a changeset proposes a resource replacement and `onReplace` is
 * `"block"` (the default) — refusing to apply rather than silently destroying
 * and recreating a resource, which for a stateful resource (a DynamoDB table,
 * an RDS instance) means data loss. Carries the specific resources CloudFormation
 * proposed replacing, so the caller/human reviewing the changeset knows exactly
 * what was refused.
 */
export class CfnReplacementBlockedError extends Error {
  constructor(
    public readonly stack: string,
    public readonly replacements: CfnChange[],
  ) {
    super(
      `cfn-deploy "${stack}": refusing changeset — it would replace ${replacements.length} resource(s) ` +
        `(${replacements.map((r) => r.logicalResourceId).join(", ")}) and onReplace is "block". ` +
        `Re-run with onReplace: "allow" or "snapshot-first" to proceed.`,
    );
    this.name = "CfnReplacementBlockedError";
  }
}

/**
 * Deploy a CloudFormation stack: create a changeset, apply the declarative
 * safety policy against its proposed changes, then execute (or refuse) it and
 * wait for the stack to reach a terminal status.
 *
 * - `onReplace: "block"` (default) — `CfnReplacementBlockedError` if any
 *   change requires replacement; the changeset is left/deleted unexecuted.
 * - `onReplace: "allow"` — executes regardless of replacement.
 * - `onReplace: "snapshot-first"` — takes a `snapshot-before`-style capture
 *   (via `executor.cloudformation`'s DynamoDB/RDS-aware snapshot, when the
 *   replaced resource is a stateful type) before executing.
 * - `stageGsi` records intent only in this phase (the real add→backfill→remove
 *   staging is DynamoDB-specific choreography layered on top of the plain
 *   changeset apply; Phase 1 surfaces the option and passes it through
 *   uninterpreted rather than half-implementing GSI staging, since staging
 *   requires a second follow-up deploy the single-step `cfn-deploy` capability
 *   does not orchestrate on its own).
 *
 * Rollback: trigger CloudFormation's native `rollback-stack` — the stack's own
 * automatic-rollback mechanism restores the last known-good state.
 */
export function createCfnDeployCapability(
  executor: CloudExecutor = defaultCloudExecutor(),
): Capability<CfnDeployInput, CfnDeployOutput> {
  return {
    kind: "cfn-deploy",
    // #4300: a change set covers the whole template, so there is nothing to narrow.
    targets: { refuse: "a CloudFormation change set covers the whole stack, so cfn-deploy can't narrow to some of its resources" },
    plan(ctx, input) {
      return planCfnDeploy(executor, ctx, input);
    },
    declaredReads(ctx, members) {
      return cfnDeclaredReads(ctx.root, members);
    },
    async outputs(ctx, input) {
      // The outputs the stack has now, for a dependent planned before it
      // applies (#3183). A stack that does not exist yet has none.
      try {
        return (await executor.cloudformation.describeStack(input.stack ?? ctx.component)).outputs;
      } catch (err) {
        if (STACK_MISSING.test(err instanceof Error ? err.message : String(err))) return {};
        throw err;
      }
    },
    async run(ctx, input) {
      // #4537: `run --components <name> --adopt <file>` adopts into this stack instead of a plain deploy.
      if (ctx.adoption) {
        const { runCfnAdoption } = await import("./cfn-adopt-run");
        return runCfnAdoption(executor, ctx, input, ctx.adoption);
      }
      const stack = input.stack ?? ctx.component;
      const onReplace = input.onReplace ?? "block";
      const changeSet = await executor.cloudformation.createChangeSet({
        stackName: stack,
        templatePath: input.template,
        parameters: flattenCfnInputs(input),
      });

      // Handed the plan the approver approved (#3997), apply only a change
      // set that proposes the same changes. Anything else means the stack,
      // the template or the parameters moved since the plan.
      const planned = ctx.plans?.[stack];
      if (isCfnShapeArtifact(planned)) {
        // A member planned before its inputs were known (#4419): the change
        // set made now is against the real values. It must have the shape the
        // preview had, differing only in what the unknown inputs drive.
        const differences = planShapeDifferences(planned.shape, cfnPlanShape(stack, changeSet, []));
        if (differences.length > 0) {
          await cleanUpPlanChangeSet(executor, changeSet);
          throw new PlanShapeMovedError(stack, differences);
        }
      } else if (isCfnPlanArtifact(planned)) {
        const now = cfnChangesDigest(stack, changeSet);
        if (now !== planned.changesDigest) {
          await cleanUpPlanChangeSet(executor, changeSet);
          throw new CfnPlanMovedError(stack, planned.changesDigest, now);
        }
      }

      // An unchanged stack yields a change set with nothing to apply.
      // `execute-change-set` rejects it ("The submitted information didn't
      // contain changes"), which would fail this component and stop the whole
      // run — so a re-run of `--components all` dies on the first already-current
      // stack. Treat it as an idempotent no-op success instead: delete the empty
      // change set and report the stack's current status/outputs so downstream
      // steps still get real outputs and the run proceeds (#960).
      if (isNoopChangeSet(changeSet)) {
        await executor.cloudformation.deleteChangeSet({
          stackName: stack,
          changeSetName: changeSet.changeSetName,
        });
        const { stackStatus, outputs } = await executor.cloudformation.describeStack(stack);
        return { stackStatus, outputs };
      }

      const replacements = blockedReplacements(changeSet.changes);
      let snapshotId: string | undefined;

      if (replacements.length > 0 && onReplace === "block") {
        await executor.cloudformation.deleteChangeSet({
          stackName: stack,
          changeSetName: changeSet.changeSetName,
        });
        throw new CfnReplacementBlockedError(stack, replacements);
      }

      if (replacements.length > 0 && onReplace === "snapshot-first") {
        // Phase 1: record which resources were replaced so the caller/audit
        // trail has the fact captured; a dedicated `snapshot-before` capability
        // handles resource-specific (DynamoDB/RDS/OpenSearch) capture and is
        // composed ahead of `cfn-deploy` in the component's own phase list
        // when the sticky resource needs a real point-in-time backup.
        snapshotId = `pending-snapshot:${stack}:${replacements.map((r) => r.logicalResourceId).join(",")}`;
      }

      await executor.cloudformation.executeChangeSet({
        stackName: stack,
        changeSetName: changeSet.changeSetName,
      });
      const { stackStatus, outputs } = await executor.cloudformation.waitForStack(stack);
      // `waitForStack` returns on any terminal (`*_COMPLETE`/`*_FAILED`) status,
      // including the failure ones: a create that fails rolls back to
      // `ROLLBACK_COMPLETE`, an update to `UPDATE_ROLLBACK_COMPLETE`, and hard
      // failures end in `*_FAILED`. Treating those as success would report a
      // failed deploy as green (and hand downstream steps an empty `outputs`),
      // so throw — the same fail-closed contract the rest of the release model
      // relies on.
      // A missing status is fail-closed too: Floci's describe-stacks can omit
      // StackStatus mid-rollback, and `undefined.includes` would throw a TypeError
      // that masks the real deploy failure (#947).
      if (!stackStatus || stackStatus.includes("ROLLBACK") || stackStatus.endsWith("_FAILED")) {
        throw new Error(
          `cfn-deploy "${stack}": stack reached ${stackStatus ?? "an indeterminate status"} — the deploy failed and was rolled back. Inspect the stack events for the resource that failed to create/update.`,
        );
      }
      return { stackStatus, outputs, ...(snapshotId ? { snapshotId } : {}) };
    },
    async rollback(ctx, input) {
      const stack = input.stack ?? ctx.component;
      try {
        await executor.cloudformation.rollbackStack(stack);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Local emulators (Floci) don't implement RollbackStack → `UnknownAction`.
        // The stack is already in a terminal failed state; degrade to a clear
        // message instead of crashing the compensation phase (#947).
        if (/UnknownAction|not supported/i.test(message)) {
          console.error(
            `cfn-deploy rollback "${stack}": the target doesn't support RollbackStack (a local emulator such as Floci) — skipping automated rollback. Original: ${message}`,
          );
          return;
        }
        throw err;
      }
    },
  };
}

/** Flatten the wired `inputs` map plus `imageRef` (already resolved by the driver) to plain string CloudFormation parameters. */
export function flattenCfnInputs(input: CfnDeployInput): Record<string, string> | undefined {
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.inputs ?? {})) {
    params[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  if (input.imageRef) params.ImageRef = input.imageRef;
  return Object.keys(params).length > 0 ? params : undefined;
}

/** Default `cfn-deploy` capability, backed by the real `CloudExecutor`. */
export const cfnDeployCapability: Capability<CfnDeployInput, CfnDeployOutput> = createCfnDeployCapability();

// ── ecs-update-service ──────────────────────────────────────────────────────

export interface EcsUpdateServiceInput {
  /** ECS cluster name or ARN. */
  cluster: string;
  /** ECS service name. */
  service: string;
  /** Task definition/image reference to roll out (e.g. `"@Publish.digest"`). */
  imageRef?: string;
  /** Desired task count. Omit to leave unchanged. */
  desiredCount?: number;
  /** Force a new deployment even if the task definition is unchanged. Default: false. */
  forceNewDeployment?: boolean;
}

export interface EcsUpdateServiceOutput {
  /** ARN of the new/updated service deployment. */
  deploymentId: string;
  /**
   * The task definition the service ran before this step updated it, read with
   * `describe-services` ahead of `update-service`. The rollback sends it back.
   * Absent when the service could not be described or reported none (#2609).
   */
  previousTaskDefinition?: string;
  /** The service's desired count before this step, recorded only when the step sets `desiredCount`. */
  previousDesiredCount?: number;
}

/**
 * Roll a new task definition/image out to an ECS service via `UpdateService`.
 * Before the update, `run` reads the service with `describe-services` and
 * records the task definition it was running in its output. The rollback sends
 * that previous task definition back (and the previous desired count, when the
 * step changed it). The step's own `imageRef` is never the rollback target:
 * it is the revision the step just rolled out, so re-sending it restores
 * nothing (#2609). When the previous task definition could not be read, the
 * rollback fails with a message naming the service rather than report a
 * restore that changed nothing (#2605). A component that needs a specific
 * task definition restored can still give itself an explicit rollback phase,
 * such as `rollback-previous` with that `taskDefinition`.
 */
export function createEcsUpdateServiceCapability(
  executor: CloudExecutor = defaultCloudExecutor(),
): Capability<EcsUpdateServiceInput, EcsUpdateServiceOutput> {
  return {
    kind: "ecs-update-service",
    async run(_ctx, input) {
      // A failed read only costs the rollback its target; the forward update
      // still runs, and the rollback then fails saying it has nothing to restore.
      const before = await executor.ecs.describeService(input.cluster, input.service).catch(() => undefined);
      const { deploymentId } = await executor.ecs.updateService({
        cluster: input.cluster,
        service: input.service,
        taskDefinition: input.imageRef,
        desiredCount: input.desiredCount,
        forceNewDeployment: input.forceNewDeployment,
      });
      return {
        deploymentId,
        ...(before?.taskDefinition ? { previousTaskDefinition: before.taskDefinition } : {}),
        ...(before && input.desiredCount !== undefined ? { previousDesiredCount: before.desiredCount } : {}),
      };
    },
    async rollback(_ctx, input, output) {
      const previous = output?.previousTaskDefinition;
      if (!previous) {
        throw new Error(
          `ecs-update-service rollback: the task definition service "${input.service}" ran before the step ` +
            `was not recorded, so there is nothing to roll back to; ` +
            `give the component a rollback phase that names the taskDefinition`,
        );
      }
      await executor.ecs.rollbackService({
        cluster: input.cluster,
        service: input.service,
        taskDefinition: previous,
        desiredCount: output?.previousDesiredCount,
      });
    },
  };
}

/** Default `ecs-update-service` capability, backed by the real `CloudExecutor`. */
export const ecsUpdateServiceCapability: Capability<EcsUpdateServiceInput, EcsUpdateServiceOutput> =
  createEcsUpdateServiceCapability();

// ── lambda-deploy ────────────────────────────────────────────────────────────

export interface LambdaDeployInput {
  /** Function name or ARN. */
  functionName: string;
  /** Reference to the packaged code — an image URI (e.g. `"@Publish.uri"` from `publish-image`) for a container-image function. */
  codeRef: string;
  /** Publish a new immutable version after updating code. Default: true. */
  publish?: boolean;
  /** Alias to repoint at the new version (e.g. "live"). */
  alias?: string;
}

export interface LambdaDeployOutput {
  /** Published function version. */
  version: string;
  /** Function ARN (version-qualified if `publish` was true). */
  functionArn: string;
}

/**
 * Update a Lambda function's code to a new container image, wait for the
 * update to apply, and (by default) publish an immutable version and repoint
 * `alias` at it — the same digest-promotion invariant every other apply verb
 * follows (`imageRef`/`codeRef` is a resolved `publish-image` digest, never a
 * rebuild). Rollback restores whatever version `alias` pointed at before this
 * step ran (captured up front), repointing the alias back — mirroring
 * `ecs-update-service`'s best-effort re-apply style rather than a native
 * automatic rollback (Lambda has none for code updates).
 */
export function createLambdaDeployCapability(
  executor: CloudExecutor = defaultCloudExecutor(),
): Capability<LambdaDeployInput, LambdaDeployOutput> {
  const previousVersionByTarget = new Map<string, string | undefined>();

  return {
    kind: "lambda-deploy",
    async run(_ctx, input) {
      const alias = input.alias ?? "live";
      if (!previousVersionByTarget.has(input.functionName)) {
        previousVersionByTarget.set(
          input.functionName,
          await executor.lambda.getAliasVersion(input.functionName, alias),
        );
      }

      const { functionArn } = await executor.lambda.updateFunctionCode({
        functionName: input.functionName,
        imageUri: input.codeRef,
      });
      const { status } = await executor.lambda.waitForUpdate(input.functionName);
      if (status !== "Successful") {
        throw new Error(`lambda-deploy "${input.functionName}": code update ended "${status}"`);
      }

      if (input.publish === false) {
        return { version: "$LATEST", functionArn };
      }
      const published = await executor.lambda.publishVersion({ functionName: input.functionName });
      await executor.lambda.updateAlias({ functionName: input.functionName, alias, version: published.version });
      return { version: published.version, functionArn: published.functionArn };
    },
    async rollback(_ctx, input) {
      const alias = input.alias ?? "live";
      const previousVersion = previousVersionByTarget.get(input.functionName);
      if (!previousVersion) return; // no prior alias version recorded — nothing to restore.
      await executor.lambda.updateAlias({ functionName: input.functionName, alias, version: previousVersion });
    },
  };
}

/** Default `lambda-deploy` capability, backed by the real `CloudExecutor`. */
export const lambdaDeployCapability: Capability<LambdaDeployInput, LambdaDeployOutput> = createLambdaDeployCapability();

// ── s3-sync ──────────────────────────────────────────────────────────────────

export interface S3SyncInput {
  /** Local path or archive-relative path to sync from. */
  from: string;
  /** Destination S3 URI (e.g. `s3://bucket/prefix`). */
  to: string;
  /** Delete destination keys not present in the source. Default: false. */
  delete?: boolean;
}

export interface S3SyncOutput {
  /** Number of objects uploaded. */
  uploaded: number;
  /** Number of objects deleted (when `delete: true`). */
  deleted: number;
}

/** Sync a directory of static assets to an S3 bucket via `aws s3 sync` (endpoint-aware through the `CloudExecutor`). */
export function createS3SyncCapability(executor: CloudExecutor = defaultCloudExecutor()): Capability<S3SyncInput, S3SyncOutput> {
  return {
    kind: "s3-sync",
    rollbackPolicy: "needs-opt-out",
    async run(_ctx, input) {
      return executor.s3.sync({ from: input.from, to: input.to, delete: input.delete });
    },
  };
}

/** Default `s3-sync` capability, backed by the real `CloudExecutor`. */
export const s3SyncCapability: Capability<S3SyncInput, S3SyncOutput> = createS3SyncCapability();

// ── cdn-invalidate ───────────────────────────────────────────────────────────

export interface CdnInvalidateInput {
  /** CloudFront distribution id. */
  distributionId: string;
  /** Path patterns to invalidate. Default: `["/*"]`. */
  paths?: string[];
}

export interface CdnInvalidateOutput {
  /** Invalidation batch id, for polling completion. */
  invalidationId: string;
}

/** Invalidate CDN cache paths after a content update (e.g. following `s3-sync`), via `aws cloudfront create-invalidation`. */
export function createCdnInvalidateCapability(executor: CloudExecutor = defaultCloudExecutor()): Capability<CdnInvalidateInput, CdnInvalidateOutput> {
  return {
    kind: "cdn-invalidate",
    rollbackPolicy: "needs-opt-out",
    async run(_ctx, input) {
      return executor.cloudfront.createInvalidation({
        distributionId: input.distributionId,
        paths: input.paths ?? ["/*"],
      });
    },
  };
}

/** Default `cdn-invalidate` capability, backed by the real `CloudExecutor`. */
export const cdnInvalidateCapability: Capability<CdnInvalidateInput, CdnInvalidateOutput> = createCdnInvalidateCapability();

// ── run-migration ────────────────────────────────────────────────────────────

/**
 * Where a migration runs. Discriminated on `via` so the composition grammar
 * stays honest about the transport (each is a different AWS surface), while the
 * verb reports a single `{applied, version}` regardless.
 * - `ecs-task`: run the migration image as a one-off ECS/Fargate task (the most
 *   common DB-migration transport — a Rails/Django/Flyway `migrate` container).
 * - `lambda`: synchronously invoke a migration function.
 * - `host`: run a migration command on an SSM-managed host (reuses the same
 *   transport as `remote-exec`).
 */
export type MigrationTarget =
  | {
      via: "ecs-task";
      cluster: string;
      taskDefinition: string;
      /** Container to override the command on; defaults to the task def's single container. */
      container?: string;
      /** Command (argv) the migration runs; omit to use the task def's own command. */
      command?: string[];
      launchType?: "FARGATE" | "EC2";
      subnets?: string[];
      securityGroups?: string[];
      assignPublicIp?: boolean;
    }
  | { via: "lambda"; function: string; payload?: string }
  | { via: "host"; host: string; command: string; cwd?: string };

export interface RunMigrationInput {
  /** Migration tool/runner identifier (e.g. "flyway", "prisma", "custom"). Informational — recorded for provenance, does not change the transport. */
  tool: string;
  /** Where the migration runs. */
  target: MigrationTarget;
  /** Reference to the migration artifact (e.g. `"@Publish.digest"` for a migration image). Informational. */
  artifactRef?: string;
}

export interface RunMigrationOutput {
  /** True if any migrations were applied (false if already up to date, when the runner reports it). */
  applied: boolean;
  /** Migration version/checksum reached, when the runner reports one (empty string otherwise). */
  version: string;
}

/**
 * A runner that reports its outcome does so as a trailing JSON object
 * `{"applied":bool,"version":"..."}` — on stdout (host) or in the Lambda
 * response payload. Parse the last such line; when the runner emits nothing
 * parseable, fall back to `applied` = "the process exited cleanly" and an empty
 * version (an ECS task exposes only its exit code — no captured stdout — so it
 * always takes this fallback).
 */
function parseMigrationReport(text: string, appliedFallback: boolean): RunMigrationOutput {
  for (const line of text.split("\n").map((l) => l.trim()).reverse()) {
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as { applied?: boolean; version?: string };
      if (typeof parsed.applied === "boolean" || typeof parsed.version === "string") {
        return { applied: parsed.applied ?? appliedFallback, version: parsed.version ?? "" };
      }
    } catch {
      // not the report line — keep scanning older lines.
    }
  }
  return { applied: appliedFallback, version: "" };
}

/**
 * Run a database/schema migration against a target as a deploy step, dispatching
 * on the target transport (ECS one-off task, Lambda invoke, or SSM host command)
 * through the injectable `CloudExecutor`. A non-clean outcome (non-zero exit, a
 * Lambda `FunctionError`) throws so the phase fails rather than proceeding on an
 * unmigrated schema.
 */
export function createRunMigrationCapability(executor: CloudExecutor = defaultCloudExecutor()): Capability<RunMigrationInput, RunMigrationOutput> {
  return {
    kind: "run-migration",
    rollbackPolicy: "needs-opt-out",
    async run(_ctx, input) {
      const target = input.target;
      switch (target.via) {
        case "ecs-task": {
          const { taskArn } = await executor.ecs.runTask({
            cluster: target.cluster,
            taskDefinition: target.taskDefinition,
            container: target.container,
            command: target.command,
            launchType: target.launchType,
            subnets: target.subnets,
            securityGroups: target.securityGroups,
            assignPublicIp: target.assignPublicIp,
          });
          const result = await executor.ecs.waitForTask(target.cluster, taskArn);
          if (result.exitCode !== 0) {
            throw new Error(
              `run-migration (ecs-task ${target.cluster}): task ${result.lastStatus} with exit ${result.exitCode ?? "none"}${result.stoppedReason ? ` (${result.stoppedReason})` : ""}`,
            );
          }
          return { applied: true, version: "" };
        }
        case "lambda": {
          const res = await executor.lambda.invoke({ functionName: target.function, payload: target.payload });
          if (res.functionError) {
            throw new Error(`run-migration (lambda ${target.function}): ${res.functionError} — ${res.payload.trim()}`);
          }
          return parseMigrationReport(res.payload, true);
        }
        case "host": {
          const { stdout, exitCode } = await executor.host.exec({ host: target.host, command: target.command, cwd: target.cwd });
          if (exitCode !== 0) {
            throw new Error(`run-migration (host ${target.host}): command exited ${exitCode}`);
          }
          return parseMigrationReport(stdout, true);
        }
      }
    },
  };
}

/** Default `run-migration` capability, backed by the real `CloudExecutor`. */
export const runMigrationCapability: Capability<RunMigrationInput, RunMigrationOutput> = createRunMigrationCapability();
