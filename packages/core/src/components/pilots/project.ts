/**
 * Projects the illustrative TypeScript authoring form (./authoring-shape.ts)
 * to the portable JSON contract (component.schema.json).
 *
 * The authoring shape's field names already match the schema 1:1 (see the
 * comment in authoring-shape.ts), so projection is a `JSON.parse(JSON.stringify())`
 * round-trip that drops `undefined` optional fields — the same mechanical
 * relationship component-contract.mdx describes between the TypeScript
 * authoring form and the JSON substrate. A real Phase 2 authoring frontend
 * (#560) may compute derived fields (e.g. inferring `archetype`); this pilot
 * projection stays intentionally dumb so the JSON fixtures remain the single
 * source of truth for each pilot's shape.
 */

import type { Component } from "./authoring-shape";

/** Project a pilot's TypeScript `Component` to its plain-JSON contract form. */
export function projectToJson(component: Component): unknown {
  return JSON.parse(JSON.stringify(component));
}
