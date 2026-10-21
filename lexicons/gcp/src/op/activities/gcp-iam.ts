/**
 * IAMPolicyMember (#4233): one member in one role on one resource's IAM policy.
 *
 * GCP has no REST resource for a single binding member. The member lives inside
 * the target's policy, read with `getIamPolicy` and written whole with
 * `setIamPolicy`. So this mapper does not fit the GET-then-create plan the other
 * kinds use: apply reads the policy, adds the member to the role's binding when
 * it is missing and writes the policy back with its `etag`; delete removes it
 * the same way. Other members and bindings are kept as read (a merge, never an
 * overwrite), and a write that loses an `etag` race is retried.
 *
 * Targets are the kinds `resourceRef` can name that have an IAM policy chant can
 * reach: Project, RunService, IAMServiceAccount, StorageBucket, PubSubTopic,
 * PubSubSubscription and SecretManagerSecret. Any other target is reported as
 * not attempted, the way a kind with no mapper is.
 */
import type { GcpHttp, GcpResource, ResourceMapper } from "./gcp-apply";

/** The CNRM IAMPolicyMember spec chant reads. */
export interface IamPolicyMemberSpec {
  member?: string;
  role?: string;
  resourceRef?: { kind?: string; name?: string; external?: string; apiVersion?: string };
  condition?: { title?: string; description?: string; expression?: string };
  location?: string;
}

interface Binding {
  role: string;
  members?: string[];
  condition?: { title?: string; description?: string; expression?: string };
}

interface Policy {
  version?: number;
  etag?: string;
  bindings?: Binding[];
}

/** Where a target's policy is read and written. */
export interface IamTarget {
  /** Real-GCP host for the target's service. */
  host: string;
  /** The target's resource path, used in messages and in the read body. */
  path: string;
  get: (base: string) => { method: "GET" | "POST"; url: string; body?: unknown };
  set: (base: string, policy: Policy) => { method: "POST" | "PUT"; url: string; body: unknown };
}

/** The default host this mapper reports; a target's own host replaces it when there is no endpoint override. */
export const IAM_DEFAULT_HOST = "https://iam.googleapis.com";

const enc = encodeURIComponent;

function region(env: NodeJS.ProcessEnv = process.env): string {
  return env.GCP_REGION || "us-central1";
}

/** A `:getIamPolicy` / `:setIamPolicy` pair on a REST resource path (the Google API convention). */
function verbTarget(host: string, version: string, path: string, getMethod: "GET" | "POST"): IamTarget {
  return {
    host,
    path,
    get: (base) =>
      getMethod === "GET"
        ? { method: "GET", url: `${base}/${version}/${path}:getIamPolicy?options.requestedPolicyVersion=3` }
        : { method: "POST", url: `${base}/${version}/${path}:getIamPolicy`, body: { options: { requestedPolicyVersion: 3 } } },
    set: (base, policy) => ({ method: "POST", url: `${base}/${version}/${path}:setIamPolicy`, body: { policy } }),
  };
}

/**
 * Resolve `resourceRef` to the target's policy endpoints, or undefined for a
 * target chant cannot reach. `manifest` is the rest of the applied manifest, so
 * a RunService named by `name` takes its region from its own spec. Pure.
 */
export function iamTarget(
  spec: IamPolicyMemberSpec,
  project: string,
  manifest: readonly GcpResource[] = [],
  env: NodeJS.ProcessEnv = process.env,
): IamTarget | undefined {
  const ref = spec.resourceRef ?? {};
  const external = typeof ref.external === "string" && ref.external !== "" ? ref.external : undefined;
  const name = typeof ref.name === "string" && ref.name !== "" ? ref.name : undefined;
  switch (ref.kind) {
    case "Project": {
      const id = external ? external.replace(/^projects\//, "") : (name ?? project);
      return verbTarget("https://cloudresourcemanager.googleapis.com", "v1", `projects/${enc(id)}`, "POST");
    }
    case "RunService": {
      if (external) return verbTarget("https://run.googleapis.com", "v2", external, "GET");
      if (!name) return undefined;
      const declared = manifest.find((r) => r.kind === "RunService" && r.metadata?.name === name);
      const location = (declared?.spec as { location?: unknown } | undefined)?.location;
      const loc = typeof location === "string" ? location : (spec.location ?? region(env));
      return verbTarget("https://run.googleapis.com", "v2", `projects/${enc(project)}/locations/${enc(loc)}/services/${enc(name)}`, "GET");
    }
    case "IAMServiceAccount": {
      if (external?.startsWith("projects/")) return verbTarget(IAM_DEFAULT_HOST, "v1", external, "POST");
      const email = external ?? (name ? `${name}@${project}.iam.gserviceaccount.com` : undefined);
      if (!email) return undefined;
      return verbTarget(IAM_DEFAULT_HOST, "v1", `projects/${enc(project)}/serviceAccounts/${email}`, "POST");
    }
    case "PubSubTopic":
    case "PubSubSubscription": {
      const collection = ref.kind === "PubSubTopic" ? "topics" : "subscriptions";
      const path = external ?? (name ? `projects/${enc(project)}/${collection}/${enc(name)}` : undefined);
      return path ? verbTarget("https://pubsub.googleapis.com", "v1", path, "GET") : undefined;
    }
    case "SecretManagerSecret": {
      const path = external ?? (name ? `projects/${enc(project)}/secrets/${enc(name)}` : undefined);
      return path ? verbTarget("https://secretmanager.googleapis.com", "v1", path, "GET") : undefined;
    }
    case "StorageBucket": {
      const bucket = external ? external.replace(/^(gs:\/\/|projects\/_\/buckets\/)/, "") : name;
      if (!bucket) return undefined;
      // GCS has its own IAM shape: GET and PUT on `b/<bucket>/iam`, with the policy as the body.
      const url = (base: string) => `${base}/storage/v1/b/${enc(bucket)}/iam`;
      return {
        host: "https://storage.googleapis.com",
        path: `b/${bucket}`,
        get: (base) => ({ method: "GET", url: `${url(base)}?optionsRequestedPolicyVersion=3` }),
        set: (base, policy) => ({ method: "PUT", url: url(base), body: policy }),
      };
    }
    default:
      return undefined;
  }
}

function sameCondition(a: Binding["condition"], b: IamPolicyMemberSpec["condition"]): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (a.expression ?? "") === (b.expression ?? "") && (a.title ?? "") === (b.title ?? "");
}

function findBinding(policy: Policy, spec: IamPolicyMemberSpec): Binding | undefined {
  return policy.bindings?.find((b) => b.role === spec.role && sameCondition(b.condition, spec.condition));
}

/** True when the policy grants the spec's member in its role (and condition). Pure. */
export function policyHasMember(policy: Policy, spec: IamPolicyMemberSpec): boolean {
  return findBinding(policy, spec)?.members?.includes(spec.member ?? "") ?? false;
}

/** The policy with the spec's member added to its binding, every other binding kept. Pure. */
export function withMember(policy: Policy, spec: IamPolicyMemberSpec): Policy {
  const member = spec.member as string;
  const bindings = (policy.bindings ?? []).map((b) => ({ ...b, members: [...(b.members ?? [])] }));
  const existing = bindings.find((b) => b.role === spec.role && sameCondition(b.condition, spec.condition));
  if (existing) {
    if (!existing.members.includes(member)) existing.members.push(member);
  } else {
    bindings.push({ role: spec.role as string, members: [member], ...(spec.condition ? { condition: spec.condition } : {}) });
  }
  // A conditional binding needs policy version 3; otherwise keep what was read.
  const version = spec.condition || bindings.some((b) => b.condition) ? 3 : policy.version;
  return { ...policy, bindings, ...(version !== undefined ? { version } : {}) };
}

/** The policy with the spec's member removed; a binding left with no members is dropped. Pure. */
export function withoutMember(policy: Policy, spec: IamPolicyMemberSpec): Policy {
  const bindings = (policy.bindings ?? [])
    .map((b) =>
      b.role === spec.role && sameCondition(b.condition, spec.condition)
        ? { ...b, members: (b.members ?? []).filter((m) => m !== spec.member) }
        : b,
    )
    .filter((b) => (b.members ?? []).length > 0);
  return { ...policy, bindings };
}

function specOf(resource: GcpResource): IamPolicyMemberSpec {
  const spec = (resource.spec ?? {}) as IamPolicyMemberSpec;
  const name = resource.metadata?.name ?? "?";
  if (!spec.member) throw new Error(`IAMPolicyMember ${name} has no spec.member`);
  if (!spec.role) throw new Error(`IAMPolicyMember ${name} has no spec.role`);
  return spec;
}

function targetOf(resource: GcpResource, ctx: IamCtx, env?: NodeJS.ProcessEnv): { target: IamTarget; base: string } {
  const target = iamTarget(specOf(resource), ctx.project, ctx.manifest, env);
  if (!target) {
    const ref = (resource.spec as IamPolicyMemberSpec | undefined)?.resourceRef;
    throw new Error(`IAMPolicyMember ${resource.metadata?.name ?? "?"}: no IAM policy endpoint for resourceRef kind ${ref?.kind ?? "(none)"}`);
  }
  // No endpoint override: each target's own service host. An override (floci-gcp) serves every service.
  const base = ctx.base === IAM_DEFAULT_HOST ? target.host : ctx.base;
  return { target, base };
}

interface IamCtx {
  base: string;
  project: string;
  manifest?: readonly GcpResource[];
}

async function readPolicy(target: IamTarget, base: string, http: GcpHttp, signal?: AbortSignal): Promise<{ status: number; text: string; policy?: Policy }> {
  const req = target.get(base);
  const res = await http(req.method, req.url, req.body, signal);
  if (res.status >= 300) return res;
  let policy: Policy;
  try {
    policy = JSON.parse(res.text) as Policy;
  } catch {
    policy = {};
  }
  return { ...res, policy };
}

/** How many times a write that loses an `etag` race (409, or 412 on GCS) is retried. */
const ETAG_ATTEMPTS = 3;

async function writeWith(
  resource: GcpResource,
  ctx: IamCtx,
  http: GcpHttp,
  signal: AbortSignal | undefined,
  change: (policy: Policy, spec: IamPolicyMemberSpec) => Policy | undefined,
): Promise<boolean> {
  const spec = specOf(resource);
  const { target, base } = targetOf(resource, ctx);
  const name = resource.metadata?.name ?? "?";
  for (let attempt = 1; ; attempt++) {
    const read = await readPolicy(target, base, http, signal);
    if (!read.policy) throw new Error(`IAMPolicyMember ${name}: reading the policy of ${target.path} failed (${read.status}): ${read.text}`);
    const next = change(read.policy, spec);
    if (!next) return false;
    const req = target.set(base, next);
    const res = await http(req.method, req.url, req.body, signal);
    if (res.status < 300) return true;
    if ((res.status === 409 || res.status === 412) && attempt < ETAG_ATTEMPTS) continue;
    throw new Error(`IAMPolicyMember ${name}: writing the policy of ${target.path} failed (${res.status}): ${res.text}`);
  }
}

export const iamPolicyMemberMapper: ResourceMapper = {
  kind: "IAMPolicyMember",
  defaultHost: IAM_DEFAULT_HOST,
  accepts(resource, ctx) {
    return iamTarget((resource.spec ?? {}) as IamPolicyMemberSpec, ctx.project, ctx.manifest) !== undefined;
  },
  plan(resource, ctx) {
    // Only the read is a single URL here; apply and delete go through `custom`.
    const { target, base } = targetOf(resource, ctx);
    const get = target.get(base);
    return { getUrl: get.url, create: { method: "POST", url: get.url, body: get.body ?? {} } };
  },
  custom: {
    async apply(resource, ctx, http, signal) {
      const created = await writeWith(resource, ctx, http, signal, (policy, spec) =>
        policyHasMember(policy, spec) ? undefined : withMember(policy, spec),
      );
      return { created, updated: false };
    },
    async delete(resource, ctx, http, signal) {
      return writeWith(resource, ctx, http, signal, (policy, spec) =>
        policyHasMember(policy, spec) ? withoutMember(policy, spec) : undefined,
      );
    },
    async read(resource, ctx, http, signal) {
      const spec = specOf(resource);
      const { target, base } = targetOf(resource, ctx);
      const read = await readPolicy(target, base, http, signal);
      if (!read.policy) return read;
      // The binding member is the resource: absent from the policy reads as absent.
      if (!policyHasMember(read.policy, spec)) return { status: 404, text: `${spec.member} has no ${spec.role} on ${target.path}` };
      const binding = findBinding(read.policy, spec);
      return {
        status: 200,
        // `resourceRef` is the declared one: the policy read is that target's, so the binding is on it.
        text: JSON.stringify({
          member: spec.member,
          role: spec.role,
          resource: target.path,
          ...(spec.resourceRef ? { resourceRef: spec.resourceRef } : {}),
          ...(binding?.condition ? { condition: binding.condition } : {}),
          ...(read.policy.etag ? { etag: read.policy.etag } : {}),
        }),
      };
    },
  },
};
