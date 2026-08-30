/**
 * The Kubernetes carve provider (#2016 seam, #999 emit).
 *
 * `kubernetes_manifest` IS the manifest (tier 1) and is the type emit adopts.
 * The typed provider resources (`kubernetes_deployment`, ...) reshape their HCL
 * schema back into a manifest, so they rank tier 2; the common `_v1` aliases
 * share their base type's entry. They are advise-only: recovering a manifest
 * from the provider's own schema is a per-type reshaping (`container` blocks to
 * `containers`, `metadata` blocks unwrapped from their single-element state
 * arrays), not something the generic path below can do honestly, so emit
 * refuses them on both paths with the same message (#2015).
 *
 * ── Two things `kubernetes_manifest` does not share with an AWS type ──
 *
 * It has no fixed entity type. The target kind lives INSIDE the resource: the
 * `manifest` attribute is the body, and its `apiVersion`/`kind` are what say
 * whether this block is a ConfigMap or a cert-manager Certificate. So `mapsTo`
 * can only name the family, and `adopt` reads the body to learn the rest —
 * which is also why one rule here covers every CRD.
 *
 * It has no live adoption path. `carve emit --env` filters a live export by a
 * native type, and there is no type to filter by until the body is read; state
 * is where the body is. `liveSelectorType` therefore returns undefined and
 * `--env` refuses with "adopts it from state only", rather than importing
 * something else.
 */

import type { AdoptedSource, CarveProvider, DeferredParam, TierInfo } from "../carve-provider";
import type { StateResource } from "../state";

/** The chant lexicon the emitted source imports from. */
const K8S_LEXICON_IMPORT = "@intentius/chant-lexicon-k8s";

/**
 * The chant entity types the ranked provider resources correspond to — real
 * three-part `K8s::<Group>::<Kind>` names from the generated operation surface
 * (`lexicons/k8s/src/generated/operations.json`). The earlier `k8s:Namespace`
 * spelling was in no table: `operationFor` missed it and `deriveOperation`
 * rejected it for not having three parts, so anything routed by these strings
 * addressed nothing.
 */
const BASE_TIERS: Record<string, TierInfo> = {
  // No fixed type: the kind comes from the manifest body, per resource.
  kubernetes_manifest: { tier: 1, mapsTo: "K8s::*" },
  kubernetes_namespace: { tier: 2, mapsTo: "K8s::Core::Namespace" },
  kubernetes_config_map: { tier: 2, mapsTo: "K8s::Core::ConfigMap" },
  kubernetes_secret: { tier: 2, mapsTo: "K8s::Core::Secret" },
  kubernetes_service: { tier: 2, mapsTo: "K8s::Core::Service" },
  kubernetes_service_account: { tier: 2, mapsTo: "K8s::Core::ServiceAccount" },
  kubernetes_deployment: { tier: 2, mapsTo: "K8s::Apps::Deployment" },
  kubernetes_stateful_set: { tier: 2, mapsTo: "K8s::Apps::StatefulSet" },
  kubernetes_daemon_set: { tier: 2, mapsTo: "K8s::Apps::DaemonSet" },
  kubernetes_job: { tier: 2, mapsTo: "K8s::Batch::Job" },
  kubernetes_cron_job: { tier: 2, mapsTo: "K8s::Batch::CronJob" },
  kubernetes_ingress: { tier: 2, mapsTo: "K8s::Networking::Ingress" },
  kubernetes_network_policy: { tier: 2, mapsTo: "K8s::Networking::NetworkPolicy" },
  kubernetes_persistent_volume_claim: { tier: 2, mapsTo: "K8s::Core::PersistentVolumeClaim" },
  kubernetes_role: { tier: 2, mapsTo: "K8s::Rbac::Role" },
  kubernetes_role_binding: { tier: 2, mapsTo: "K8s::Rbac::RoleBinding" },
  kubernetes_cluster_role: { tier: 2, mapsTo: "K8s::Rbac::ClusterRole" },
  kubernetes_cluster_role_binding: { tier: 2, mapsTo: "K8s::Rbac::ClusterRoleBinding" },
  kubernetes_resource_quota: { tier: 2, mapsTo: "K8s::Core::ResourceQuota" },
  kubernetes_limit_range: { tier: 2, mapsTo: "K8s::Core::LimitRange" },
  kubernetes_priority_class: { tier: 2, mapsTo: "K8s::Scheduling::PriorityClass" },
  kubernetes_pod_disruption_budget: { tier: 2, mapsTo: "K8s::Policy::PodDisruptionBudget" },
  kubernetes_horizontal_pod_autoscaler: { tier: 2, mapsTo: "K8s::Autoscaling::HorizontalPodAutoscaler" },
};

const TIERS: Record<string, TierInfo> = Object.fromEntries(
  Object.entries(BASE_TIERS).flatMap(([type, info]) =>
    type === "kubernetes_manifest" ? [[type, info]] : [[type, info], [`${type}_v1`, info]],
  ),
);
// The one provider type whose current alias is _v2, not _v1.
TIERS.kubernetes_horizontal_pod_autoscaler_v2 = BASE_TIERS.kubernetes_horizontal_pod_autoscaler;

/**
 * Metadata the API server owns. Present when the body was read back from the
 * `object` attribute (the provider's computed view); carving them into source
 * would declare a resourceVersion as if an author had chosen it.
 */
const SERVER_OWNED_METADATA = new Set([
  "creationTimestamp",
  "generation",
  "managedFields",
  "resourceVersion",
  "selfLink",
  "uid",
]);

/** Attributes of the Terraform resource that configure the provider, not the object. */
const PROVIDER_BEHAVIOUR_ATTRS = ["wait", "wait_for", "field_manager", "computed_fields", "timeouts"];

/**
 * The manifest body out of state. `manifest` is what the configuration
 * declared; `object` is the provider's computed read-back of the live object,
 * used only when `manifest` is absent, and cleaned of server-owned metadata.
 */
function manifestBody(attributes: Record<string, unknown>): Record<string, unknown> | null {
  const raw = isObject(attributes.manifest) ? attributes.manifest : isObject(attributes.object) ? attributes.object : null;
  if (!raw) return null;
  if (typeof raw.apiVersion !== "string" || typeof raw.kind !== "string") return null;

  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "status") continue; // observed, never declared
    if (key === "metadata" && isObject(value)) {
      const metadata: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        if (!SERVER_OWNED_METADATA.has(k)) metadata[k] = v;
      }
      body.metadata = metadata;
      continue;
    }
    body[key] = value;
  }
  // apiVersion and kind lead the emitted object, matching manifest convention.
  const { apiVersion, kind, metadata, ...rest } = body;
  return { apiVersion, kind, ...(metadata === undefined ? {} : { metadata }), ...rest };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A Terraform logical name as a JS identifier — TF allows `-`, source does not. */
function identifier(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_$]/g, "_");
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
}

/** An object key: bare when it is an identifier, quoted otherwise (`app.kubernetes.io/name`). */
function renderKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

/** Render a manifest value as a TypeScript literal, nested objects and arrays included. */
function renderManifestValue(value: unknown, indent: number): string {
  const pad = " ".repeat(indent);
  const inner = " ".repeat(indent + 2);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[\n${value.map((v) => `${inner}${renderManifestValue(v, indent + 2)},`).join("\n")}\n${pad}]`;
  }
  if (isObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) return "{}";
    return `{\n${keys.map((k) => `${inner}${renderKey(k)}: ${renderManifestValue(value[k], indent + 2)},`).join("\n")}\n${pad}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Adopt a `kubernetes_manifest` into chant source.
 *
 * The body is emitted verbatim through the lexicon's `k8sManifest` escape
 * hatch rather than a typed constructor. A typed constructor cannot carry this:
 * an arbitrary CRD has no generated class at all, and a generated class types
 * its props as the kind's own schema, so it would reject the `apiVersion`/
 * `kind` pair the state recorded. `k8sManifest` derives the entity type from
 * that pair through the lexicon's one group→namespace rule, which is also why
 * core does not resolve `K8s::<Group>::<Kind>` here — a second copy of that
 * rule would drift from the overrides (`argoproj.io` to `Argo`) the lexicon
 * keeps.
 *
 * Deferred outbound inputs (#998) are reported in a comment, not substituted.
 * A `kubernetes_manifest` reads a survivor from inside the body, so the
 * boundary report names the enclosing attribute (`manifest`) and the state
 * resolves it to the whole object — there is no scalar to swap for a
 * `params.<name>` reference. The emitted source keeps what the state resolved;
 * the scaffold still declares the input as a build parameter.
 */
function adoptManifestFromState(resource: StateResource, params: DeferredParam[]): AdoptedSource | null {
  const body = manifestBody(resource.attributes);
  if (!body) return null;
  const gvk = `${body.apiVersion} ${body.kind}`;

  const L: string[] = [];
  L.push(`// Adopted from Terraform state: ${resource.type}.${resource.name} -> ${gvk}`);
  L.push(`// The Terraform type names no kind — apiVersion/kind come from the manifest`);
  L.push(`// body in state, and the body is carried over verbatim.`);
  const behaviour = PROVIDER_BEHAVIOUR_ATTRS.filter((a) => {
    const v = resource.attributes[a];
    return v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0);
  });
  if (behaviour.length) {
    L.push(`// Provider-behaviour attributes not part of the object: ${behaviour.join(", ")}.`);
  }
  if (params.length) {
    for (const p of params) {
      L.push(`// Deferred deploy-time input: ${p.tfAttr} read ${p.survivor}.${p.attrs.join("/")} — inlined as state resolved it,`);
      L.push(`// and declared as build param "${p.name}" in chant.config.ts.`);
    }
  }
  L.push(`import { k8sManifest } from "${K8S_LEXICON_IMPORT}";`);
  L.push("");
  L.push(`export const ${identifier(resource.name)} = k8sManifest(${renderManifestValue(body, 0)});`);

  return {
    fileName: `${identifier(resource.name)}.ts`,
    content: L.join("\n") + "\n",
    mapped: true,
    nativeType: gvk,
    // Nothing is parameterized: see the note above.
    parameterized: [],
    // The kubernetes provider splits no sub-resource out of a manifest.
    folded: [],
  };
}

export const kubernetesCarveProvider: CarveProvider = {
  name: "kubernetes",
  tfTypePrefixes: ["kubernetes_"],
  lexicon: "k8s",
  tiers: TIERS,
  // A dotted path into nested blocks: the graph walks it for identity, and
  // `carve bridge` refuses the type because a data-source body cannot express it.
  identityAttrs: { kubernetes_manifest: "manifest.metadata.name" },
  emitTypes: ["kubernetes_manifest"],
  adopt: (resource, params) => adoptManifestFromState(resource, params),
  // State only — the kind is in the body, so a live export has nothing to
  // filter on. Returning undefined is what makes `--env` say so.
  liveSelectorType: () => undefined,
};
