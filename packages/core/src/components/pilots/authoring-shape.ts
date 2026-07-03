/**
 * Illustrative TypeScript authoring shape for the three pilots (#555).
 *
 * There is no typed `Component`/`phase()` authoring frontend yet — that is
 * Phase 2 of epic #551 (#560, "Typed Component declaration + discovery"). The
 * docs (component-contract.mdx, composition-and-wiring.mdx) already show what
 * that frontend will look like, so this module mirrors it just enough to let
 * each pilot be authored as typed TypeScript today and mechanically project
 * to the JSON contract, without inventing or committing to real authoring
 * API surface ahead of #560.
 *
 * Field names/shape intentionally match `component.schema.json` 1:1 so
 * `projectToJson` is a structural no-op (see ./project.ts) — the interesting
 * content lives in each pilot's composition, not in a bespoke serializer.
 */

/** Mirrors `$defs.Archetype` in component.schema.json. */
export type Archetype = "service" | "infra" | "producer-library";

/** Mirrors `$defs.WiringValue` in component.schema.json (the literal-or-reference union, loosened to `string` for authoring ergonomics). */
export type Wiring = string | { stackOutput: { stack: string; name: string } };

/** Mirrors `$defs.BuildSpec`. */
export interface BuildSpec {
  kind: string;
  context?: string;
  into?: "archive";
  [extra: string]: unknown;
}

/** Mirrors `$defs.Step` — one capability invocation, keyed by its `kind` verb. */
export interface Step {
  kind: string;
  imageRef?: Wiring;
  jar?: Wiring;
  revision?: Wiring;
  inputs?: Record<string, Wiring>;
  [param: string]: unknown;
}

/** Mirrors `$defs.Gate`. */
export interface Gate {
  kind: "gate";
  signalName: string;
  timeout?: string;
  description?: string;
}

/** Mirrors `$defs.Phase` — a nested `Phase` is how a fan-out unit becomes a mini-composition. */
export interface Phase {
  phase: string;
  steps: Array<Step | Gate | Phase>;
  parallel?: boolean;
  onFailure?: Phase[];
}

/** Mirrors the top-level Component document. */
export interface Component {
  name: string;
  archetype?: Archetype;
  dependsOn: string[];
  build?: BuildSpec;
  deploy: Phase[];
  verify?: Phase[];
  rollback?: Phase[];
}

/** Author a named phase — the illustrative counterpart of the future `phase()` builder described in composition-and-wiring.mdx. */
export function phase(name: string, steps: Array<Step | Gate | Phase>, opts?: { parallel?: boolean }): Phase {
  return { phase: name, steps, ...(opts?.parallel ? { parallel: true } : {}) };
}

/** Author a gate step — the illustrative counterpart of the future `gate()` builder. */
export function gate(signalName: string, opts?: { timeout?: string; description?: string }): Gate {
  return { kind: "gate", signalName, ...opts };
}
