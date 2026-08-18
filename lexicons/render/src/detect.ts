/**
 * Template detection for the render lexicon.
 *
 * `chant import` parses a template file as JSON and asks each installed lexicon
 * whether it recognizes the shape. render's importable source is the serializer
 * plan (what `chant build` emits and `renderApply` POSTs): an object keyed by
 * entity name whose values carry a `Render::…` entityType and a `POST` request.
 */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A single request as the serializer emits it. */
function isRenderRequest(v: unknown): boolean {
  if (!isRecord(v)) return false;
  return typeof v.entityType === "string" && v.entityType.startsWith("Render::") && typeof v.endpoint === "string" && "body" in v;
}

/** The serializer's whole output: entity name → request. */
export function isSerializerPlan(v: unknown): boolean {
  if (!isRecord(v)) return false;
  const values = Object.values(v);
  return values.length > 0 && values.every(isRenderRequest);
}

export function detectTemplate(data: unknown): boolean {
  return isSerializerPlan(data);
}
