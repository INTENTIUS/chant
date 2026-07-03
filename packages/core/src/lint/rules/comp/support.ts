/**
 * Shared walking/wiring helpers for the COMP* composition rules (#562, epic
 * #551). Every COMP rule operates over the real, discovered `Component`
 * graph (see ../../component-checks.ts), not raw TypeScript source — these
 * helpers flatten a component's `deploy`/`rollback` phases into steps and
 * parse the wiring reference forms `../../../components/driver.ts` already
 * resolves at runtime, so lint can check the same references before
 * anything runs (per docs/components/orchestration.mdx).
 */

import type { Component, Gate, Phase, Step } from "../../../components/component";

/** True if a step/gate/nested-phase entry is a `Gate` (`kind: "gate"`). */
export function isGateEntry(entry: Step | Gate | Phase): entry is Gate {
  return (entry as { kind?: unknown }).kind === "gate";
}

/** True if a step/gate/nested-phase entry is itself a nested `Phase` (a fan-out unit) — see `component.ts`'s `isNestedPhase`. */
export function isPhaseEntry(entry: Step | Gate | Phase): entry is Phase {
  return typeof (entry as Phase).phase === "string" && Array.isArray((entry as Phase).steps);
}

/** True if a step/gate/nested-phase entry is a plain capability `Step` (neither a gate nor a nested phase). */
export function isStepEntry(entry: Step | Gate | Phase): entry is Step {
  return !isGateEntry(entry) && !isPhaseEntry(entry);
}

/** One step found while walking a component, together with the (possibly nested) phase it lives directly under. */
export interface WalkedStep {
  step: Step;
  phaseName: string;
  /**
   * The exact `Phase` object this step lives directly under — object
   * identity, not just `phaseName`, since two different nested fan-out
   * phases (or a nested phase and its parent) can share the same display
   * name. Rules that need "another step in this same phase" (e.g. COMP003's
   * compensation-sibling check) should group by this reference, not by name.
   */
  phase: Phase;
}

/** One gate found while walking a component, together with the phase it lives directly under. */
export interface WalkedGate {
  gate: Gate;
  phaseName: string;
  phase: Phase;
}

/**
 * Flatten every step and gate across a list of phases (including nested
 * fan-out phases and `onFailure` compensation phases), matching
 * `component.ts`'s own `allSteps` walk but keeping the immediate phase
 * alongside each entry (needed for `@Phase.field` reference checks and for
 * "same phase" sibling checks) and separating gates out explicitly.
 */
export function walkPhases(phases: Phase[] | undefined): { steps: WalkedStep[]; gates: WalkedGate[] } {
  const steps: WalkedStep[] = [];
  const gates: WalkedGate[] = [];

  const walk = (ps: Phase[]) => {
    for (const p of ps) {
      for (const entry of p.steps) {
        if (isPhaseEntry(entry)) {
          walk([entry]);
        } else if (isGateEntry(entry)) {
          gates.push({ gate: entry, phaseName: p.phase, phase: p });
        } else {
          steps.push({ step: entry, phaseName: p.phase, phase: p });
        }
      }
      if (p.onFailure) walk(p.onFailure);
    }
  };
  walk(phases ?? []);

  return { steps, gates };
}

/** Every step and gate across a component's `deploy` plus its top-level `rollback` phases. */
export function walkComponent(component: Component): { steps: WalkedStep[]; gates: WalkedGate[] } {
  const deployWalk = walkPhases(component.deploy);
  const rollbackWalk = walkPhases(component.rollback);
  return {
    steps: [...deployWalk.steps, ...rollbackWalk.steps],
    gates: [...deployWalk.gates, ...rollbackWalk.gates],
  };
}

/** Every distinct phase name declared directly in a component's `deploy` (top-level only, not nested fan-out phase names — those are addressed by the fan-out's own phase name, never the parent's). */
export function topLevelPhaseNames(component: Component): Set<string> {
  return new Set((component.deploy ?? []).map((p) => p.phase));
}

// ── Wiring reference parsing (mirrors ../../../components/driver.ts) ────────

/** `@Phase.field[...]` — a prior step's output within the same component, keyed by phase name. */
const PRIOR_STEP_REF = /^@([A-Za-z0-9_ ]+)\.([A-Za-z0-9_.]+)$/;
/** `@<component>.publish.uri|digest|key` — a cross-component artifact reference. */
const COMPONENT_ARTIFACT_REF = /^@([a-z0-9]+(?:-[a-z0-9]+)*)\.publish\.(uri|digest|key)$/;

export interface PriorStepRef {
  kind: "prior-step";
  phaseName: string;
  field: string;
}

export interface ComponentArtifactRef {
  kind: "component-artifact";
  componentName: string;
  field: "uri" | "digest" | "key";
}

export type WiringRef = PriorStepRef | ComponentArtifactRef;

/** Parse a single string value as one of the two name-bearing wiring reference forms (`@Phase.field`, `@component.publish.*`). Returns `undefined` for a plain literal, an `$env.*` reference, or a malformed `@` reference (schema validation, not lint, is responsible for rejecting malformed references). */
export function parseWiringRef(value: unknown): WiringRef | undefined {
  if (typeof value !== "string") return undefined;

  const artifactMatch = value.match(COMPONENT_ARTIFACT_REF);
  if (artifactMatch) {
    return { kind: "component-artifact", componentName: artifactMatch[1], field: artifactMatch[2] as "uri" | "digest" | "key" };
  }

  const priorStepMatch = value.match(PRIOR_STEP_REF);
  if (priorStepMatch) {
    return { kind: "prior-step", phaseName: priorStepMatch[1], field: priorStepMatch[2] };
  }

  return undefined;
}

/** Recursively collect every wiring-reference-shaped string found anywhere in a step's fields (imageRef, jar, revision, inputs, and any other open capability-specific property), matching how ../../../components/driver.ts's `resolveStepInput` walks a step's input. */
export function collectWiringRefs(step: Step): WiringRef[] {
  const refs: WiringRef[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      const ref = parseWiringRef(value);
      if (ref) refs.push(ref);
      return;
    }
    if (Array.isArray(value)) {
      for (const v of value) walk(v);
      return;
    }
    if (value && typeof value === "object") {
      // `{ stackOutput: { stack, name } }` is a cross-stack reference, resolved
      // by the graph, not a same-project component/phase reference — out of
      // scope for this reference check (see component-contract.mdx).
      if ("stackOutput" in value) return;
      for (const v of Object.values(value as Record<string, unknown>)) walk(v);
    }
  };
  const { kind: _kind, ...rest } = step;
  walk(rest);
  return refs;
}

/** A structural fingerprint of a component's composition shape, ignoring `name`/`dependsOn`/wiring literal values — two components with the same fingerprint compose the exact same phase/step-kind shape (see COMP007, "identical composition repeated across components"). */
export function compositionFingerprint(component: Component): string {
  const shape = (component.deploy ?? []).map((p) => fingerprintPhase(p));
  return JSON.stringify(shape);
}

function fingerprintPhase(phase: Phase): unknown {
  return {
    parallel: phase.parallel ?? false,
    steps: phase.steps.map((entry) => {
      if (isPhaseEntry(entry)) return fingerprintPhase(entry);
      if (isGateEntry(entry)) return { kind: "gate" };
      return { kind: entry.kind };
    }),
  };
}
