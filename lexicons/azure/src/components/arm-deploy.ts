/**
 * `arm-deploy`: the azure lexicon's apply step for components (#4273). It
 * applies a built ARM template into one resource group through `azApply`
 * (../op/activities/az-apply.ts), the same per-resource applier `ApplyOp`'s
 * `arm` target and the floci-az lane use, so a component step, an Op and the
 * emulator run share one code path.
 *
 * `plan` reads each template resource live with the read client
 * (../api/read-client.ts) and compares it with the body `azApply` would PUT,
 * normalized with the noise rules deep observation uses
 * (../deep-observe.ts). A resource that is not there is a create, one whose
 * claimed properties all match is a no-op, and one that differs is an update
 * with each changed path before and after. With `prune: true`, each
 * chant-owned resource in the group the template no longer declares is a
 * delete, the set `pruneArmOrphans` would delete.
 *
 * ARM's PUT is a create-or-update with no preview, so the plan cannot ask
 * Azure what would change the way `cfn-deploy` asks for a change set. What
 * holds the apply to the approved plan is the digest: `run` plans again and
 * applies only when it gets the approved one.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Capability, CapabilityPlan, DeployContext, PlannedOutputs } from "@intentius/chant/components/capability";
import type { ChangeSetAttribute, ChangeSetEntry, ChangeSetHole, ChangeSetPart } from "@intentius/chant/change-set";
import { MASKED, UNRESOLVED, deepPathSet, flattenDeepProperties, normalizeDeepProperties } from "@intentius/chant/deep-observation";
import { diffDeep } from "@intentius/chant/lifecycle/deep-diff";
import { computePlanDigest } from "@intentius/chant/lifecycle/plan-digest";
import { AzureReadError, getResource, isNotFound, listResources, type AzureReadClientOptions } from "../api/read-client";
import { azureDeepNormalizationHooks, buildLiveProperties, type ArmResourceShowResponse } from "../deep-observe";
import { classifyArmFailure } from "../describe-resources";
import {
  armDependencies,
  azApply,
  evalArm,
  evalArmString,
  isChantOwned,
  orderArmResources,
  rememberDeployed,
  type ArmEvalCtx,
  type ArmResource,
  type AzHttp,
  type AzNotPrunable,
} from "../op/activities/az-apply";

/** floci-az's local subscription, the applier's default too. */
const DEFAULT_SUBSCRIPTION = "00000000-0000-0000-0000-000000000001";
const DEFAULT_ENDPOINT = "https://management.azure.com";
const DEFAULT_LOCATION = "eastus";

export interface ArmDeployInput {
  /** Path to the built ARM template (`deploymentTemplate.json`). */
  template: string;
  /** The resource group the template applies into. Default: the component's name. */
  resourceGroup?: string;
  /** Region for the group and for `resourceGroup().location`. Default: `eastus`. */
  location?: string;
  /** ARM endpoint. Default: `AZURE_ENDPOINT_URL`, else real Azure. */
  endpoint?: string;
  /** Subscription id. Default: `AZURE_SUBSCRIPTION_ID`, else floci-az's local subscription. */
  subscriptionId?: string;
  /** Delete chant-owned resources of the group the template no longer declares. Default: false. */
  prune?: boolean;
}

export interface ArmDeployOutput {
  applied: Array<{ type: string; name: string }>;
  pruned: Array<{ type: string; name: string; deleted: boolean }>;
  notPrunable: AzNotPrunable[];
  /** The template's `outputs`, evaluated against the group once it applied. */
  outputs: Record<string, unknown>;
}

/** What an `arm-deploy` plan hands `run` through `DeployContext.plans[resourceGroup]`. */
export interface ArmDeployPlanArtifact {
  kind: "arm-deploy-plan";
  resourceGroup: string;
  planDigest: string;
}

function isArmDeployPlanArtifact(value: unknown): value is ArmDeployPlanArtifact {
  const v = value as Partial<ArmDeployPlanArtifact> | undefined;
  return v?.kind === "arm-deploy-plan" && typeof v.resourceGroup === "string" && typeof v.planDigest === "string";
}

/**
 * Thrown by `run` when planning again gives another digest than the approved
 * plan: the group, the template or the endpoint moved since. Nothing is
 * applied. `planMoved` is core's mark for a moved plan, so the command exits 3.
 */
export class ArmDeployPlanMovedError extends Error {
  readonly planMoved = true;
  constructor(
    public readonly resourceGroup: string,
    public readonly planned: string,
    public readonly now: string,
  ) {
    super(
      `arm-deploy "${resourceGroup}": refusing to apply. Planning again gives ${now}, the approved plan was ${planned}; ` +
        `the resource group or its template changed since. Plan it again.`,
    );
    this.name = "ArmDeployPlanMovedError";
  }
}

/** The settings a step resolves to, environment included. Read at call time so a test or an emulator lane can set them. */
interface Target {
  resourceGroup: string;
  location: string;
  endpoint: string;
  subscriptionId: string;
}

function targetOf(ctx: DeployContext, input: ArmDeployInput): Target {
  return {
    resourceGroup: input.resourceGroup ?? ctx.component,
    location: input.location ?? DEFAULT_LOCATION,
    endpoint: (input.endpoint ?? process.env.AZURE_ENDPOINT_URL ?? DEFAULT_ENDPOINT).replace(/\/$/, ""),
    subscriptionId: input.subscriptionId ?? process.env.AZURE_SUBSCRIPTION_ID ?? DEFAULT_SUBSCRIPTION,
  };
}

function evalCtxOf(target: Target, http: AzHttp): ArmEvalCtx {
  return {
    subscriptionId: target.subscriptionId,
    resourceGroup: target.resourceGroup,
    location: target.location,
    deployed: new Map(),
    http,
    base: target.endpoint,
  };
}

function clientOf(target: Target, http: AzHttp): AzureReadClientOptions {
  return { endpoint: target.endpoint, subscriptionId: target.subscriptionId, resourceGroup: target.resourceGroup, http };
}

interface ArmTemplate {
  resources?: ArmResource[];
  outputs?: Record<string, { type?: string; value?: unknown }>;
}

function readTemplate(path: string): ArmTemplate {
  return JSON.parse(readFileSync(path, "utf8")) as ArmTemplate;
}

function templateDigest(path: string): string | null {
  try {
    return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
  } catch {
    return null;
  }
}

/**
 * A 404 that means the resource is not there, as opposed to one that means the
 * subscription is not: ARM answers `SubscriptionNotFound` with a 404 too, and
 * planning every resource as a create on that answer would be wrong. A missing
 * resource group is absence, since `azApply` creates the group first.
 */
function isAbsent(err: unknown): boolean {
  return isNotFound(err) && !(err instanceof AzureReadError && /^SubscriptionNotFound$/i.test(err.code ?? ""));
}

// ── The declared side ────────────────────────────────────────────────────────

/** An expression that reads a resource's runtime state, which only an apply knows. */
const RUNTIME_READ = /\b(reference|list[A-Za-z]*)\s*\(/;

/**
 * Evaluate one string the way `azApply` would, leaving an expression that
 * reads runtime state (`reference()`, `listKeys()`) or uses a function the
 * evaluator lacks as written. The noise rules read a bracket expression on
 * the declared side as unresolved, so it is never compared, and the plan
 * makes no `listKeys` call.
 */
async function evalStaticString(s: string, ctx: ArmEvalCtx): Promise<unknown> {
  if (!(s.startsWith("[") && s.endsWith("]")) || s.startsWith("[[")) return evalArmString(s, ctx);
  if (RUNTIME_READ.test(s)) return s;
  try {
    return await evalArmString(s, ctx);
  } catch {
    return s;
  }
}

async function evalStatic(value: unknown, ctx: ArmEvalCtx): Promise<unknown> {
  if (typeof value === "string") return evalStaticString(value, ctx);
  if (Array.isArray(value)) return Promise.all(value.map((v) => evalStatic(v, ctx)));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[String(await evalStaticString(k, ctx))] = await evalStatic(v, ctx);
    return out;
  }
  return value;
}

/**
 * The fields `azApply` PUTs for a resource, in the flat shape deep
 * observation reads a live resource into. The ownership tags `azApply` adds
 * are left out: the noise rules drop them from the live side too.
 */
async function declaredTree(resource: ArmResource, name: string, ctx: ArmEvalCtx): Promise<Record<string, unknown>> {
  const body: ArmResourceShowResponse = { name };
  if (resource.location !== undefined) body.location = (await evalStatic(resource.location, ctx)) as string;
  for (const field of ["sku", "kind", "identity", "tags", "zones", "plan", "properties"] as const) {
    if (resource[field] !== undefined) (body as Record<string, unknown>)[field] = await evalStatic(resource[field], ctx);
  }
  return buildLiveProperties(body, name);
}

// ── The plan ─────────────────────────────────────────────────────────────────

/** One template resource as the plan read it. */
interface PlannedResource {
  resource: ArmResource;
  name: string;
  action: "create" | "update" | "no-op" | "unread";
}

interface ArmPlanResult {
  entries: ChangeSetEntry[];
  holes: ChangeSetHole[];
  resources: PlannedResource[];
  /** The live bodies read, remembered for `reference()`. */
  live: ArmEvalCtx;
  template: ArmTemplate;
}

function attributeOf(path: string, before: unknown, after: unknown, hasBefore: boolean, hasAfter: boolean): ChangeSetAttribute {
  if (before === MASKED || after === MASKED) return { path, sensitive: true };
  if (after === UNRESOLVED) return { path, ...(hasBefore ? { before } : {}), unknown: true };
  return { path, ...(hasBefore ? { before } : {}), ...(hasAfter ? { after } : {}) };
}

/** Read the group and compare it with the template. Pure apart from GETs. */
async function readPlan(member: string, target: Target, input: ArmDeployInput, http: AzHttp): Promise<ArmPlanResult> {
  const template = readTemplate(input.template);
  const resources = template.resources ?? [];
  const ctx = evalCtxOf(target, http);
  const client = clientOf(target, http);
  const entries: ChangeSetEntry[] = [];
  const holes: ChangeSetHole[] = [];
  const planned: PlannedResource[] = [];
  const base = (type: string, name: string) => ({
    member,
    lexicon: "azure",
    planner: "chant" as const,
    address: `${type}/${name}`,
    type,
    name,
  });

  for (const resource of orderArmResources(resources)) {
    const name = String(await evalStaticString(resource.name, ctx));
    const address = `${resource.type}/${name}`;
    if (name.startsWith("[")) {
      holes.push({ address, type: resource.type, reason: "the resource's name reads runtime state; known only at apply" });
      planned.push({ resource, name, action: "unread" });
      continue;
    }
    const declaredRaw = await declaredTree(resource, name, ctx);
    let live: ArmResourceShowResponse | undefined;
    try {
      live = (await getResource(client, resource.type, name, resource.apiVersion)) as ArmResourceShowResponse;
    } catch (err) {
      if (!isAbsent(err)) {
        const failure = classifyArmFailure(err);
        holes.push({ address, type: resource.type, reason: `${failure.reason}: ${failure.detail}` });
        planned.push({ resource, name, action: "unread" });
        continue;
      }
    }
    const opts = { entityType: resource.type, hooks: azureDeepNormalizationHooks };

    if (!live) {
      const declared = normalizeDeepProperties(declaredRaw, { ...opts, side: "declared" });
      const attributes = [...flattenDeepProperties(declared, { ...opts, side: "declared" })]
        .map(([path, value]) => attributeOf(path, undefined, value, false, true))
        .sort((a, b) => a.path.localeCompare(b.path));
      entries.push({ ...base(resource.type, name), action: "create", attributes });
      planned.push({ resource, name, action: "create" });
      continue;
    }

    rememberDeployed(ctx, resource.type, name, live);
    const liveRaw = buildLiveProperties(live, name);
    const declared = normalizeDeepProperties(declaredRaw, { ...opts, side: "declared", counterpartPaths: deepPathSet(liveRaw) });
    const liveTree = normalizeDeepProperties(liveRaw, { ...opts, side: "live", counterpartPaths: deepPathSet(declaredRaw) });
    const diff = diffDeep({
      declared: { [address]: { type: resource.type, properties: declared } },
      live: { resources: { [address]: { type: resource.type, properties: liveTree } }, unobserved: {} },
      hooks: azureDeepNormalizationHooks,
    });
    // A masked value ARM does not return (a password) is write-only, not a change.
    const changes = (diff.drifted[0]?.changes ?? []).filter((c) => !(c.kind === "absent" && c.declared === MASKED));
    const id = typeof live.id === "string" ? { id: live.id } : {};
    if (changes.length === 0) {
      entries.push({ ...base(resource.type, name), ...id, action: "no-op", attributes: [] });
      planned.push({ resource, name, action: "no-op" });
      continue;
    }
    const attributes = changes
      .map((c) => attributeOf(c.path, c.live, c.declared, c.kind === "changed", true))
      .sort((a, b) => a.path.localeCompare(b.path));
    entries.push({ ...base(resource.type, name), ...id, action: "update", disruption: "in-place", attributes });
    planned.push({ resource, name, action: "update" });
  }

  if (input.prune) {
    // The set `pruneArmOrphans` deletes: chant-owned, of any type, and not declared by (type, name).
    const keep = new Set(planned.map((p) => `${p.resource.type}\0${p.name}`));
    try {
      for (const item of await listResources(client)) {
        if (typeof item.type !== "string" || typeof item.name !== "string") continue;
        if (!isChantOwned(item.tags)) continue;
        if (keep.has(`${item.type}\0${item.name}`)) continue;
        entries.push({
          ...base(item.type, item.name),
          ...(typeof item.id === "string" ? { id: item.id } : {}),
          action: "delete",
          disruption: "destroy",
          attributes: [],
        });
      }
    } catch (err) {
      if (!isAbsent(err)) {
        const failure = classifyArmFailure(err);
        holes.push({ address: target.resourceGroup, type: "Microsoft.Resources/resourceGroups", reason: `prune not read: ${failure.reason}: ${failure.detail}` });
      }
    }
  }

  entries.sort((a, b) => a.address.localeCompare(b.address));
  holes.sort((a, b) => a.address.localeCompare(b.address));
  return { entries, holes, resources: planned, live: ctx, template };
}

function armPlanDigest(ctx: DeployContext, target: Target, input: ArmDeployInput, unresolved: string[], plan?: Pick<ArmPlanResult, "entries" | "holes">): string {
  return computePlanDigest("arm-deploy-plan", {
    env: ctx.env,
    ...target,
    template: input.template,
    templateDigest: templateDigest(input.template),
    prune: input.prune ?? false,
    unresolved,
    ...(plan ? { entries: plan.entries, holes: plan.holes } : {}),
  });
}

/** The template's outputs evaluated against `ctx`, leaving out each one that evaluates to nothing. */
async function evaluateOutputs(
  outputs: ArmTemplate["outputs"],
  ctx: ArmEvalCtx,
  only?: (name: string) => boolean,
): Promise<{ known: Record<string, unknown>; unknown: string[] }> {
  const known: Record<string, unknown> = {};
  const unknown: string[] = [];
  for (const [name, output] of Object.entries(outputs ?? {})) {
    if (only && !only(name)) {
      unknown.push(name);
      continue;
    }
    let value: unknown;
    try {
      value = await evalArm(output?.value, ctx);
    } catch {
      value = undefined;
    }
    if (value === undefined) unknown.push(name);
    else known[name] = value;
  }
  return { known, unknown: unknown.sort() };
}

/**
 * What the plan says of the template's outputs: an output whose value reads
 * only resources the plan leaves as they are is known from the live read.
 * Every other one is known only after apply.
 */
async function plannedOutputs(plan: ArmPlanResult): Promise<PlannedOutputs> {
  const names = new Set(plan.resources.map((r) => r.resource.name));
  const changing = new Set(plan.resources.filter((r) => r.action !== "no-op").map((r) => r.resource.name));
  return evaluateOutputs(plan.template.outputs, plan.live, (name) => {
    const value = plan.template.outputs?.[name]?.value;
    const reads = armDependencies({ type: "", apiVersion: "", name: "", properties: value }, names);
    return reads.every((r) => !changing.has(r));
  });
}

/** Read every template resource live and evaluate the template's outputs against them. */
async function liveOutputs(target: Target, input: ArmDeployInput, http: AzHttp): Promise<Record<string, unknown>> {
  const template = readTemplate(input.template);
  if (Object.keys(template.outputs ?? {}).length === 0) return {};
  const ctx = evalCtxOf(target, http);
  const client = clientOf(target, http);
  for (const resource of orderArmResources(template.resources ?? [])) {
    const name = String(await evalStaticString(resource.name, ctx));
    if (name.startsWith("[")) continue;
    try {
      rememberDeployed(ctx, resource.type, name, await getResource(client, resource.type, name, resource.apiVersion));
    } catch (err) {
      if (!isAbsent(err)) throw err;
    }
  }
  return (await evaluateOutputs(template.outputs, ctx)).known;
}

async function planArmDeploy(http: AzHttp, ctx: DeployContext, input: ArmDeployInput): Promise<CapabilityPlan> {
  const target = targetOf(ctx, input);
  const member = target.resourceGroup;
  const unresolved = [...(ctx.unresolvedInputs ?? [])].sort();
  const memberOf = (planDigest: string, holes: ChangeSetHole[]): ChangeSetPart["member"] => ({
    member,
    lexicon: "azure",
    planner: "chant",
    status: "planned",
    planDigest,
    holes,
  });

  if (unresolved.length > 0) {
    const planDigest = armPlanDigest(ctx, target, input, unresolved);
    const hole = { address: member, type: "Microsoft.Resources/resourceGroups", reason: `inputs from ${unresolved.join(", ")}; re-checked on apply` };
    return { member, planDigest, changeSet: { member: memberOf(planDigest, [hole]), entries: [] } };
  }

  const plan = await readPlan(member, target, input, http);
  const planDigest = armPlanDigest(ctx, target, input, unresolved, plan);
  const outputs = await plannedOutputs(plan);
  // A plan with a hole hands `run` nothing to hold it to, as `cfn-deploy`'s does not.
  const artifact: ArmDeployPlanArtifact | undefined = plan.holes.length === 0 ? { kind: "arm-deploy-plan", resourceGroup: member, planDigest } : undefined;
  return {
    member,
    planDigest,
    ...(artifact ? { artifact } : {}),
    changeSet: { member: memberOf(planDigest, plan.holes), entries: plan.entries },
    outputs,
  };
}

/**
 * The `arm-deploy` capability over an injectable HTTP transport (the
 * `AzHttp` seam `azApply` and the read client share). Tests pass a fake;
 * the default is `fetch`. There is no rollback: like `gcp-apply`, it mutates
 * with no undo, so COMP003 has a component acknowledge the gap.
 */
export function createArmDeployCapability(options: { http?: AzHttp } = {}): Capability<ArmDeployInput, ArmDeployOutput> {
  const http: AzHttp = options.http ?? (async (method, url, body, signal) => {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    return { status: res.status, text: await res.text() };
  });
  return {
    kind: "arm-deploy",
    rollbackPolicy: "needs-opt-out",
    plan(ctx, input) {
      return planArmDeploy(http, ctx, input);
    },
    outputs(ctx, input) {
      return liveOutputs(targetOf(ctx, input), input, http);
    },
    async run(ctx, input) {
      const target = targetOf(ctx, input);
      const approved = ctx.plans?.[target.resourceGroup];
      if (isArmDeployPlanArtifact(approved)) {
        const now = await planArmDeploy(http, { env: ctx.env, component: ctx.component }, input);
        if (now.planDigest !== approved.planDigest) throw new ArmDeployPlanMovedError(target.resourceGroup, approved.planDigest, now.planDigest);
      }
      const result = await azApply(
        {
          templatePath: input.template,
          resourceGroup: target.resourceGroup,
          location: target.location,
          endpoint: target.endpoint,
          subscriptionId: target.subscriptionId,
          prune: input.prune ?? false,
        },
        undefined,
        http,
      );
      return { ...result, outputs: await liveOutputs(target, input, http) };
    },
  };
}

/** The default `arm-deploy` capability, over `fetch`. */
export const armDeployCapability: Capability<ArmDeployInput, ArmDeployOutput> = createArmDeployCapability();
