/**
 * GCP deep observation (#1087, re-landed on direct REST by #1209/#1210) — the
 * GCP row of the deep-observe contract (#1014).
 *
 * ## The reader is the applier's transport, pointed at reads
 *
 * chant applies GCP cluster-free over direct REST (#706), and since #1209 it
 * observes the same way: every GET here is built by the same
 * `ResourceMapper.plan().getUrl` the applier writes through (see
 * ./api/read-client.ts), so reader and applier cannot disagree about where a
 * resource lives. `GCP_ENDPOINT_URL` redirects the whole reader at a local
 * floci-gcp; unset means real GCP, exactly as it does for the applier.
 * Coverage is the applier's own dispatch table — a kind with no mapper cannot
 * be applied either, and reports NOT-OBSERVED with `unsupported-kind` (#1089)
 * rather than being dropped.
 *
 * ## Two shapes, one diff
 *
 * The declared side is a CNRM spec as a declarable authors it (`{ metadata:
 * { name }, location, storageClass }`); the REST APIs return their own shapes
 * (`name` is usually the full resource path, a bucket's `iamConfiguration`
 * nests what CNRM flattens, a subscription's `topic` is a path where CNRM
 * writes `topicRef`). Diffed raw, every such field drifts twice: once as
 * `declared -> <absent>` and once as `<undeclared> -> live`.
 * {@link restToCnrmShape} plus the per-kind {@link CNRM_REFINERS} put the live
 * payload into the declared vocabulary before the diff runs — the same move
 * the AWS row makes with its per-type `toModel` (#1207/#1269), and it lives
 * next to the read for the same reason: translation is the price of the
 * richer read, and it does not belong inside the diff.
 *
 * ## Noise is a static table, not an ownership walk
 *
 * The kubectl-era reader pruned by CNRM `metadata.managedFields`. A REST
 * payload never says who wrote a field, so the noise rules are static
 * (./deep-observe-hooks.ts): server-assigned names, chant's own ownership
 * labels, CNRM-only declared fields, and per-kind provider defaults gated on
 * "source never declared it". Core applies the same hooks to both trees.
 *
 * ## The build-path boundary
 *
 * `gcpPlugin.ts` reaches this file only via `await import("./deep-observe")`
 * inside `observeResourcesDeep` — never statically — so `chant build` never
 * resolves the live transport just to synthesize a template.
 * `deepNormalizationHooks` is plain data (./deep-observe-hooks.ts) and is
 * imported statically from `plugin.ts`, because core normalizes the
 * *declared* tree with it whether or not a live read ever happens.
 */

import type {
  DeepObservationResult,
  DeepResourceObservation,
  UnobservedEntity,
} from "@intentius/chant/lexicon";
import { deepObservation, normalizeDeepProperties } from "@intentius/chant/deep-observation";
import { hasOwnershipMarker, type ChannelKeys } from "@intentius/chant/ownership";
import { deriveGVK, manifestProjectAnnotations, resolveReadProject } from "./describe-resources";
import { getResource, mapperForKind, GcpReadError, isNotFound, type GcpReadClientOptions } from "./api/read-client";
import { gcpDeepNormalizationHooks } from "./deep-observe-hooks";

/** The labels the applier stamps — see describe-resources.ts. */
const GCP_OWNERSHIP_LABEL_KEYS: ChannelKeys = {
  managedBy: "managed-by",
  stack: "chant-stack",
  env: "chant-env",
};

// Re-exported so a dynamic importer of this module (plugin.ts's
// `observeResourcesDeep`, a test) can get the reader and its hooks from one
// place. `plugin.ts`'s own `deepNormalizationHooks` field imports the hooks
// separately, directly from `./deep-observe-hooks` — see the module doc.
export { gcpDeepNormalizationHooks };

export interface GcpDeepObserveOptions {
  environment: string;
  buildOutput?: string;
  entityNames: string[];
  entities: Map<string, { entityType: string; props: Record<string, unknown> }>;
  stack?: string;
  owned?: boolean;
}

/**
 * Reshape a GCP REST body into the shape the declared props are written in:
 * identity and labels under `metadata`, everything else at the root — a CNRM
 * spec as a chant declarable authors it (`new StorageBucket({ metadata,
 * location, storageClass })`). Kind-specific vocabulary differences on top of
 * it are {@link CNRM_REFINERS}' job. Verified against floci-gcp: diffed raw, a
 * bucket that matched its declaration exactly reported every field as drift
 * twice, once per shape.
 */
export function restToCnrmShape(body: Record<string, unknown>): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === "name" || key === "labels" || key === "annotations") metadata[key] = value;
    else rest[key] = value;
  }
  return {
    ...(Object.keys(metadata).length ? { metadata } : {}),
    ...rest,
  };
}

/** The live payload minus the fields that live outside `properties` on
 * {@link DeepResourceObservation}. A REST body has no `apiVersion`, but `kind`
 * shows up on some (GCS returns `storage#bucket`), so both are dropped. */
function propertiesTreeOf(obj: Record<string, unknown>): Record<string, unknown> {
  const { apiVersion: _apiVersion, kind: _kind, ...rest } = obj;
  return rest;
}

/** What a refiner may need beyond the tree: the read's project, and the REST
 * payload's own full resource name (`projects/p/locations/l/services/s`). */
interface RefineContext {
  project: string;
  restName?: string;
}

type CnrmTree = Record<string, unknown> & { metadata?: Record<string, unknown> };

/**
 * Per-kind REST -> CNRM vocabulary mapping, applied after the generic
 * {@link restToCnrmShape}. Each entry translates exactly the fields where the
 * REST API and the CNRM schema disagree about names or nesting — kept next to
 * the kind, like the applier's forward mapping in gcp-apply.ts, so adding a
 * field means touching one kind in one file per direction.
 */
const CNRM_REFINERS: Record<string, (tree: CnrmTree, ctx: RefineContext) => void> = {
  StorageBucket(tree) {
    // CNRM flattens GCS's `iamConfiguration` envelope.
    const iam = tree.iamConfiguration as
      | { uniformBucketLevelAccess?: { enabled?: unknown }; publicAccessPrevention?: unknown }
      | undefined;
    if (iam) {
      if (iam.uniformBucketLevelAccess?.enabled !== undefined) {
        tree.uniformBucketLevelAccess = iam.uniformBucketLevelAccess.enabled;
      }
      if (iam.publicAccessPrevention !== undefined) tree.publicAccessPrevention = iam.publicAccessPrevention;
      delete tree.iamConfiguration;
    }
    // `lifecycle.rule` -> `lifecycleRule`, the inverse of bucketInsertBody.
    const lifecycle = tree.lifecycle as { rule?: unknown } | undefined;
    if (lifecycle) {
      if (lifecycle.rule !== undefined) tree.lifecycleRule = lifecycle.rule;
      delete tree.lifecycle;
    }
  },
  PubSubSubscription(tree, ctx) {
    const topic = tree.topic;
    if (typeof topic !== "string") return;
    // The declared side writes a `topicRef`; a same-project path maps to the
    // `name` form the manifest overwhelmingly uses, anything else to `external`.
    const prefix = `projects/${ctx.project}/topics/`;
    tree.topicRef = topic.startsWith(prefix) ? { name: topic.slice(prefix.length) } : { external: topic };
    delete tree.topic;
  },
  SecretManagerSecret(tree) {
    // CNRM spells automatic replication as a boolean; the REST API as `{}`.
    const replication = tree.replication as { automatic?: unknown } | undefined;
    if (replication && typeof replication.automatic === "object" && replication.automatic !== null) {
      replication.automatic = true;
    }
  },
  IAMServiceAccount(tree, ctx) {
    // The REST identity is the derived email; the declared name is the account
    // id it was derived from (see gcpServiceAccountMapper).
    const name = tree.metadata?.name;
    if (typeof name === "string" && name.endsWith(`@${ctx.project}.iam.gserviceaccount.com`)) {
      tree.metadata!.name = name.slice(0, name.indexOf("@"));
    }
  },
  RunService(tree, ctx) {
    // The v2 payload carries no `location` field — it lives in the resource
    // name. The declared side writes it as `location`.
    const m = ctx.restName ? /\/locations\/([^/]+)\//.exec(ctx.restName) : null;
    if (m) tree.location = m[1];
  },
};

/**
 * A REST payload as a CNRM-shaped property tree, in the declared side's
 * vocabulary. The generic reshape runs first, then the full resource path is
 * shortened to the declared `metadata.name` (`projects/p/topics/t` -> `t`),
 * then the kind's own refiner translates what the two schemas name
 * differently.
 */
export function toCnrmTree(kind: string, body: Record<string, unknown>, ctx: RefineContext): Record<string, unknown> {
  const tree = restToCnrmShape(propertiesTreeOf(body)) as CnrmTree;
  const restName = typeof body.name === "string" ? body.name : undefined;
  const name = tree.metadata?.name;
  if (typeof name === "string" && name.includes("/")) {
    tree.metadata!.name = name.slice(name.lastIndexOf("/") + 1);
  }
  CNRM_REFINERS[kind]?.(tree, { ...ctx, restName });
  return tree as Record<string, unknown>;
}

/**
 * Read the live property tree for each declared entity over the applier's
 * REST transport, normalized into the declared CNRM shape (see the module
 * doc). A connect failure becomes NOT-OBSERVED for every declared entity
 * rather than an empty result, and a 404 is a real absence the thin read
 * already reports.
 */
export async function observeResourcesDeepGcp(options: GcpDeepObserveOptions): Promise<DeepObservationResult> {
  const resources: Record<string, DeepResourceObservation> = {};
  const unobserved: Record<string, UnobservedEntity> = {};

  const endpoint = process.env.GCP_ENDPOINT_URL;
  const manifestProjects = manifestProjectAnnotations(options.buildOutput);

  const reads = [...options.entities].map(async ([entityName, { entityType, props }]) => {
    const gvk = deriveGVK(entityType);
    if (!gvk || !mapperForKind(gvk.kind)) {
      unobserved[entityName] = {
        type: entityType,
        reason: "unsupported-kind",
        detail: gvk
          ? `no REST mapper for ${gvk.kind} — chant cannot apply this kind either`
          : `cannot derive a GCP kind from ${entityType}`,
      };
      return;
    }

    const metadata = props.metadata as { name?: string; annotations?: Record<string, string> } | undefined;
    const name = metadata?.name;
    if (!name) {
      unobserved[entityName] = {
        type: entityType,
        reason: "read-failed",
        detail: "declared entity has no metadata.name to query by",
      };
      return;
    }

    let client: GcpReadClientOptions;
    try {
      client = {
        project: resolveReadProject(gvk.kind, name, metadata, manifestProjects),
        ...(endpoint ? { endpoint } : {}),
      };
    } catch (err) {
      unobserved[entityName] = {
        type: entityType,
        reason: "no-binding",
        detail: err instanceof Error ? err.message : String(err),
      };
      return;
    }

    try {
      const obj = await getResource(client, gvk.kind, name, props);
      const labels = obj.labels as Record<string, string> | null | undefined;

      // owned filter: withhold what does not carry chant's marker. Withheld is
      // not absent (#1089). Where the payload has no labels at all there is
      // nothing to filter on, so the resource passes through — the same
      // detect-only degradation the thin path takes.
      if (options.owned && labels != null && !hasOwnershipMarker(labels, GCP_OWNERSHIP_LABEL_KEYS)) {
        unobserved[entityName] = {
          type: entityType,
          reason: "filtered",
          detail: "live resource carries no chant ownership marker and --owned was requested",
        };
        return;
      }

      resources[entityName] = {
        type: entityType,
        physicalId:
          (obj.id as string | undefined) ?? (obj.selfLink as string | undefined) ?? (obj.name as string | undefined),
        properties: normalizeDeepProperties(toCnrmTree(gvk.kind, obj, { project: client.project }), {
          entityType,
          side: "live",
          // The static table is the whole prune now — there is no per-resource
          // ownership pass, because a REST payload carries no field ownership
          // to drive one (see ./deep-observe-hooks.ts).
          hooks: gcpDeepNormalizationHooks,
        }),
      };
    } catch (err) {
      // A 404 is a real absence, same as the thin read — recorded there, not
      // restated here. Anything else proves nothing and is a hole (#1089).
      if (isNotFound(err)) return;
      const status = err instanceof GcpReadError ? err.status : undefined;
      unobserved[entityName] = {
        type: entityType,
        reason: status === 401 || status === 403 ? "no-credentials" : "read-failed",
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  });

  await Promise.all(reads);

  return deepObservation(resources, unobserved);
}
