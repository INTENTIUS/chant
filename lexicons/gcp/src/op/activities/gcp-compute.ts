/**
 * Compute Engine mappers for the Cloud Run load balancer (#4233): ComputeAddress,
 * ComputeRegionNetworkEndpointGroup (serverless NEGs), ComputeBackendService,
 * ComputeURLMap, ComputeTargetHTTPProxy and ComputeForwardingRule.
 *
 * Each maps a CNRM spec onto the compute v1 insert body. A resource is global
 * or regional by its CNRM `location` (`"global"` or a region; a NEG has
 * `region`), and that picks `projects/<p>/global/<collection>` or
 * `projects/<p>/regions/<r>/<collection>`. `*Ref` fields become the referenced
 * resource's partial URL, which compute accepts; a ref to a resource in the
 * same manifest takes its scope from that resource's own spec, so a global
 * backend service can point at a regional NEG.
 *
 * Inserts return a compute `Operation`, polled at its `selfLink` (rebased onto
 * the endpoint override, so floci-gcp answers). These kinds reconcile by
 * existence only: an existing resource is left as it is, since compute updates
 * need the live `fingerprint` and most of these fields are immutable.
 */
import { GCP_RESOURCE_OWNERSHIP_KEYS } from "../../ownership";
import { OWNERSHIP_MANAGED_BY_VALUE } from "@intentius/chant/ownership";
import type { GcpResource, OperationSpec, ResourceMapper } from "./gcp-apply";

export const COMPUTE_HOST = "https://compute.googleapis.com";

const enc = encodeURIComponent;

type Ref = { name?: string; external?: string; kind?: string };
type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** What a `*Ref` key points at: the CNRM kind (for a manifest lookup), the collection, and whether it is global only. */
const REF_TARGETS: Record<string, { kind: string; collection: string; scope: "global" | "regional" | "either" }> = {
  addressRef: { kind: "ComputeAddress", collection: "addresses", scope: "either" },
  networkEndpointGroupRef: { kind: "ComputeRegionNetworkEndpointGroup", collection: "networkEndpointGroups", scope: "regional" },
  backendServiceRef: { kind: "ComputeBackendService", collection: "backendServices", scope: "either" },
  backendBucketRef: { kind: "ComputeBackendBucket", collection: "backendBuckets", scope: "global" },
  urlMapRef: { kind: "ComputeURLMap", collection: "urlMaps", scope: "either" },
  targetHTTPProxyRef: { kind: "ComputeTargetHTTPProxy", collection: "targetHttpProxies", scope: "either" },
  targetHTTPSProxyRef: { kind: "ComputeTargetHTTPSProxy", collection: "targetHttpsProxies", scope: "either" },
  healthCheckRef: { kind: "ComputeHealthCheck", collection: "healthChecks", scope: "either" },
  securityPolicyRef: { kind: "ComputeSecurityPolicy", collection: "securityPolicies", scope: "global" },
  networkRef: { kind: "ComputeNetwork", collection: "networks", scope: "global" },
  subnetworkRef: { kind: "ComputeSubnetwork", collection: "subnetworks", scope: "regional" },
};

export interface ComputeCtx {
  base: string;
  project: string;
  manifest?: readonly GcpResource[];
}

/** The region or `"global"` a CNRM compute spec declares. A NEG names `region`; the rest `location`. */
export function scopeOf(spec: Obj | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const loc = spec?.location ?? spec?.region;
  return typeof loc === "string" && loc !== "" ? loc : (env.GCP_REGION || "us-central1");
}

function scopePath(project: string, scope: string): string {
  return scope === "global" ? `projects/${enc(project)}/global` : `projects/${enc(project)}/regions/${enc(scope)}`;
}

/** The compute name: CNRM's `resourceID` when set, else `metadata.name`. */
export function computeName(resource: GcpResource): string {
  const id = (resource.spec as Obj | undefined)?.resourceID;
  const name = typeof id === "string" && id !== "" ? id : resource.metadata?.name;
  if (!name) throw new Error(`${resource.kind ?? "compute resource"} has no metadata.name`);
  return name;
}

/**
 * The partial URL a `*Ref` resolves to. `external` is used as given when it is
 * a path or URL; a bare name (or `name`) is scoped by the referenced resource's
 * own spec when the manifest holds it, else by `fallbackScope`. Pure.
 */
export function refUrl(key: string, ref: Ref, ctx: ComputeCtx, fallbackScope: string): string {
  const target = REF_TARGETS[key];
  if (!target) throw new Error(`no compute collection for ${key}`);
  if (typeof ref.external === "string" && ref.external !== "") {
    if (ref.external.startsWith("projects/") || ref.external.startsWith("https://")) return ref.external;
  }
  const name = ref.name ?? ref.external;
  if (!name) throw new Error(`${key} has no name or external`);
  const declared = ctx.manifest?.find((r) => r.kind === target.kind && (r.metadata?.name === name || (r.spec as Obj | undefined)?.resourceID === name));
  const scope =
    target.scope === "global"
      ? "global"
      : declared
        ? scopeOf(declared.spec as Obj)
        : target.scope === "regional" && fallbackScope === "global"
          ? scopeOf(undefined)
          : fallbackScope;
  const resolvedName = declared ? computeName(declared) : name;
  return `${scopePath(ctx.project, scope)}/${target.collection}/${resolvedName}`;
}

/** Resolve the one `*Ref` key an object holds (`{ backendServiceRef: {...} }` → URL), or undefined. */
function oneRef(value: unknown, ctx: ComputeCtx, scope: string): string | undefined {
  if (!isObj(value)) return undefined;
  for (const [k, v] of Object.entries(value)) {
    if (REF_TARGETS[k] && isObj(v)) return refUrl(k, v as Ref, ctx, scope);
  }
  return undefined;
}

/** Copy the listed fields that are set. */
function pick(spec: Obj, keys: readonly string[]): Obj {
  const out: Obj = {};
  for (const k of keys) if (spec[k] !== undefined) out[k] = spec[k];
  return out;
}

/**
 * The resource's labels GCP accepts, plus the ownership marker. Composites put
 * Kubernetes-style keys (`app.kubernetes.io/component`) in `metadata.labels`,
 * which a compute label key can't hold, so those are left out.
 */
export function computeLabels(labels: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(labels ?? {})) {
    if (/^[a-z][a-z0-9_-]{0,62}$/.test(k) && typeof v === "string" && /^[a-z0-9_-]{0,63}$/.test(v)) out[k] = v;
  }
  return { ...out, [GCP_RESOURCE_OWNERSHIP_KEYS.managedBy]: OWNERSHIP_MANAGED_BY_VALUE };
}

/** ComputeAddress → addresses.insert body. Pure. */
export function addressBody(resource: GcpResource, ctx: ComputeCtx): Obj {
  const spec = (resource.spec ?? {}) as Obj;
  const scope = scopeOf(spec);
  const body: Obj = {
    name: computeName(resource),
    ...pick(spec, ["address", "addressType", "description", "ipVersion", "ipv6EndpointType", "networkTier", "prefixLength", "purpose"]),
    labels: computeLabels(resource.metadata?.labels),
  };
  if (isObj(spec.networkRef)) body.network = refUrl("networkRef", spec.networkRef as Ref, ctx, scope);
  if (isObj(spec.subnetworkRef)) body.subnetwork = refUrl("subnetworkRef", spec.subnetworkRef as Ref, ctx, scope);
  return body;
}

/** ComputeRegionNetworkEndpointGroup → regionNetworkEndpointGroups.insert body (serverless NEGs). Pure. */
export function negBody(resource: GcpResource, ctx: ComputeCtx): Obj {
  const spec = (resource.spec ?? {}) as Obj;
  const scope = scopeOf(spec);
  const body: Obj = {
    name: computeName(resource),
    networkEndpointType: (spec.networkEndpointType as string | undefined) ?? "SERVERLESS",
    ...pick(spec, ["description", "pscTargetService"]),
  };
  const serviceName = (ref: unknown): string | undefined => {
    if (!isObj(ref)) return undefined;
    const r = ref as Ref;
    // A serverless NEG names the service, not its path.
    return (r.external ?? r.name)?.split("/").pop();
  };
  if (isObj(spec.cloudRun)) {
    const c = spec.cloudRun as Obj;
    body.cloudRun = { ...pick(c, ["tag", "urlMask"]), ...(serviceName(c.serviceRef) ? { service: serviceName(c.serviceRef) } : {}) };
  }
  if (isObj(spec.cloudFunction)) {
    const c = spec.cloudFunction as Obj;
    body.cloudFunction = { ...pick(c, ["urlMask"]), ...(serviceName(c.functionRef) ? { function: serviceName(c.functionRef) } : {}) };
  }
  if (isObj(spec.appEngine)) body.appEngine = spec.appEngine;
  if (isObj(spec.networkRef)) body.network = refUrl("networkRef", spec.networkRef as Ref, ctx, scope);
  if (isObj(spec.subnetworkRef)) body.subnetwork = refUrl("subnetworkRef", spec.subnetworkRef as Ref, ctx, scope);
  return body;
}

/** ComputeBackendService → backendServices.insert body. Pure. */
export function backendServiceBody(resource: GcpResource, ctx: ComputeCtx): Obj {
  const spec = (resource.spec ?? {}) as Obj;
  const scope = scopeOf(spec);
  const body: Obj = {
    name: computeName(resource),
    ...pick(spec, [
      "affinityCookieTtlSec",
      "cdnPolicy",
      "compressionMode",
      "customRequestHeaders",
      "customResponseHeaders",
      "description",
      "loadBalancingScheme",
      "localityLbPolicy",
      "logConfig",
      "portName",
      "protocol",
      "sessionAffinity",
      "timeoutSec",
    ]),
  };
  if (spec.enableCdn !== undefined) body.enableCDN = spec.enableCdn;
  if (spec.connectionDrainingTimeoutSec !== undefined) body.connectionDraining = { drainingTimeoutSec: spec.connectionDrainingTimeoutSec };
  if (Array.isArray(spec.backend)) {
    body.backends = (spec.backend as Obj[]).map((b) => {
      const { group, ...rest } = b;
      const groupUrl = isObj(group) ? oneRef(group, ctx, scope) ?? ((group as Obj).instanceGroupRef as Ref | undefined)?.external : undefined;
      return { ...rest, ...(groupUrl ? { group: groupUrl } : {}) };
    });
  }
  if (Array.isArray(spec.healthChecks)) {
    body.healthChecks = (spec.healthChecks as Obj[]).map((h) => oneRef(h, ctx, scope)).filter((u): u is string => !!u);
  }
  if (isObj(spec.securityPolicyRef)) body.securityPolicy = refUrl("securityPolicyRef", spec.securityPolicyRef as Ref, ctx, scope);
  else if (typeof spec.securityPolicy === "string") body.securityPolicy = spec.securityPolicy;
  return body;
}

/** ComputeURLMap → urlMaps.insert body. Pure. */
export function urlMapBody(resource: GcpResource, ctx: ComputeCtx): Obj {
  const spec = (resource.spec ?? {}) as Obj;
  const scope = scopeOf(spec);
  const service = (v: unknown) => oneRef(v, ctx, scope);
  const body: Obj = {
    name: computeName(resource),
    ...pick(spec, ["description", "defaultUrlRedirect", "headerAction"]),
  };
  const def = service(spec.defaultService);
  if (def) body.defaultService = def;
  if (Array.isArray(spec.hostRule)) body.hostRules = spec.hostRule;
  if (Array.isArray(spec.pathMatcher)) {
    body.pathMatchers = (spec.pathMatcher as Obj[]).map((m) => {
      const { defaultService, pathRule, ...rest } = m;
      const out: Obj = { ...rest };
      const d = service(defaultService);
      if (d) out.defaultService = d;
      if (Array.isArray(pathRule)) {
        out.pathRules = (pathRule as Obj[]).map((r) => {
          const { service: s, ...rr } = r;
          const u = service(s);
          return { ...rr, ...(u ? { service: u } : {}) };
        });
      }
      return out;
    });
  }
  return body;
}

/** ComputeTargetHTTPProxy → targetHttpProxies.insert body. Pure. */
export function targetHttpProxyBody(resource: GcpResource, ctx: ComputeCtx): Obj {
  const spec = (resource.spec ?? {}) as Obj;
  const body: Obj = { name: computeName(resource), ...pick(spec, ["description", "proxyBind", "httpKeepAliveTimeoutSec"]) };
  if (isObj(spec.urlMapRef)) body.urlMap = refUrl("urlMapRef", spec.urlMapRef as Ref, ctx, scopeOf(spec));
  return body;
}

/** ComputeForwardingRule → forwardingRules.insert body. Pure. */
export function forwardingRuleBody(resource: GcpResource, ctx: ComputeCtx): Obj {
  const spec = (resource.spec ?? {}) as Obj;
  const scope = scopeOf(spec);
  const body: Obj = {
    name: computeName(resource),
    ...pick(spec, ["allowGlobalAccess", "description", "ipVersion", "isMirroringCollector", "loadBalancingScheme", "networkTier", "portRange", "ports", "allPorts"]),
    labels: computeLabels(resource.metadata?.labels),
  };
  if (spec.ipProtocol !== undefined) body.IPProtocol = spec.ipProtocol;
  if (isObj(spec.ipAddress)) {
    const ip = spec.ipAddress as Obj;
    const addr = isObj(ip.addressRef) ? refUrl("addressRef", ip.addressRef as Ref, ctx, scope) : (ip.ip as string | undefined);
    if (addr) body.IPAddress = addr;
  }
  const target = oneRef(spec.target, ctx, scope);
  if (target) body.target = target;
  if (isObj(spec.backendServiceRef)) body.backendService = refUrl("backendServiceRef", spec.backendServiceRef as Ref, ctx, scope);
  if (isObj(spec.networkRef)) body.network = refUrl("networkRef", spec.networkRef as Ref, ctx, scope);
  if (isObj(spec.subnetworkRef)) body.subnetwork = refUrl("subnetworkRef", spec.subnetworkRef as Ref, ctx, scope);
  return body;
}

/**
 * A compute `Operation`: the insert or delete returns one with a `selfLink`,
 * polled until `status: "DONE"`. The link is rebased onto `base`, so an
 * endpoint override (floci-gcp) is polled too. A create that returned the
 * resource itself has nothing to poll.
 */
export const computeOperation: OperationSpec = {
  pollUrl(body, { base }) {
    const op = body as { kind?: string; selfLink?: string } | undefined;
    const link = op?.selfLink;
    if (!link || !link.includes("/operations/")) return undefined;
    const at = link.indexOf("/compute/v1/");
    return at >= 0 ? `${base}${link.slice(at)}` : link;
  },
  isDone(body) {
    return (body as { status?: string })?.status === "DONE";
  },
  error(body) {
    const errors = (body as { error?: { errors?: Array<{ message?: string; code?: string }> } })?.error?.errors;
    return errors?.length ? errors.map((e) => e.message ?? e.code ?? "error").join("; ") : undefined;
  },
};

function computeMapper(
  kind: string,
  collection: string,
  build: (resource: GcpResource, ctx: ComputeCtx) => Obj,
  regionalCollection = collection,
): ResourceMapper {
  return {
    kind,
    defaultHost: COMPUTE_HOST,
    operation: computeOperation,
    plan(resource, ctx) {
      const scope = scopeOf(resource.spec as Obj | undefined);
      const coll = `${ctx.base}/compute/v1/${scopePath(ctx.project, scope)}/${scope === "global" ? collection : regionalCollection}`;
      const name = computeName(resource);
      return { getUrl: `${coll}/${enc(name)}`, create: { method: "POST", url: coll, body: build(resource, ctx) } };
    },
  };
}

export const computeAddressMapper = computeMapper("ComputeAddress", "addresses", addressBody);
export const regionNetworkEndpointGroupMapper = computeMapper("ComputeRegionNetworkEndpointGroup", "networkEndpointGroups", negBody);
export const backendServiceMapper = computeMapper("ComputeBackendService", "backendServices", backendServiceBody);
export const urlMapMapper = computeMapper("ComputeURLMap", "urlMaps", urlMapBody);
export const targetHttpProxyMapper = computeMapper("ComputeTargetHTTPProxy", "targetHttpProxies", targetHttpProxyBody);
export const forwardingRuleMapper = computeMapper("ComputeForwardingRule", "forwardingRules", forwardingRuleBody);
