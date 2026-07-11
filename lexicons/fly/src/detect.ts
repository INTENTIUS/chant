/**
 * Template detection for the fly lexicon.
 *
 * `chant import` parses a template file as JSON and asks each installed lexicon
 * whether it recognizes the shape. fly's importable source is flaps JSON — the
 * Machines API surface the #738 serializer emits and the applier POSTs. Three
 * shapes are recognized:
 *
 *   1. The serializer plan: an object keyed by entity name whose values are
 *      `{ endpoint, method, body }` flaps requests (what #738 produces).
 *   2. A machine, a machines listing, or an app-with-machines bundle: what
 *      `GET /v1/apps/{app}/machines` returns, or a single machine create body.
 *   3. An app: a create body (`{ app_name }`) or the `GET /v1/apps/{app}` shape.
 */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A single flaps request as the serializer emits it. */
function isFlapsRequest(v: unknown): boolean {
  if (!isRecord(v)) return false;
  return typeof v.endpoint === "string" && v.endpoint.startsWith("/v1/apps") && "body" in v;
}

/** The serializer's whole output: entity name → flaps request. */
export function isSerializerPlan(v: unknown): boolean {
  if (!isRecord(v)) return false;
  const values = Object.values(v);
  return values.length > 0 && values.every(isFlapsRequest);
}

/** A live or create-body machine: carries a `config` object, or the id+state+region GET shape. */
export function isMachineObject(v: unknown): boolean {
  if (!isRecord(v)) return false;
  if (isRecord(v.config)) return true;
  return typeof v.id === "string" && typeof v.state === "string" && "region" in v;
}

/** An app: a create body (`app_name`) or the `GET /v1/apps/{app}` shape (`name` + machine_count/organization/status). */
export function isAppObject(v: unknown): boolean {
  if (!isRecord(v)) return false;
  if (typeof v.app_name === "string") return true;
  return (
    typeof v.name === "string" &&
    ("machine_count" in v || "organization" in v || typeof v.status === "string")
  );
}

export function detectTemplate(data: unknown): boolean {
  if (isSerializerPlan(data)) return true;

  if (Array.isArray(data)) {
    return data.length > 0 && data.some(isMachineObject);
  }

  if (isRecord(data)) {
    if (Array.isArray(data.machines)) return true;
    if (isMachineObject(data)) return true;
    if (isAppObject(data)) return true;
  }

  return false;
}
