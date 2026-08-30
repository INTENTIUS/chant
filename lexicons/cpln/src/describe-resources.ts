/**
 * Live introspection of cpln resources — the read-back seam for chant's
 * plan/drift machinery.
 *
 * Drives core's observer harness (`observeEntities`) rather than re-deriving
 * its control flow: bind-or-not-observe-all with a typed reason, per-entity
 * tri-state routing, and a read throw degrading to `read-failed` rather than a
 * silent absence — which would classify as a spurious `create` and, on the
 * delete path, as an orphan.
 *
 * The read is a lookup, not a fetch. Control Plane has a by-name endpoint for
 * every kind, but it also has an **org-wide rollup** for the GVC-scoped ones
 * (`/org/{org}/workload` alongside `/org/{org}/gvc/{gvc}/workload`), so listing
 * each declared kind once and indexing it costs one request per kind instead of
 * one per resource — or, for GVC-scoped kinds, one per GVC. The list promise is
 * cached per kind, so concurrent reads share a request and a failed list marks
 * only that kind's entities read-failed.
 *
 * Ownership is unusually clean here. Every kind carries a free-form `tags` map
 * and every read path returns it, so the marker resolves on the thin read —
 * which is not true of aws, where `describe-stack-resources` returns no tags
 * and an `owned: true` thin read can only answer `unknown`. `describeResources`
 * is therefore declared on the ownership channel.
 *
 * No secret value is ever read: the `-reveal` endpoint is not called from this
 * path, and a `secret`'s `data` is not part of what is compared.
 */

import type { ResourceMetadata } from "@intentius/chant/lexicon";
import type { ObservationResult } from "@intentius/chant/observation";
import {
  observeEntities,
  type DeclaredEntity,
  type EntityObservation,
  type ObserverAdapter,
  type UnobservedReason,
} from "@intentius/chant/observation";
import { hasOwnershipMarker } from "@intentius/chant/ownership";
import {
  CplnCredentialsError,
  defaultCplnHttp,
  listKind,
  resolveConfig,
  type CplnConfig,
  type CplnHttp,
  type CplnResource,
} from "./api";
import { kindByTypeName, type CplnKind } from "./kinds";
import { CPLN_TAG_OWNERSHIP_KEYS } from "./ownership";

export interface DescribeResourcesOptions {
  environment: string;
  buildOutput: string;
  entityNames: string[];
  entities: Map<string, { entityType: string; props: Record<string, unknown> }>;
  /** Restrict the result to chant-owned resources. */
  owned?: boolean;
  /** Config overrides (tests, or an explicit org). */
  config?: Partial<CplnConfig>;
  /** Transport override (tests). Defaults to `fetch`. */
  http?: CplnHttp;
}

/** The bound client: the resolved config, the transport, and the per-kind cache. */
interface CplnClient {
  config: CplnConfig;
  http: CplnHttp;
  /** kind name → in-flight or settled list, so N entities of a kind cost one request. */
  lists: Map<string, Promise<Map<string, CplnResource>>>;
}

/**
 * Observe every declared cpln resource against the live org.
 */
export async function describeResources(options: DescribeResourcesOptions): Promise<ObservationResult> {
  const declared: DeclaredEntity[] = [];
  for (const name of options.entityNames) {
    const entity = options.entities.get(name);
    if (!entity) continue;
    declared.push({ name, type: entity.entityType, props: entity.props });
  }

  return observeEntities(declared, adapter(options));
}

function adapter(options: DescribeResourcesOptions): ObserverAdapter<CplnClient> {
  return {
    async bind(): Promise<CplnClient> {
      const config = resolveConfig(options.config);
      return { config, http: options.http ?? defaultCplnHttp(config), lists: new Map() };
    },

    classifyBindFailure(err: unknown): { reason: UnobservedReason; detail?: string } | "rethrow" {
      if (err instanceof CplnCredentialsError) {
        return { reason: "no-credentials", detail: err.message };
      }
      return { reason: "read-failed", detail: err instanceof Error ? err.message : String(err) };
    },

    async read(client: CplnClient, entity: DeclaredEntity): Promise<EntityObservation> {
      const kind = kindByTypeName(entity.type);
      if (!kind) {
        return { unobserved: { reason: "unsupported-kind", detail: `${entity.type} is not a modelled cpln kind` } };
      }

      const index = await listFor(client, kind);
      const declaredName = typeof entity.props.name === "string" ? entity.props.name : entity.name;
      const live = index.get(declaredName);
      if (!live) return { absent: true };

      // A GVC-scoped kind is listed org-wide, so two GVCs may hold resources of
      // the same name. Compare the live resource's own GVC before calling it a
      // match — otherwise a workload in `staging` would be reported as the
      // observed state of the one declared in `prod`.
      if (kind.gvcScoped) {
        const declaredGvc = typeof entity.props.gvc === "string" ? entity.props.gvc : undefined;
        const liveGvc = gvcOf(live);
        if (declaredGvc && liveGvc && declaredGvc !== liveGvc) return { absent: true };
      }

      const owned = hasOwnershipMarker(live.tags, CPLN_TAG_OWNERSHIP_KEYS);

      // `owned: true` filters rather than hides: a foreign resource becomes a
      // typed NOT-OBSERVED, so the caller can tell "not chant's" from "not
      // there" — the latter would read as a create.
      if (options.owned && !owned) {
        return {
          unobserved: {
            reason: "filtered",
            detail: `live ${kind.kind} "${declaredName}" carries no ${CPLN_TAG_OWNERSHIP_KEYS.managedBy} tag`,
          },
        };
      }

      return { present: toMetadata(kind, live, owned) };
    },
  };
}

/** List a kind once per observation, sharing the promise across entities. */
function listFor(client: CplnClient, kind: CplnKind): Promise<Map<string, CplnResource>> {
  const cached = client.lists.get(kind.kind);
  if (cached) return cached;
  const pending = listKind(client.http, client.config, kind);
  client.lists.set(kind.kind, pending);
  return pending;
}

/**
 * The GVC a live resource belongs to.
 *
 * The org-wide rollups do not repeat the GVC as a field; it is in the `links`
 * array as a `gvc` relation (`/org/acme/gvc/prod`). `volumeset` and `identity`
 * additionally carry a `gvc` of their own, in two different shapes, so those
 * are read as a fallback.
 */
export function gvcOf(resource: CplnResource): string | undefined {
  for (const link of resource.links ?? []) {
    if (link.rel !== "gvc" || typeof link.href !== "string") continue;
    const name = link.href.split("/").filter(Boolean).pop();
    if (name) return name;
  }

  const own = resource.gvc;
  if (typeof own === "string" && own.length > 0) return own.split("/").filter(Boolean).pop();
  if (own && typeof own === "object") {
    const name = (own as { name?: unknown }).name;
    if (typeof name === "string") return name;
  }

  return undefined;
}

/**
 * Map a live resource onto chant's `ResourceMetadata`.
 *
 * `status` is a string in chant's model and an object in Control Plane's, so it
 * is summarized rather than stringified: a workload's readiness where there is
 * one, `"active"` otherwise. The full object stays available under `attributes`
 * for anything that wants to look closer.
 */
function toMetadata(kind: CplnKind, live: CplnResource, owned: boolean): ResourceMetadata {
  return {
    type: kind.typeName,
    physicalId: live.id,
    status: statusOf(live),
    lastUpdated: live.lastModified,
    ownership: owned ? "owned" : "foreign",
    attributes: {
      name: live.name,
      version: live.version,
      refs: referenceAttributes(kind, live),
      ...(live.tags ? { tags: live.tags } : {}),
      ...(kind.gvcScoped ? { gvc: gvcOf(live) } : {}),
      ...(live.status ? { status: live.status } : {}),
    },
  };
}

/**
 * Resolve this resource's outbound links down to the bare names they point at.
 *
 * Edge reconstruction matches identifiers exactly, and a Control Plane link
 * (`//gvc/prod/identity/api`) never equals the `name` it references. Resolving
 * here — where the whole live resource is in hand — means `reference-catalog.ts`
 * is a plain table of paths rather than a table of paths plus extractors, and
 * means no second enrichment pass over the observed set.
 *
 * Keys are stable regardless of kind; an absent relation is simply missing.
 */
export function referenceAttributes(kind: CplnKind, live: CplnResource): Record<string, unknown> {
  const refs: Record<string, unknown> = {};
  const spec = (live.spec ?? {}) as Record<string, unknown>;

  if (kind.gvcScoped) {
    const gvc = gvcOf(live);
    if (gvc) refs.gvc = gvc;
  }

  const identity = linkName(spec.identityLink);
  if (identity) refs.identity = identity;

  const pullSecrets = linkNames(spec.pullSecretLinks);
  if (pullSecrets.length > 0) refs.pullSecrets = pullSecrets;

  // A domain's GVC is a link rather than a scoping relation, so it is read from
  // the spec even though the kind is org-scoped.
  if (kind.kind === "domain") {
    const gvc = linkName(spec.gvcLink);
    if (gvc) refs.gvc = gvc;
  }

  const workloads = [
    ...linkNames(spec.workloadLink),
    ...linkNames(spec.link),
    ...routeWorkloads(spec),
  ].filter((name, index, all) => all.indexOf(name) === index);
  if (workloads.length > 0) refs.workloads = workloads;

  const targets = linkNames(live.targetLinks);
  if (targets.length > 0) refs.targets = targets;

  const volumeSets = mountedVolumeSets(spec);
  if (volumeSets.length > 0) refs.volumeSets = volumeSets;

  return refs;
}

/** The last path segment of a link (`//gvc/prod/identity/api` → `api`). */
function linkName(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (!value.startsWith("//") && !value.startsWith("/org/") && !value.startsWith("cpln://")) return undefined;
  // A `cpln://secret/name.field` reference names a field after the resource.
  const last = value.split("/").filter(Boolean).pop();
  return last?.split(".")[0];
}

/** Resolve a link or a list of links to names, dropping anything unparseable. */
function linkNames(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.map(linkName).filter((name): name is string => !!name);
}

/** Workloads named by a domain's per-port routes. */
function routeWorkloads(spec: Record<string, unknown>): string[] {
  const names: string[] = [];
  const ports = Array.isArray(spec.ports) ? spec.ports : [];
  for (const port of ports) {
    const routes = (port as { routes?: unknown }).routes;
    if (!Array.isArray(routes)) continue;
    for (const route of routes) {
      const name = linkName((route as { workloadLink?: unknown }).workloadLink);
      if (name) names.push(name);
    }
  }
  return names;
}

/** Volume sets a workload's containers mount, from their `cpln://volumeset/…` URIs. */
function mountedVolumeSets(spec: Record<string, unknown>): string[] {
  const names: string[] = [];
  const containers = Array.isArray(spec.containers) ? spec.containers : [];
  for (const container of containers) {
    const volumes = (container as { volumes?: unknown }).volumes;
    if (!Array.isArray(volumes)) continue;
    for (const volume of volumes) {
      const uri = (volume as { uri?: unknown }).uri;
      if (typeof uri !== "string" || !uri.startsWith("cpln://volumeset/")) continue;
      names.push(uri.slice("cpln://volumeset/".length));
    }
  }
  return names;
}

/** A one-word status for a live resource. */
function statusOf(live: CplnResource): string {
  const health = live.health;
  if (health && typeof health === "object") {
    const readiness = (health as { readiness?: unknown }).readiness;
    if (typeof readiness === "string" && readiness.length > 0) return readiness;
  }

  const status = live.status;
  if (status && typeof status === "object") {
    const ready = (status as { ready?: unknown }).ready;
    if (typeof ready === "boolean") return ready ? "ready" : "not-ready";
  }

  return "active";
}
