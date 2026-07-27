/**
 * fly (Machines API / "flaps") serializer.
 *
 * Turns declared `App`, `Machine`, `Volume`, `IPAddress`, `Certificate`, and
 * `Secret` resources into the JSON create bodies the flaps REST API accepts, so
 * #739's applier can POST them straight through and mudflaps (#740) can
 * round-trip them.
 *
 * Output shape — a JSON object keyed by entity name. Each value is a single
 * flaps request:
 *
 *   {
 *     "<entityName>": {
 *       "endpoint": "/v1/apps",                       // or /v1/apps/{app}/machines
 *       "method": "POST",
 *       "body": { ... }                               // the create body
 *     }
 *   }
 *
 * Field names are taken from mudflaps' Go structs (the wire oracle), which win
 * over the OpenAPI-generated TypeScript names:
 *   - App    → CreateAppRequest    `{ app_name, org_slug? }` (NOT `name`).
 *   - Machine→ CreateMachineRequest `{ name?, region?, config?, skip_launch? }`;
 *     `config` is the full MachineConfig. The owning app is a URL path segment,
 *     not a body field, so it lands in `endpoint`.
 *
 * D2: every serialized Machine carries the `managed-by: chant` ownership marker
 * (plus the stack/env identity from `context.ownership`) merged into
 * `config.metadata`, even when the user supplied no metadata.
 */

import type { Declarable } from "@intentius/chant/declarable";
import { isPropertyDeclarable, isResourceDeclarable } from "@intentius/chant/declarable";
import type { Serializer, SerializeContext } from "@intentius/chant/serializer";
import type { LexiconOutput } from "@intentius/chant/lexicon-output";
import { ownershipEntries, OWNERSHIP_MANAGED_BY_VALUE } from "@intentius/chant/ownership";
import { walkValue, type SerializerVisitor } from "@intentius/chant/serializer-walker";
import { INTRINSIC_MARKER } from "@intentius/chant/intrinsic";
import { FLY_METADATA_OWNERSHIP_KEYS } from "./ownership";

const APP_ENTITY_TYPE = "Fly::Machines::App";
const MACHINE_ENTITY_TYPE = "Fly::Machines::Machine";
const VOLUME_ENTITY_TYPE = "Fly::Machines::Volume";
const IP_ENTITY_TYPE = "Fly::Machines::IPAddress";
const CERTIFICATE_ENTITY_TYPE = "Fly::Machines::Certificate";
const SECRET_ENTITY_TYPE = "Fly::Machines::Secret";

/** A single flaps REST call the applier can issue verbatim. */
interface FlapsRequest {
  endpoint: string;
  method: "POST";
  body: Record<string, unknown>;
  /**
   * D7: apply-only resources (Secrets) are set through POST but never read back
   * for a diff — flaps returns only a digest, never the value. The applier
   * honors this flag by skipping the drift/diff read and always POSTing.
   */
  applyOnly?: boolean;
}

/**
 * Visitor for the generic serializer walker. Property declarables (MachineConfig,
 * MachineGuest, MachineService, ...) are unwrapped to plain objects; resource
 * references resolve to their logical name.
 */
function flyVisitor(): SerializerVisitor {
  return {
    attrRef: (name) => name,
    resourceRef: (name) => name,
    propertyDeclarable: (entity, walk) => {
      const props = isResourceDeclarable(entity) ? entity.props : undefined;
      if (!props || typeof props !== "object") return undefined;
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(props)) {
        if (value !== undefined) result[key] = walk(value);
      }
      return Object.keys(result).length > 0 ? result : undefined;
    },
  };
}

function readProps(entity: Declarable): Record<string, unknown> {
  const props = isResourceDeclarable(entity) ? entity.props : undefined;
  return props && typeof props === "object" ? (props as Record<string, unknown>) : {};
}

/**
 * Pseudo-parameter → environment variable mapping. flaps create bodies are
 * plain JSON, so `Fly.Region` / `Fly.OrgSlug` / `Fly.AppName` (which the walker
 * lowers to a `{ Ref: "Fly::..." }` marker) are resolved from the environment
 * at build time, mirroring gcp's PSEUDO_ENV_MAP. The first set env var wins;
 * absent all of them, the fallback keeps output valid offline (mudflaps).
 */
const PSEUDO_ENV_MAP: Record<string, { envVars: string[]; fallback: string }> = {
  "Fly::Region": { envVars: ["FLY_REGION"], fallback: "iad" },
  "Fly::OrgSlug": { envVars: ["FLY_ORG", "FLY_ORG_SLUG"], fallback: "personal" },
  "Fly::AppName": { envVars: ["FLY_APP_NAME"], fallback: "app" },
};

function resolvePseudoRef(ref: string): string | undefined {
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
 * Handles both a raw `PseudoParameter` instance (any intrinsic carrying the
 * marker, unwrapped via `toJSON()`) and the already-walked `{ Ref: "Fly::X" }`
 * shape. Non-Fly `{ Ref }` shapes and every other value pass through untouched.
 */
function resolvePseudoParameters(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(resolvePseudoParameters);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;

    // Unwrap an intrinsic (e.g. a PseudoParameter assigned without walking) to
    // the { Ref } envelope it serializes to, then resolve that.
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

/** The app_name flaps expects: an explicit `name` prop, else the entity name. */
function appName(entity: Declarable, entityName: string): string {
  const name = readProps(entity).name;
  return typeof name === "string" ? name : entityName;
}

/**
 * fly flaps serializer.
 */
export const flySerializer: Serializer = {
  name: "fly",
  rulePrefix: "FLY",

  serialize(
    entities: Map<string, Declarable>,
    _outputs?: LexiconOutput[],
    context?: SerializeContext,
  ): string {
    const entityNames = new Map<Declarable, string>();
    for (const [name, entity] of entities) entityNames.set(entity, name);
    const visitor = flyVisitor();

    // D2 ownership marker. `managed-by: chant` is always stamped; stack/env are
    // added when the build threads an ownership marker through the context.
    const ownershipMeta: Record<string, string> = context?.ownership
      ? ownershipEntries(FLY_METADATA_OWNERSHIP_KEYS, context.ownership)
      : { [FLY_METADATA_OWNERSHIP_KEYS.managedBy]: OWNERSHIP_MANAGED_BY_VALUE };

    // Resolve which app a machine belongs to (a URL path segment, not a body
    // field). A machine may name its app explicitly via an `app` prop (a string
    // or an `App` reference); otherwise, when the stack declares exactly one
    // app, machines default to it. Failing both, a `{app}` placeholder is left
    // for the applier to fill.
    const apps: Array<[string, Declarable]> = [];
    for (const [name, entity] of entities) {
      if ((entity as unknown as { entityType?: string }).entityType === APP_ENTITY_TYPE) {
        apps.push([name, entity]);
      }
    }
    const soleApp = apps.length === 1 ? appName(apps[0][1], apps[0][0]) : undefined;

    // The owning app of any app-scoped resource (machine, volume, ip, cert,
    // secret): an explicit `app` prop (string or `App` reference), else the
    // stack's sole app, else a `{app}` placeholder for the applier to fill.
    const resolveOwningApp = (entity: Declarable): string => {
      const app = readProps(entity).app;
      if (typeof app === "string") return app;
      if (app && typeof app === "object" && "entityType" in app) {
        const decl = app as Declarable;
        return appName(decl, entityNames.get(decl) ?? "{app}");
      }
      return soleApp ?? "{app}";
    };

    const requests: Record<string, FlapsRequest> = {};

    for (const [name, entity] of entities) {
      if (isPropertyDeclarable(entity)) continue;
      const entityType = (entity as unknown as { entityType?: string }).entityType;
      const props = readProps(entity);

      if (entityType === APP_ENTITY_TYPE) {
        const body: Record<string, unknown> = { app_name: appName(entity, name) };
        if (props.org_slug !== undefined) body.org_slug = props.org_slug;
        if (props.network !== undefined) body.network = props.network;
        if (props.enable_subdomains !== undefined) body.enable_subdomains = props.enable_subdomains;
        requests[name] = { endpoint: "/v1/apps", method: "POST", body };
        continue;
      }

      if (entityType === MACHINE_ENTITY_TYPE) {
        const walkedConfig = props.config
          ? walkValue(props.config, entityNames, visitor)
          : undefined;
        const config: Record<string, unknown> =
          walkedConfig && typeof walkedConfig === "object"
            ? { ...(walkedConfig as Record<string, unknown>) }
            : {};

        // Merge the ownership marker into config.metadata. The marker wins over
        // any colliding user key so ownership can never be silently unset.
        const userMeta =
          config.metadata && typeof config.metadata === "object"
            ? (config.metadata as Record<string, unknown>)
            : {};
        config.metadata = { ...userMeta, ...ownershipMeta };

        // Spread the create-body fields (name, region, skip_launch, ...) and
        // override with the walked config. `app` is our association hint, not a
        // flaps field, so it is dropped.
        const body: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(props)) {
          if (key === "config" || key === "app" || value === undefined) continue;
          body[key] = walkValue(value, entityNames, visitor);
        }
        body.config = config;

        requests[name] = {
          endpoint: `/v1/apps/${resolveOwningApp(entity)}/machines`,
          method: "POST",
          body,
        };
        continue;
      }

      // ── App-scoped, metadata-less resources (#741, D2). ──────────────────
      // Each spreads its scalar create-body props straight through; the `app`
      // association hint is a URL segment, not a body field, so it is dropped.
      // Ownership is at the app boundary, so none carry a metadata marker.
      if (
        entityType === VOLUME_ENTITY_TYPE ||
        entityType === IP_ENTITY_TYPE ||
        entityType === CERTIFICATE_ENTITY_TYPE ||
        entityType === SECRET_ENTITY_TYPE
      ) {
        const app = resolveOwningApp(entity);

        if (entityType === SECRET_ENTITY_TYPE) {
          // Apply-only (D7): name is the URL segment; `value` is the only body
          // field. mudflaps returns just a digest, so this never enters a diff.
          const secretName = typeof props.name === "string" ? props.name : name;
          requests[name] = {
            endpoint: `/v1/apps/${app}/secrets/${encodeURIComponent(secretName)}`,
            method: "POST",
            body: props.value !== undefined ? { value: props.value } : {},
            applyOnly: true,
          };
          continue;
        }

        const segment =
          entityType === VOLUME_ENTITY_TYPE
            ? "volumes"
            : entityType === IP_ENTITY_TYPE
              ? "ip_assignments"
              : "certificates";
        const body: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(props)) {
          if (key === "app" || value === undefined) continue;
          body[key] = walkValue(value, entityNames, visitor);
        }
        requests[name] = { endpoint: `/v1/apps/${app}/${segment}`, method: "POST", body };
        continue;
      }
    }

    // Resolve pseudo-parameter markers (Fly.Region, Fly.OrgSlug, ...) to their
    // environment value so create bodies carry plain strings, not `{ Ref }`.
    return JSON.stringify(resolvePseudoParameters(requests), null, 2);
  },
};
