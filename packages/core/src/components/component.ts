/**
 * Typed `Component` authoring form — Phase 2 (#560, epic #551).
 *
 * This is the real authoring frontend the docs (component-contract.mdx,
 * composition-and-wiring.mdx) describe and that `pilots/authoring-shape.ts`
 * (#555's stopgap) explicitly deferred to this issue. It mirrors
 * `component.schema.json` field-for-field, so `projectToJson` stays a
 * structural no-op — the interesting content lives in each component's
 * composition, not in a bespoke serializer.
 *
 * See https://intentius.io/chant/components/component-contract/ and
 * https://intentius.io/chant/components/composition-and-wiring/.
 */

/** Mirrors `$defs.Archetype` in component.schema.json. */
export type Archetype = "service" | "infra" | "producer-library";

/** Mirrors `$defs.StackOutputReference`. */
export interface StackOutputReference {
  stackOutput: { stack: string; name: string };
}

/**
 * Mirrors `$defs.WiringValue` — a literal, or one of the reference forms
 * (`$env.*`, `@Phase.field`, `@<component>.publish.uri|digest|key`, or a
 * `{ stackOutput }` object), all resolved by the graph rather than by
 * orchestrator code. Loosened to `string` for the literal/`$env`/prior-step/
 * artifact-reference forms since they share one representation; only
 * `stackOutput` needs its own shape.
 */
export type Wiring = string | StackOutputReference;

/** Mirrors `$defs.BuildSpec`. */
export interface BuildSpec {
  /** Build capability verb, keyed by artifact type, e.g. "docker-build", "zip-package", "jvm-build". */
  kind: string;
  /** Build context path (e.g. a Docker build context directory). */
  context?: string;
  /** Build output always lands in the self-contained BuildArchive. */
  into?: "archive";
  /**
   * Optional component-level SBOM authoring hint (#606, epic #551 follow-up
   * to #564/#568) — not itself a `generate-sbom` step (that is composed
   * explicitly in `deploy`/build tooling, see
   * ../verbs/sbom.ts's `GenerateSbomInput`); this is metadata an authoring
   * frontend or generator can read when deciding whether/how to compose
   * that step for this component. Rides `BuildSpec`'s existing
   * `additionalProperties: true` in component.schema.json — no schema change
   * needed for this extension.
   */
  sbom?: {
    /** Preferred SBOM format for this component, overriding `chant.config.ts`'s project-wide `sbom.format` default (see ../../config.ts's `resolveSbomFormat`). */
    format?: "spdx" | "cyclonedx";
    /** Set true to skip SBOM generation for this component even where a project default would otherwise include it. `generate-sbom` is never invoked implicitly — this only documents intent for whatever composes the component's build phase. */
    optOut?: boolean;
  };
  [extra: string]: unknown;
}

/**
 * Mirrors `$defs.Step` — one capability invocation, the leaf unit of a
 * composition. `kind` selects the capability (a verb, e.g. "cfn-deploy",
 * "publish-image", "ecs-update-service"); the remaining properties are that
 * capability's typed input. `kind: "gate"` is reserved for `Gate` below, not
 * a capability — use `gate()` to author one.
 */
export interface Step {
  kind: string;
  /** Reference to a published image digest, typically `"@Publish.digest"`. */
  imageRef?: Wiring;
  /** Reference to a published JAR/artifact location, e.g. `"@jar-lib.publish.uri"`. */
  jar?: Wiring;
  /** Reference to a published revision/bundle location for host/code-delivery capabilities. */
  revision?: Wiring;
  /** Named inputs passed into an apply step; each may be a literal or any wiring reference. */
  inputs?: Record<string, Wiring>;
  [param: string]: unknown;
}

/** Mirrors `$defs.Gate` — pauses the composition for an external signal (typically human approval). */
export interface Gate {
  kind: "gate";
  signalName: string;
  /** Duration string bounding the wait, e.g. "48h". Default: "48h". */
  timeout?: string;
  /** Human-readable description of the action required to unblock this gate. */
  description?: string;
}

/**
 * Mirrors `$defs.Phase` — one named phase of a deploy composition. A step may
 * itself be a nested `Phase`, which is how a fan-out unit becomes a mini-
 * composition (see composition-and-wiring.mdx).
 */
export interface Phase {
  phase: string;
  steps: Array<Step | Gate | Phase>;
  /** Run all steps in this phase concurrently instead of sequentially. */
  parallel?: boolean;
  /** Compensation phases for this phase, executed in reverse order on failure. */
  onFailure?: Phase[];
}

/**
 * The typed `Component` authoring form — projects 1:1 to the JSON contract
 * (component.schema.json). `archetype` is optional on both sides: when
 * omitted here, `projectToJson` infers it structurally (see
 * `inferArchetype`) so the JSON projection always carries an explicit value,
 * matching how the merged fixtures are authored.
 */
export interface Component {
  name: string;
  /** Optional explicit archetype hint; inferred from the composition shape when omitted (see `inferArchetype`). */
  archetype?: Archetype;
  /** Other component names that must complete before this one runs. Ordering only — no logic. */
  dependsOn: string[];
  /**
   * Whether this component participates in a `chant run all --components` run
   * (chant #1522). A seam-gated component — kubemicrovm-ops' golden-image,
   * which only exists when `goldenImageMode=provision`; its local-substrate,
   * which declares nothing on the real target — computes this from `params.*`
   * at discovery, so "all" deploys the estate the parameters actually
   * describe instead of failing on a unit the seams turned off. Default true.
   * Running a disabled component BY NAME still errors, with the reason —
   * an explicit ask for a thing the parameters excluded is a mistake to
   * surface, not to skip.
   */
  enabled?: boolean;
  /** Optional: source -> BuildArchive. Omitted entirely for config-only / infra components. */
  build?: BuildSpec;
  /** The component's own composition over shared capabilities. */
  deploy: Phase[];
  /** Optional standalone verify phases, for components that separate verification from `deploy`. */
  verify?: Phase[];
  /** Optional explicit compensation phases, executed in reverse order on terminal failure of `deploy`. */
  rollback?: Phase[];
  /**
   * Optional: the live lexicon entity/resource name(s) this component owns,
   * when they differ from `name` (#598). `chant components status --live`
   * joins the release ledger against live evidence by name; components and
   * lexicon entities are different namespaces in general (see
   * `../lifecycle/status.ts`), so a component whose deploy composition
   * targets an entity/resource declared under a different name must say so
   * explicitly here. A component that owns several entities (e.g. a fan-out
   * cluster with one stack per node) may list them all — live evidence is
   * aggregated across every name. Omitted entirely (the common case for the
   * pilot components) falls back to `[name]`, preserving the original
   * name == entity join with no behavior change.
   */
  liveNames?: string[];
  /**
   * Optional: the composite kind name(s) this component's deployed resources
   * come from, when a consumer joining a composite graph to the component DAG
   * cannot infer it from `name` (#1492). Components and composites are
   * different namespaces, the same class of mismatch `liveNames` covers for
   * components and lexicon entities: a consumer without this field guesses by
   * kebab-casing each composite's kind and matching it against this
   * component's `name` (`LoomBackend` -> `loom-backend`), which only holds
   * when a component maps 1:1 to a composite named for it. A component built
   * from several composites (e.g. one stack containing both an ArtifactBucket
   * and an OperatorRole composite, plus loose resources) lists them all.
   * Omitted entirely (the common case), the naming convention stays the
   * default and nothing changes.
   */
  composites?: string[];
}

/** Author a named phase. `steps` may mix capability `Step`s, `Gate`s, and nested `Phase`s (fan-out). */
export function phase(name: string, steps: Array<Step | Gate | Phase>, opts?: { parallel?: boolean }): Phase {
  return { phase: name, steps, ...(opts?.parallel ? { parallel: true } : {}) };
}

/** Author a gate step — pauses the composition for an external signal (typically human approval). */
export function gate(signalName: string, opts?: { timeout?: string; description?: string }): Gate {
  return { kind: "gate", signalName, ...opts };
}

/**
 * Author a cross-stack output reference — the TypeScript-side equivalent of
 * the JSON contract's `{ stackOutput: { stack, name } }` (schema
 * `StackOutputReference`), e.g. `stackOutput("shared-alb", "ListenerArn")`.
 * Resolved by `chant graph --stacks`, never by orchestrator code.
 */
export function stackOutput(stack: string, name: string): StackOutputReference {
  return { stackOutput: { stack, name } };
}

/**
 * Every capability-family marker `inferArchetype` looks for, grouped the same
 * way component-contract.mdx's archetype table groups phases. Kept as a plain
 * list (not the full starter verb set) so this module has no dependency on
 * `./registry`/`./verbs` — inference is a structural, name-based heuristic
 * over the composition, not a capability-registry lookup.
 */
const BUILD_ONLY_HINT = new Set(["docker-build", "zip-package", "jvm-build"]);
const PUBLISH_KIND_PREFIX = /^(publish-|load-image-on-host)/;

/** True if a step's `kind` looks like a publish-family capability (`publish-image`, `publish-artifact`, `load-image-on-host`, ...). */
function isPublishStep(step: Step): boolean {
  return PUBLISH_KIND_PREFIX.test(step.kind);
}

/**
 * Distinguishes a nested fan-out `Phase` from a `Step`/`Gate` within a
 * phase's `steps` array. `Step` carries an open index signature
 * (`[param: string]: unknown`), so a plain `"phase" in s` structural check
 * cannot narrow `Step` away from `Phase` — checking the concrete field types
 * (`phase` is a string, `steps` is an array) here is what actually
 * disambiguates them.
 */
function isNestedPhase(s: Step | Gate | Phase): s is Phase {
  return typeof (s as Phase).phase === "string" && Array.isArray((s as Phase).steps);
}

/** Flatten every step across every phase (including nested fan-out phases) into one list, for structural inspection. */
function allSteps(phases: Phase[]): Array<Step | Gate> {
  const out: Array<Step | Gate> = [];
  const walk = (ps: Phase[]) => {
    for (const p of ps) {
      for (const s of p.steps) {
        if (isNestedPhase(s)) walk([s]);
        else out.push(s);
      }
      if (p.onFailure) walk(p.onFailure);
    }
  };
  walk(phases);
  return out;
}

/**
 * Infer a component's archetype from the shape of its composition, when no
 * explicit `archetype` is authored — matching the archetype table in
 * component-contract.mdx:
 *  - **producer-library**: has a `build`, and every step across `deploy` is a
 *    publish-family step (or a gate) — build -> publish only, no apply.
 *  - **service**: has a `build` and at least one non-publish, non-gate step
 *    (an apply/verify step) — build -> publish -> apply -> verify.
 *  - **infra**: no `build` — apply -> verify only.
 *
 * This is a structural heuristic, not a capability-registry lookup (see
 * `BUILD_ONLY_HINT`/`isPublishStep` above): it only needs to distinguish
 * "nothing but publish" from "something else happens after publish", which
 * every merged pilot/fixture satisfies without consulting the registry.
 */
export function inferArchetype(component: Pick<Component, "build" | "deploy">): Archetype {
  if (!component.build) return "infra";

  const steps = allSteps(component.deploy);
  const nonGateSteps = steps.filter((s): s is Step => s.kind !== "gate");
  const hasNonPublishStep = nonGateSteps.some((s) => !isPublishStep(s));

  return hasNonPublishStep ? "service" : "producer-library";
}

/**
 * Project a typed `Component` to its plain-JSON contract form
 * (component.schema.json). Field names already match the schema 1:1, so
 * projection is mechanical: a deep `JSON.parse(JSON.stringify())` round-trip
 * (dropping `undefined` optional fields) plus filling in `archetype` via
 * `inferArchetype` when the author didn't supply one explicitly. Kept
 * intentionally dumb beyond that inference — the schema/fixtures stay the
 * source of truth for shape, not this function.
 */
export function projectToJson(component: Component): unknown {
  const withArchetype: Component = {
    ...component,
    archetype: component.archetype ?? inferArchetype(component),
  };
  return JSON.parse(JSON.stringify(withArchetype));
}

/** Runtime type guard: true if `value` looks like a `Component` (has the required `name`/`dependsOn`/`deploy` shape). Used by discovery to pick exported `Component` values out of a `*.component.ts` module without requiring a class/marker symbol. */
export function isComponent(value: unknown): value is Component {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === "string" &&
    Array.isArray(v.dependsOn) &&
    Array.isArray(v.deploy)
  );
}
