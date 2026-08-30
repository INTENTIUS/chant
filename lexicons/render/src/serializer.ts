/**
 * Render serializer.
 *
 * Turns declared `WebService`, `Postgres`, `EnvGroup`, `Project`, ... resources
 * into the JSON create bodies the Render Public API accepts, so the applier can
 * POST them straight through.
 *
 * Output shape — a JSON object keyed by entity name. Each value is a single
 * Render request plus the identity the applier reconciles by:
 *
 *   {
 *     "<entityName>": {
 *       "kind": "WebService",                       // generated class name
 *       "entityType": "Render::Services::WebService",
 *       "endpoint": "/services",                    // create collection
 *       "method": "POST",
 *       "name": "my-web",                           // reconcile key (Render has no client-chosen ids)
 *       "body": { ... },                            // the create body
 *       "pathParams": { "serviceId": { "$ref": "web" } }   // for child collections
 *     }
 *   }
 *
 * Cross-resource references. Render identifies resources by server-assigned
 * ids, so a Disk's `serviceId` or an Environment's `projectId` cannot be known
 * at build time. A declared resource passed where an id is expected serializes
 * to `{ "$ref": "<entityName>" }`; an attribute read (`db.internalConnectionString`)
 * to `{ "$attr": { "entity": "<entityName>", "attribute": "..." } }`. The applier
 * resolves both once the target exists.
 *
 * Ownership. Every serialized service and env group carries the
 * `CHANT_MANAGED_BY=chant` marker (plus the stack/env identity from
 * `context.ownership`) merged into `envVars`, even when the author supplied
 * none. See ./ownership.ts for why env vars.
 *
 * `ownerId`. Every owner-scoped body gets `ownerId` filled from `Render.OwnerId`
 * (`RENDER_OWNER_ID`) when the author omitted it. When that is unset too, an
 * `{ "$owner": true }` marker is left for the applier, which resolves it from
 * `GET /owners` when the token sees exactly one workspace.
 */

import type { Declarable } from "@intentius/chant/declarable";
import { isPropertyDeclarable, isResourceDeclarable } from "@intentius/chant/declarable";
import type { Serializer, SerializeContext } from "@intentius/chant/serializer";
import type { LexiconOutput } from "@intentius/chant/lexicon-output";
import { ownershipEntries, OWNERSHIP_MANAGED_BY_VALUE } from "@intentius/chant/ownership";
import { walkValue, type SerializerVisitor } from "@intentius/chant/serializer-walker";
import { INTRINSIC_MARKER } from "@intentius/chant/intrinsic";
import { RENDER_ENV_OWNERSHIP_KEYS } from "./ownership";
import { CATALOG, SERVICE_TYPE_OF, catalogEntry, isServiceEntityType } from "./catalog";

/** A cross-resource id reference the applier resolves after the target exists. */
export interface RefMarker {
  $ref: string;
}

/** An attribute read the applier resolves from the live target. */
export interface AttrMarker {
  $attr: { entity: string; attribute: string };
}

/** The workspace placeholder left when neither the author nor `RENDER_OWNER_ID` named one. */
export interface OwnerMarker {
  $owner: true;
}

export function isRefMarker(v: unknown): v is RefMarker {
  return !!v && typeof v === "object" && typeof (v as RefMarker).$ref === "string";
}

export function isAttrMarker(v: unknown): v is AttrMarker {
  const a = v as AttrMarker;
  return !!a && typeof a === "object" && !!a.$attr && typeof a.$attr.entity === "string";
}

export function isOwnerMarker(v: unknown): v is OwnerMarker {
  return !!v && typeof v === "object" && (v as OwnerMarker).$owner === true;
}

/** A single Render REST call the applier can issue, plus its reconcile identity. */
export interface RenderRequest {
  kind: string;
  entityType: string;
  endpoint: string;
  method: "POST";
  /** The human name Render will show and chant reconciles by. */
  name: string;
  body: Record<string, unknown>;
  /** Path placeholders in `endpoint` (child collections). */
  pathParams?: Record<string, unknown>;
}

/** The serializer's whole output: entity name → request. */
export type RenderPlan = Record<string, RenderRequest>;

/**
 * Visitor for the generic serializer walker. Property declarables
 * (WebServiceDetails, Image, ServiceDisk, ...) are unwrapped to plain objects;
 * resource references and attribute reads become the applier's markers.
 */
function renderVisitor(): SerializerVisitor {
  return {
    attrRef: (entity, attribute) => ({ $attr: { entity, attribute } }),
    resourceRef: (name) => ({ $ref: name }),
    propertyDeclarable: (entity, walk) => {
      const props = isResourceDeclarable(entity) ? entity.props : undefined;
      if (!props || typeof props !== "object") return undefined;
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(props)) {
        if (value !== undefined) result[key] = walk(value);
      }
      return result;
    },
  };
}

function readProps(entity: Declarable): Record<string, unknown> {
  const props = isResourceDeclarable(entity) ? entity.props : undefined;
  return props && typeof props === "object" ? (props as Record<string, unknown>) : {};
}

/**
 * Pseudo-parameter → environment variable mapping. Render bodies are plain
 * JSON, so `Render.OwnerId` / `Render.Region` (which the walker lowers to a
 * `{ Ref: "Render::..." }` marker) are resolved from the environment at build
 * time. Region has a fallback (Render's own default); the owner does not — an
 * unset owner becomes the `$owner` marker for the applier.
 */
const PSEUDO_ENV_MAP: Record<string, { envVars: string[]; fallback?: unknown }> = {
  "Render::OwnerId": { envVars: ["RENDER_OWNER_ID"], fallback: { $owner: true } },
  "Render::Region": { envVars: ["RENDER_REGION"], fallback: "oregon" },
};

function resolvePseudoRef(ref: string): unknown {
  const mapping = PSEUDO_ENV_MAP[ref];
  if (!mapping) return undefined;
  for (const envVar of mapping.envVars) {
    const value = process.env[envVar];
    if (value) return value;
  }
  return mapping.fallback;
}

/**
 * Recursively replace pseudo-parameters with their resolved environment value.
 * Handles both a raw `PseudoParameter` instance and the already-walked
 * `{ Ref: "Render::X" }` shape. Everything else passes through untouched.
 */
export function resolvePseudoParameters(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(resolvePseudoParameters);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;

    if (INTRINSIC_MARKER in record && typeof record.toJSON === "function") {
      return resolvePseudoParameters(record.toJSON());
    }

    const keys = Object.keys(record);
    if (keys.length === 1 && keys[0] === "Ref" && typeof record.Ref === "string") {
      const resolved = resolvePseudoRef(record.Ref);
      if (resolved !== undefined) return resolved;
    }
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(record)) {
      result[key] = resolvePseudoParameters(val);
    }
    return result;
  }
  return value;
}

/** The Render name a resource gets: an explicit `name` prop, else the entity name. */
function resourceName(props: Record<string, unknown>, entityName: string): string {
  return typeof props.name === "string" && props.name ? props.name : entityName;
}

/**
 * Merge chant's ownership marker into an `envVars` list. The marker wins over
 * any colliding user key so ownership can never be silently unset; the user's
 * ordering is otherwise preserved.
 */
export function stampOwnership(envVars: unknown, marker: Record<string, string>): unknown[] {
  const list = Array.isArray(envVars) ? [...envVars] : [];
  const out = list.filter((e) => !(e && typeof e === "object" && (e as { key?: unknown }).key !== undefined && (e as { key: string }).key in marker));
  for (const [key, value] of Object.entries(marker)) out.push({ key, value });
  return out;
}

/**
 * Serialize a render partition into the plan document `renderApply` consumes.
 *
 * Split out of the `Serializer` object so callers that need the concrete
 * document — the applier, its tests, the `describeResources` fixtures — get
 * `string` rather than the interface's `string | SerializerResult` union.
 */
export function serializeRender(
  entities: Map<string, Declarable>,
  _outputs?: LexiconOutput[],
  context?: SerializeContext,
): string {
  const entityNames = new Map<Declarable, string>();
  for (const [name, entity] of entities) entityNames.set(entity, name);
  const visitor = renderVisitor();

  // Ownership marker. `CHANT_MANAGED_BY=chant` is always stamped; stack/env
  // are added when the build threads an ownership marker through the context.
  const ownershipEnv: Record<string, string> = context?.ownership
    ? ownershipEntries(RENDER_ENV_OWNERSHIP_KEYS, context.ownership)
    : { [RENDER_ENV_OWNERSHIP_KEYS.managedBy]: OWNERSHIP_MANAGED_BY_VALUE };

  const requests: RenderPlan = {};

  for (const [entityName, entity] of entities) {
    if (isPropertyDeclarable(entity)) continue;
    const entityType = (entity as unknown as { entityType?: string }).entityType;
    if (!entityType || !(entityType in CATALOG)) continue;
    const entry = catalogEntry(entityType);
    const props = readProps(entity);

    // Body: every prop except association hints, walked so nested property
    // declarables flatten and references become markers.
    const body: Record<string, unknown> = {};
    const pathParams: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined) continue;
      const walked = walkValue(value, entityNames, visitor);
      if (entry.nonBodyProps.includes(key)) {
        pathParams[key] = walked;
      } else {
        body[key] = walked;
      }
    }

    // Services: re-inject the fixed `type` discriminator the authoring
    // surface hides, and stamp the marker.
    if (isServiceEntityType(entityType)) {
      body.type = SERVICE_TYPE_OF[entityType];
    }
    if (entry.marked) {
      body.envVars = stampOwnership(body.envVars, ownershipEnv);
    }

    // Owner: fill from the pseudo-parameter when omitted; the walked value
    // of `Render.OwnerId` is a `{ Ref }` resolved below with the rest.
    if (entry.ownerScoped && body.ownerId === undefined) {
      body.ownerId = { Ref: "Render::OwnerId" };
    }
    // `image.ownerId` must match the service's; default it the same way.
    if (isServiceEntityType(entityType) && body.image && typeof body.image === "object") {
      const image = body.image as Record<string, unknown>;
      if (image.ownerId === undefined) image.ownerId = body.ownerId;
    }

    // Child collections: fill the endpoint placeholder from pathParams when
    // the value is a literal id; a `{ $ref }` stays for the applier.
    let endpoint = entry.collection;
    for (const [key, value] of Object.entries(pathParams)) {
      if (typeof value === "string") endpoint = endpoint.replace(`{${key}}`, encodeURIComponent(value));
    }

    const request: RenderRequest = {
      kind: entry.kind,
      entityType,
      endpoint,
      method: "POST",
      name: resourceName(props, entityName),
      body,
    };
    if (Object.keys(pathParams).length > 0) request.pathParams = pathParams;
    requests[entityName] = request;
  }

  // Resolve pseudo-parameter markers (Render.OwnerId, Render.Region) to their
  // environment value so bodies carry plain strings, not `{ Ref }`.
  return JSON.stringify(resolvePseudoParameters(requests), null, 2);
}

/**
 * Render serializer.
 */
export const renderSerializer: Serializer = {
  name: "render",
  rulePrefix: "REN",
  serialize: serializeRender,
};
