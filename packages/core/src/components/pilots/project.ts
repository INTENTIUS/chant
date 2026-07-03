/**
 * Re-exports the real `projectToJson` (#560, ../component.ts) under the
 * pilots' original import path. Prior to #560, this module held its own
 * "intentionally dumb" projection over the stopgap `authoring-shape.ts`
 * (#555); now that the real typed `Component` authoring form exists, its
 * `projectToJson` (which also fills in `archetype` via `inferArchetype` when
 * a pilot doesn't set one explicitly) is the single implementation. Kept as a
 * re-export, rather than inlining `../component`'s import into every pilot
 * test, so `./pilots.test.ts`/`./pilots-e2e.test.ts`/`../driver.test.ts`
 * don't need their import paths touched by this migration.
 */

export { projectToJson } from "../component";
