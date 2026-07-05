/**
 * COMP005: capability-kind-is-noun
 *
 * Flags a step `kind` that names a component rather than an operation — the
 * "capability-per-component (renamed sprawl)" failure mode from epic #551
 * §"Failure modes ... + guardrails": "Tell: capabilities named after nouns."
 * Every starter-set verb is a verb-phrase describing an operation
 * (`cfn-deploy`, `publish-image`, `wait-steady-state`, ...); a capability
 * named after *this* component (or any other discovered component) is
 * exactly the sprawl the capability model exists to remove — see
 * docs/components/capabilities.mdx#the-discipline ("A capability describes
 * an operation, never a component").
 *
 * Detection is structural, not NLP: a step `kind` is flagged when it equals,
 * or is built from, a discovered component's own kebab-case `name` (e.g. a
 * `search-service` component composing a `{ kind: "deploy-search-service" }`
 * or `{ kind: "search-service" }` step) — the concrete, checkable form of
 * "named after a component" the issue asks for, mirroring how
 * ../../../components/capability.ts's own docstring defines the discipline
 * ("never named after the component that happens to use it").
 *
 * Every registered `kind` is excluded from this check unconditionally,
 * regardless of whether its dash-separated segments happen to overlap a
 * component's name. The allowlist comes from `ctx.knownKinds` — the kinds the
 * project's capability registry actually resolves, which `chant lint` builds
 * from the project's config (core's starter set plus the active lexicons'
 * leaves, e.g. `cfn-deploy`/`wait-for-stack` when `lexicons: ["aws"]`). Without
 * this exclusion, a component literally named "stack", "job", "image", or
 * "host" would falsely flag `wait-for-stack`/`emr-start-job-run`/`publish-image`/
 * `load-image-on-host` — a real capability's verb-ness is an established fact of
 * the registry, not something to re-adjudicate by substring match. When no
 * registry was resolved (a direct unit test), it falls back to core's starter
 * set (`CORE_STARTER_KINDS`).
 *
 * Triggers on: `{ kind: "search-service" }` or `{ kind: "deploy-search-service" }`
 * in any component, when "search-service" is a discovered component's name and
 * neither form is a registered verb.
 * OK: `{ kind: "cfn-deploy" }`, `{ kind: "ecs-update-service" }`,
 * `{ kind: "wait-for-stack" }` — verb-named, and/or a registered verb.
 */

import { STARTER_VERB_FAMILIES } from "../../../components/starter-plugin";
import type { ComponentCheck, ComponentCheckContext, ComponentCheckDiagnostic } from "../../component-checks";
import { walkComponent } from "./support";

/**
 * Fallback allowlist when the check runs without a resolved registry (e.g. a
 * direct unit test): core's own starter verbs. The real `chant lint` run passes
 * `ctx.knownKinds` — every kind the project's registry actually resolves,
 * including the active lexicons' leaves (`cfn-deploy`, `wait-for-stack`, …) —
 * so a real project never depends on this fallback for its cloud verbs.
 */
const CORE_STARTER_KINDS: ReadonlySet<string> = new Set(Object.values(STARTER_VERB_FAMILIES).flat());

/** True if `kind` is exactly a component name, or that name embedded with `-`-joined affixes (e.g. "deploy-search-service", "search-service-apply"). */
function kindNamesComponent(kind: string, componentName: string): boolean {
  if (kind === componentName) return true;
  const parts = kind.split("-");
  const nameParts = componentName.split("-");
  if (nameParts.length === 0) return false;
  for (let i = 0; i + nameParts.length <= parts.length; i++) {
    if (nameParts.every((p, j) => parts[i + j] === p)) return true;
  }
  return false;
}

export const comp005CapabilityKindIsNounRule: ComponentCheck = {
  id: "COMP005",
  severity: "error",
  category: "style",
  description: "A capability kind is named after a component (a noun) rather than an operation (a verb)",
  check(ctx: ComponentCheckContext): ComponentCheckDiagnostic[] {
    const diagnostics: ComponentCheckDiagnostic[] = [];
    const componentNames = [...ctx.components.keys()];
    if (componentNames.length === 0) return diagnostics;

    // Every known verb — the project's registered kinds when `chant lint`
    // resolved a registry (includes active lexicons' leaves), else core's
    // starter set. A known verb is never a "noun named after the component",
    // regardless of any substring overlap with a component's name.
    const knownKinds = ctx.knownKinds ?? CORE_STARTER_KINDS;

    for (const [name, { component, filePath }] of ctx.components) {
      const { steps } = walkComponent(component);
      const reported = new Set<string>();

      for (const { step, phaseName } of steps) {
        if (step.kind === "gate") continue;
        if (knownKinds.has(step.kind)) continue;
        const matchedComponent = componentNames.find((cn) => kindNamesComponent(step.kind, cn));
        if (!matchedComponent) continue;

        const dedupeKey = `${step.kind}:${phaseName}`;
        if (reported.has(dedupeKey)) continue;
        reported.add(dedupeKey);

        diagnostics.push({
          checkId: "COMP005",
          severity: "error",
          component: name,
          file: filePath,
          message:
            `Component "${name}": step kind "${step.kind}" (phase "${phaseName}") is named after component ` +
            `"${matchedComponent}" rather than an operation. A capability kind must be a verb ("cfn-deploy", ` +
            `"publish-image", "wait-steady-state", ...), never a noun naming the component that uses it — see ` +
            `docs/components/capabilities.mdx#the-discipline.`,
        });
      }
    }

    return diagnostics;
  },
};
