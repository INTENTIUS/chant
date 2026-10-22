/**
 * `gcp-apply`: the gcp lexicon's component deploy step (#4273). It applies a
 * built Config Connector manifest through the `gcpApply` activity
 * (../op/activities/gcp-apply.ts), so a component step, an Op and the
 * floci-gcp path all write through the same `MAPPERS`.
 *
 * `plan` reads each declared resource on the same transport and decides what
 * apply would do with `decideResource`, the function `applyResource` acts on.
 * So a plan's create, update or no-op is the apply's created, updated or
 * unchanged. Nothing is written: the plan's HTTP refuses any request that is
 * not a read.
 *
 * `GCP_ENDPOINT_URL` (or the step's `endpoint`) points both at floci-gcp. The
 * project follows the applier's rule: the step's `project`, else each
 * resource's `projectRef.external`, its project-id annotation,
 * `GCP_PROJECT_ID`, then `GOOGLE_CLOUD_PROJECT`.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Capability, CapabilityPlan, DeployContext, PlannedOutputs } from "@intentius/chant/components/capability";
import type { ChangeSetEntry, ChangeSetHole, ChangeSetPart } from "@intentius/chant/change-set";
import { computePlanDigest } from "@intentius/chant/lifecycle/plan-digest";
import {
  MAPPERS,
  decideResource,
  gcpApply,
  isChantOwned,
  orderByReferences,
  parseManifest,
  resolveGcpEndpoint,
  resolveGcpProject,
  type GcpHttp,
  type GcpNotAttempted,
  type GcpNotPrunable,
  type GcpResource,
  type MapperCtx,
  type ResourceMapper,
} from "../op/activities/gcp-apply";

export interface GcpApplyStepInput {
  /** The member's name in a plan. Default: the component's name. */
  stack?: string;
  /** Path to the built Config Connector manifest (YAML multi-doc or JSON). */
  manifest: string;
  /** Project for every resource. Default: each resource's own, by the applier's rule. */
  project?: string;
  /** Endpoint for every kind, such as floci-gcp's. Default: `GCP_ENDPOINT_URL`, else each kind's real host. */
  endpoint?: string;
  /** Delete chant-owned resources of a manifested kind the manifest no longer declares. Default: false. */
  prune?: boolean;
}

export interface GcpApplyStepOutput {
  applied: Array<{ kind: string; name: string; created: boolean; updated: boolean; replaceRequired?: string }>;
  pruned: Array<{ kind: string; name: string; deleted: boolean }>;
  notAttempted: GcpNotAttempted[];
  notPrunable: GcpNotPrunable[];
  /** What the API reports for the applied resources, such as a Cloud Run URL ({@link GCP_OUTPUT_FIELDS}). */
  outputs: Record<string, string>;
}

/**
 * The outputs a resource kind has: the output's name is the resource's name
 * plus `suffix`, and its value the live REST body's `field`.
 */
export const GCP_OUTPUT_FIELDS: Record<string, { field: string; suffix: string }> = {
  RunService: { field: "uri", suffix: "Uri" },
  ComputeAddress: { field: "address", suffix: "Address" },
  ComputeForwardingRule: { field: "IPAddress", suffix: "IpAddress" },
};

/** What a plan hands `run` through `DeployContext.plans[member]`. */
export interface GcpApplyPlanArtifact {
  kind: "gcp-apply-plan";
  member: string;
  /** {@link gcpChangesDigest} of the planned entries. */
  changesDigest: string;
}

function isGcpApplyPlanArtifact(value: unknown): value is GcpApplyPlanArtifact {
  const v = value as Partial<GcpApplyPlanArtifact> | undefined;
  return v?.kind === "gcp-apply-plan" && typeof v.member === "string" && typeof v.changesDigest === "string";
}

/**
 * Thrown by `run` when a fresh plan of the manifest differs from the approved
 * one: the manifest or the live resources moved since. Nothing is applied.
 * `planMoved` is core's mark, so the command exits 3.
 */
export class GcpPlanMovedError extends Error {
  readonly planMoved = true;
  constructor(
    public readonly member: string,
    public readonly planned: string,
    public readonly now: string,
  ) {
    super(
      `gcp-apply "${member}": refusing to apply. The resources need other changes than the plan that was approved ` +
        `(planned ${planned}, now ${now}); the manifest or the live resources changed since. Plan it again.`,
    );
    this.name = "GcpPlanMovedError";
  }
}

/**
 * A digest over the entries' addresses, actions, and changed fields with the
 * value apply writes, in address order. The live value before is left out:
 * apply writes the same thing whatever it was.
 */
export function gcpChangesDigest(member: string, entries: readonly ChangeSetEntry[]): string {
  const shape = entries
    .map((e) => ({ address: e.address, action: e.action, fields: e.attributes.map((a) => ({ path: a.path, after: a.after ?? null })) }))
    .sort((a, b) => a.address.localeCompare(b.address) || a.action.localeCompare(b.action));
  return computePlanDigest("gcp-apply-changes", { member, entries: shape });
}

/** A plan only reads. A policy read is a POST to `:getIamPolicy`; anything else that writes is refused. */
export function readOnlyHttp(http: GcpHttp): GcpHttp {
  return (method, url, body, signal) => {
    if (method === "GET" || (method === "POST" && /:getIamPolicy(\?|$)/.test(url))) return http(method, url, body, signal);
    return Promise.reject(new Error(`gcp-apply plan: refusing ${method} ${url}; a plan only reads`));
  };
}

const defaultHttp: GcpHttp = async (method, url, body, signal) => {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  return { status: res.status, text: await res.text() };
};

interface Loaded {
  resources: GcpResource[];
  digest: string;
}

function loadManifest(path: string): Loaded {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`gcp-apply: cannot read the manifest ${path}: ${err instanceof Error ? err.message : String(err)}. Build it before planning.`);
  }
  return {
    resources: orderByReferences(parseManifest(content, path)),
    digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
  };
}

/** Where a resource is read and written: the same base and project `gcpApply` gives it. */
function mapperCtx(input: GcpApplyStepInput, mapper: ResourceMapper, resources: GcpResource[], resource?: GcpResource): MapperCtx {
  const endpoint = resolveGcpEndpoint(input);
  return {
    base: (endpoint ?? mapper.defaultHost).replace(/\/$/, ""),
    project: input.project ?? (resource ? resolveGcpProject(resource) : ""),
    manifest: resources,
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The entries, holes and planned outputs for one manifest. Reads only. */
export async function planGcpResources(
  member: string,
  input: GcpApplyStepInput,
  resources: GcpResource[],
  http: GcpHttp,
): Promise<{ entries: ChangeSetEntry[]; holes: ChangeSetHole[]; outputs: PlannedOutputs }> {
  const read = readOnlyHttp(http);
  const entries: ChangeSetEntry[] = [];
  const holes: ChangeSetHole[] = [];
  const known: Record<string, unknown> = {};
  const unknown: string[] = [];
  const base = (kind: string, name: string, project: string) => ({
    member,
    lexicon: "gcp",
    planner: "chant" as const,
    address: `${kind}/${name}`,
    type: kind,
    name,
    ...(project ? { scope: project } : {}),
  });

  for (const r of resources) {
    if (!r.kind) throw new Error(`gcp-apply: ${input.manifest}: a manifest entry has no "kind"${r.metadata?.name ? ` (metadata.name: ${r.metadata.name})` : ""}`);
    const kind = r.kind;
    const name = r.metadata?.name ?? "?";
    const address = `${kind}/${name}`;
    const output = GCP_OUTPUT_FIELDS[kind];
    const outputName = output ? `${name}${output.suffix}` : undefined;
    const mapper = MAPPERS[kind];
    if (!mapper) {
      holes.push({ address, type: kind, reason: `chant has no REST mapper for ${kind}; apply skips it` });
      continue;
    }
    const ctx = mapperCtx(input, mapper, resources, r);
    if (mapper.accepts && !mapper.accepts(r, ctx)) {
      holes.push({ address, type: kind, reason: `nothing chant can apply ${address} to; apply skips it` });
      continue;
    }
    const decision = await decideResource(mapper, r, ctx, read);
    switch (decision.action) {
      case "create":
        if (decision.readStatus !== 404) {
          holes.push({ address, type: kind, reason: `the read answered ${decision.readStatus}, so the plan can't say whether it exists; apply would try a create` });
          if (outputName) unknown.push(outputName);
          continue;
        }
        entries.push({ ...base(kind, name, ctx.project), action: "create", attributes: [] });
        if (outputName) unknown.push(outputName);
        continue;
      case "replace-required":
        holes.push({ address, type: kind, reason: `replace required: ${decision.reason}; apply leaves it as it is` });
        break;
      case "unchanged":
        entries.push({ ...base(kind, name, ctx.project), action: "no-op", attributes: [] });
        break;
      case "update": {
        const desired = mapper.plan(r, ctx).create.body;
        const live = isObj(decision.live) ? decision.live : {};
        const attributes = [...decision.fields].sort().map((path) => ({
          path,
          ...(live[path] !== undefined ? { before: live[path] } : {}),
          ...(isObj(desired) && desired[path] !== undefined ? { after: desired[path] } : {}),
        }));
        entries.push({ ...base(kind, name, ctx.project), action: "update", disruption: "in-place", attributes });
        break;
      }
    }
    // The resource stays, so an output it reports now is the one it has after apply.
    if (outputName) {
      const value = isObj(decision.live) ? decision.live[output!.field] : undefined;
      if (typeof value === "string" && value !== "") known[outputName] = value;
      else unknown.push(outputName);
    }
  }

  if (input.prune) await planPrune(member, input, resources, read, entries, holes);
  entries.sort((a, b) => a.address.localeCompare(b.address));
  return { entries, holes, outputs: { known, unknown: [...new Set(unknown)].sort() } };
}

/** The deletes an owned-only prune would make, the way `pruneOrphans` finds them. */
async function planPrune(
  member: string,
  input: GcpApplyStepInput,
  resources: GcpResource[],
  http: GcpHttp,
  entries: ChangeSetEntry[],
  holes: ChangeSetHole[],
): Promise<void> {
  const desiredByKind = new Map<string, Set<string>>();
  for (const r of resources) {
    if (!r.kind) continue;
    const names = desiredByKind.get(r.kind) ?? new Set<string>();
    if (r.metadata?.name) names.add(r.metadata.name);
    desiredByKind.set(r.kind, names);
  }
  for (const [kind, keep] of desiredByKind) {
    const mapper = MAPPERS[kind];
    if (!mapper?.list) {
      holes.push({ address: `${kind}/*`, type: kind, reason: `chant can't list ${kind}, so owned orphans of it are not considered` });
      continue;
    }
    const ctx = mapperCtx(input, mapper, resources, resources.find((r) => r.kind === kind));
    const res = await http("GET", mapper.list.url(ctx));
    if (res.status >= 300) {
      holes.push({ address: `${kind}/*`, type: kind, reason: `listing ${kind} failed (${res.status}), so owned orphans of it are not considered` });
      continue;
    }
    let body: unknown;
    try {
      body = JSON.parse(res.text);
    } catch {
      body = undefined;
    }
    for (const item of mapper.list.items(body)) {
      if (!isChantOwned(item.labels) || keep.has(item.name)) continue;
      entries.push({
        member,
        lexicon: "gcp",
        planner: "chant",
        address: `${kind}/${item.name}`,
        type: kind,
        name: item.name,
        action: "delete",
        disruption: "destroy",
        ...(ctx.project ? { scope: ctx.project } : {}),
        attributes: [],
      });
    }
  }
}

/** The outputs the declared resources report now. A resource not there yet has none. */
export async function readGcpOutputs(input: GcpApplyStepInput, resources: GcpResource[], http: GcpHttp): Promise<Record<string, string>> {
  const outputs: Record<string, string> = {};
  for (const r of resources) {
    const output = r.kind ? GCP_OUTPUT_FIELDS[r.kind] : undefined;
    const mapper = r.kind ? MAPPERS[r.kind] : undefined;
    const name = r.metadata?.name;
    if (!output || !mapper || !name) continue;
    const ctx = mapperCtx(input, mapper, resources, r);
    const res = await http("GET", mapper.plan(r, ctx).getUrl);
    if (res.status === 404) continue;
    if (res.status >= 300) throw new Error(`gcp-apply: reading ${r.kind}/${name} for its outputs failed (${res.status}): ${res.text.slice(0, 200)}`);
    let body: unknown;
    try {
      body = JSON.parse(res.text);
    } catch {
      continue;
    }
    const value = isObj(body) ? body[output.field] : undefined;
    if (typeof value === "string" && value !== "") outputs[`${name}${output.suffix}`] = value;
  }
  return outputs;
}

/**
 * Plan a `gcp-apply` step. The digest covers the environment, the member, the
 * manifest's path and bytes, the endpoint, the project override, the prune
 * mode and the components whose outputs were missing. A step whose inputs
 * wait on another component reads nothing and gets a hole.
 */
async function planGcpApply(http: GcpHttp, ctx: DeployContext, input: GcpApplyStepInput): Promise<CapabilityPlan> {
  const member = input.stack ?? ctx.component;
  const unresolved = [...(ctx.unresolvedInputs ?? [])].sort();
  const loaded = unresolved.length > 0 ? undefined : loadManifest(input.manifest);
  const planDigest = computePlanDigest("gcp-apply-plan", {
    env: ctx.env,
    member,
    manifest: input.manifest,
    manifestDigest: loaded?.digest ?? null,
    endpoint: resolveGcpEndpoint(input) ?? null,
    project: input.project ?? null,
    prune: input.prune === true,
    unresolved,
  });
  const memberOf = (holes: ChangeSetHole[]): ChangeSetPart["member"] => ({
    member,
    lexicon: "gcp",
    planner: "chant",
    status: "planned",
    planDigest,
    holes,
  });
  if (!loaded) {
    return {
      member,
      planDigest,
      changeSet: { member: memberOf([{ address: member, type: "gcp-apply", reason: `inputs from ${unresolved.join(", ")}; re-checked on apply` }]), entries: [] },
    };
  }
  const { entries, holes, outputs } = await planGcpResources(member, input, loaded.resources, http);
  const artifact: GcpApplyPlanArtifact = { kind: "gcp-apply-plan", member, changesDigest: gcpChangesDigest(member, entries) };
  return { member, planDigest, artifact, changeSet: { member: memberOf(holes), entries }, outputs };
}

/**
 * Apply a Config Connector manifest with `gcpApply`. Handed the approved plan
 * (`ctx.plans[member]`), `run` plans again first and applies only when the
 * changes have the same digest. It returns what `gcpApply` reports, plus the
 * outputs the API reports for the applied resources. There is no rollback:
 * apply never deletes on its own, so a component acknowledges the gap.
 */
export function createGcpApplyCapability(http: GcpHttp = defaultHttp): Capability<GcpApplyStepInput, GcpApplyStepOutput> {
  return {
    kind: "gcp-apply",
    rollbackPolicy: "needs-opt-out",
    plan(ctx, input) {
      return planGcpApply(http, ctx, input);
    },
    async outputs(_ctx, input) {
      return readGcpOutputs(input, loadManifest(input.manifest).resources, http);
    },
    async run(ctx, input) {
      const member = input.stack ?? ctx.component;
      const { resources } = loadManifest(input.manifest);
      const planned = ctx.plans?.[member];
      if (isGcpApplyPlanArtifact(planned)) {
        const { entries } = await planGcpResources(member, input, resources, http);
        const now = gcpChangesDigest(member, entries);
        if (now !== planned.changesDigest) throw new GcpPlanMovedError(member, planned.changesDigest, now);
      }
      const result = await gcpApply(
        {
          manifestPath: input.manifest,
          ...(input.endpoint ? { endpoint: input.endpoint } : {}),
          ...(input.project ? { project: input.project } : {}),
          ...(input.prune ? { prune: true } : {}),
        },
        undefined,
        http,
      );
      const outputs = await readGcpOutputs(input, resources, http);
      return { ...result, outputs };
    },
  };
}

/** The default `gcp-apply` capability, over `fetch`. */
export const gcpApplyCapability: Capability<GcpApplyStepInput, GcpApplyStepOutput> = createGcpApplyCapability();
