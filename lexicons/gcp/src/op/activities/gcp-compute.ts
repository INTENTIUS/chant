/**
 * Compute Engine mappers for the Cloud Run load balancer (#4233): ComputeAddress,
 * ComputeRegionNetworkEndpointGroup (serverless NEGs), ComputeBackendService,
 * ComputeURLMap, ComputeTargetHTTPProxy and ComputeForwardingRule; and for a
 * declared network (#4248): ComputeNetwork (always global) and
 * ComputeSubnetwork (regional, by its CNRM `region`).
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
 * the endpoint override, so floci-gcp answers).
 *
 * An existing load balancer resource is compared with its desired body and
 * updated in place where compute allows it (#4238): a backend service or URL
 * map by PATCH with the live `fingerprint`, a proxy's URL map by `setUrlMap`,
 * a forwarding rule's target by `setTarget`, labels by `setLabels` with the
 * live `labelFingerprint`. A difference on a field compute can't change in
 * place (anything on a serverless NEG, an address's IP) is reported as
 * "replace required" and left alone. A network and a subnetwork still
 * reconcile by existence only.
 */
import { gcpResourceLabels } from "../../ownership";
import type { GcpHttp, GcpResource, OperationSpec, ReconcileStep, ResourceMapper } from "./gcp-apply";

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
 * The resource's labels GCP accepts, plus the ownership labels (`managed-by`,
 * `chant-stack`, `chant-env`). Kubernetes-style keys are dropped; see
 * `gcpResourceLabels`.
 */
export function computeLabels(labels: Record<string, unknown> | undefined): Record<string, string> {
  return gcpResourceLabels(labels);
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

/**
 * ComputeNetwork → networks.insert body. A network is global. CNRM's
 * `autoCreateSubnetworks` defaults to false, where compute's default is true,
 * so it is always sent. Pure.
 */
export function networkBody(resource: GcpResource): Obj {
  const spec = (resource.spec ?? {}) as Obj;
  const body: Obj = {
    name: computeName(resource),
    autoCreateSubnetworks: spec.autoCreateSubnetworks === true,
    ...pick(spec, ["description", "mtu", "networkFirewallPolicyEnforcementOrder"]),
  };
  if (typeof spec.routingMode === "string") body.routingConfig = { routingMode: spec.routingMode };
  return body;
}

/** ComputeSubnetwork → subnetworks.insert body. CNRM's `secondaryIpRange` and `logConfig` become compute's `secondaryIpRanges` and an enabled `logConfig`. Pure. */
export function subnetworkBody(resource: GcpResource, ctx: ComputeCtx): Obj {
  const spec = (resource.spec ?? {}) as Obj;
  const scope = scopeOf(spec);
  const body: Obj = {
    name: computeName(resource),
    ...pick(spec, ["ipCidrRange", "description", "privateIpGoogleAccess", "purpose", "role", "stackType"]),
  };
  if (isObj(spec.networkRef)) body.network = refUrl("networkRef", spec.networkRef as Ref, ctx, scope);
  if (Array.isArray(spec.secondaryIpRange)) body.secondaryIpRanges = spec.secondaryIpRange;
  if (isObj(spec.logConfig)) body.logConfig = { enable: true, ...spec.logConfig };
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

/** A compute reference with everything before `projects/` dropped, so a full URL and a partial one compare equal. */
function refTail(v: string): string {
  const at = v.indexOf("projects/");
  return at >= 0 ? v.slice(at) : v;
}

/**
 * True when the live value holds the desired one: every desired key is set
 * live to an equal value, arrays element by element, and a compute URL
 * equals its partial form. Fields only the live side has (defaults, server
 * ids) don't count. Pure.
 */
export function holds(desired: unknown, live: unknown): boolean {
  if (typeof desired === "string" && typeof live === "string") {
    return desired === live || (desired.includes("projects/") && refTail(desired) === refTail(live));
  }
  if (Array.isArray(desired)) {
    return Array.isArray(live) && desired.length === live.length && desired.every((d, i) => holds(d, live[i]));
  }
  if (isObj(desired)) {
    return isObj(live) && Object.entries(desired).every(([k, v]) => holds(v, live[k]));
  }
  return desired === live;
}

/** The desired body's top-level fields the live resource doesn't hold, `name` aside. Pure. */
export function changedFields(desired: Obj, live: Obj): string[] {
  return Object.keys(desired).filter((k) => k !== "name" && !holds(desired[k], live[k]));
}

type Reconcile = (args: {
  url: string;
  desired: Obj;
  live: Obj;
  changed: string[];
  ctx: ComputeCtx;
  http: GcpHttp;
  signal?: AbortSignal;
}) => Promise<ReconcileStep>;

const replace = (kind: string, fields: readonly string[]): ReconcileStep => ({
  replace: `${fields.join(", ")} differ${fields.length === 1 ? "s" : ""}, and compute can't change ${fields.length === 1 ? "it" : "them"} on a ${kind} in place`,
});

/** `labels` by `setLabels` with the live `labelFingerprint`; anything else changed is a replace. */
function labelsOnly(kind: string): Reconcile {
  return async ({ url, desired, live, changed }) => {
    const other = changed.filter((f) => f !== "labels");
    if (other.length) return replace(kind, other);
    if (!changed.length) return { requests: [] };
    return { requests: [{ method: "POST", url: `${url}/setLabels`, body: { labels: desired.labels, labelFingerprint: live.labelFingerprint } }] };
  };
}

/** Every changed field by one PATCH carrying the live `fingerprint` (backend services, URL maps). */
const patchWithFingerprint: Reconcile = async ({ url, desired, live, changed }) =>
  changed.length ? { requests: [{ method: "PATCH", url, body: { ...desired, fingerprint: live.fingerprint } }] } : { requests: [] };

const reconcileProxy: Reconcile = async ({ url, desired, changed }) => {
  const other = changed.filter((f) => f !== "urlMap");
  if (other.length) return replace("ComputeTargetHTTPProxy", other);
  return changed.length ? { requests: [{ method: "POST", url: `${url}/setUrlMap`, body: { urlMap: desired.urlMap } }] } : { requests: [] };
};

/**
 * A forwarding rule's `IPAddress` is a declared address's partial URL, where
 * the live rule holds the IP itself, so the address is read and its IP
 * compared. The target changes by `setTarget`, labels by `setLabels`; any
 * other field is a replace.
 */
const reconcileForwardingRule: Reconcile = async ({ url, desired, live, changed, ctx, http, signal }) => {
  let fields = changed;
  const ip = desired.IPAddress;
  if (fields.includes("IPAddress") && typeof ip === "string" && ip.includes("/addresses/")) {
    const res = await http("GET", `${ctx.base}/compute/v1/${refTail(ip)}`, undefined, signal);
    const address = res.status === 200 ? (JSON.parse(res.text) as Obj).address : undefined;
    if (address !== undefined && address === live.IPAddress) fields = fields.filter((f) => f !== "IPAddress");
  }
  const other = fields.filter((f) => f !== "target" && f !== "labels");
  if (other.length) return replace("ComputeForwardingRule", other);
  const requests: Array<{ method: "POST"; url: string; body: unknown }> = [];
  if (fields.includes("target")) requests.push({ method: "POST", url: `${url}/setTarget`, body: { target: desired.target } });
  if (fields.includes("labels")) {
    requests.push({ method: "POST", url: `${url}/setLabels`, body: { labels: desired.labels, labelFingerprint: live.labelFingerprint } });
  }
  return { requests };
};

const replaceOnAnyChange = (kind: string): Reconcile => async ({ changed }) => (changed.length ? replace(kind, changed) : { requests: [] });

function computeMapper(
  kind: string,
  collection: string,
  build: (resource: GcpResource, ctx: ComputeCtx) => Obj,
  regionalCollection = collection,
  scopeFor: (spec: Obj | undefined) => string = (spec) => scopeOf(spec),
  reconcile?: Reconcile,
): ResourceMapper {
  return {
    kind,
    defaultHost: COMPUTE_HOST,
    operation: computeOperation,
    plan(resource, ctx) {
      const scope = scopeFor(resource.spec as Obj | undefined);
      const coll = `${ctx.base}/compute/v1/${scopePath(ctx.project, scope)}/${scope === "global" ? collection : regionalCollection}`;
      const name = computeName(resource);
      const url = `${coll}/${enc(name)}`;
      const desired = build(resource, ctx);
      return {
        getUrl: url,
        create: { method: "POST", url: coll, body: desired },
        ...(reconcile
          ? {
              reconcile: (live: unknown, http: GcpHttp, signal?: AbortSignal) => {
                const l = isObj(live) ? live : {};
                return reconcile({ url, desired, live: l, changed: changedFields(desired, l), ctx, http, signal });
              },
            }
          : {}),
      };
    },
  };
}

export const computeAddressMapper = computeMapper("ComputeAddress", "addresses", addressBody, undefined, undefined, labelsOnly("ComputeAddress"));
export const regionNetworkEndpointGroupMapper = computeMapper(
  "ComputeRegionNetworkEndpointGroup",
  "networkEndpointGroups",
  negBody,
  undefined,
  undefined,
  replaceOnAnyChange("ComputeRegionNetworkEndpointGroup"),
);
export const backendServiceMapper = computeMapper("ComputeBackendService", "backendServices", backendServiceBody, undefined, undefined, patchWithFingerprint);
export const urlMapMapper = computeMapper("ComputeURLMap", "urlMaps", urlMapBody, undefined, undefined, patchWithFingerprint);
export const targetHttpProxyMapper = computeMapper("ComputeTargetHTTPProxy", "targetHttpProxies", targetHttpProxyBody, undefined, undefined, reconcileProxy);
export const forwardingRuleMapper = computeMapper("ComputeForwardingRule", "forwardingRules", forwardingRuleBody, undefined, undefined, reconcileForwardingRule);
export const networkMapper = computeMapper("ComputeNetwork", "networks", networkBody, "networks", () => "global");
export const subnetworkMapper = computeMapper("ComputeSubnetwork", "subnetworks", subnetworkBody);
