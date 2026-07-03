/**
 * COMP007: composition-sprawl
 *
 * Flags two or more components whose `deploy` composition is structurally
 * identical (same phases, same `parallel`/nesting shape, same step kinds in
 * the same order) — the "composition copy-paste (declaration sprawl)"
 * failure mode from epic #551 §"Failure modes ... + guardrails": "Guard:
 * presets (Level 2) + a lint hint when an identical composition repeats
 * across components." This is a *hint*, not a hard error (severity:
 * "warning") — the epic frames it as "reach for a preset"
 * (docs/components/capabilities.mdx#presets--reuse-without-a-closed-set),
 * not a correctness defect.
 *
 * The fingerprint (../comp/support.ts's `compositionFingerprint`) compares
 * phase names, `parallel` flags, nesting, and step *kinds* only — never
 * `name`/`dependsOn`/literal wiring values/params, so two components that
 * both do "build -> publish -> apply -> verify" with the same capability
 * kinds but different templates/clusters/images still match (that is exactly
 * the "own destiny is in the params, not the shape" case a preset should
 * absorb).
 *
 * Triggers on: three components (arbitrary example) that all compose
 * `docker-build` -> `publish-image` -> `cfn-deploy` + `ecs-update-service` ->
 * `wait-steady-state` + `health-gate` with no meaningful structural
 * difference.
 * OK: components whose phase/step-kind shape differs (a different archetype,
 * a different apply family, fan-out vs. no fan-out, etc.) — like the four
 * real pilots, which were deliberately chosen to be structurally distinct
 * (see ../../../components/SPRAWL-VALIDATION.md).
 */

import type { ComponentCheck, ComponentCheckContext, ComponentCheckDiagnostic } from "../../component-checks";
import { compositionFingerprint } from "./support";

export const comp007CompositionSprawlRule: ComponentCheck = {
  id: "COMP007",
  severity: "warning",
  category: "style",
  description: "An identical composition shape is repeated across components — a declaration-sprawl hint to reach for a preset",
  check(ctx: ComponentCheckContext): ComponentCheckDiagnostic[] {
    const diagnostics: ComponentCheckDiagnostic[] = [];

    const byFingerprint = new Map<string, string[]>();
    for (const [name, { component }] of ctx.components) {
      const fp = compositionFingerprint(component);
      byFingerprint.set(fp, [...(byFingerprint.get(fp) ?? []), name]);
    }

    for (const names of byFingerprint.values()) {
      if (names.length < 2) continue;
      const sorted = [...names].sort();

      for (const name of sorted) {
        const others = sorted.filter((n) => n !== name);
        const { filePath } = ctx.components.get(name)!;
        diagnostics.push({
          checkId: "COMP007",
          severity: "warning",
          component: name,
          file: filePath,
          message:
            `Component "${name}" composes an identical phase/step shape to ${others.map((n) => `"${n}"`).join(", ")} ` +
            `— consider extracting a shared preset (docs/components/capabilities.mdx#presets) instead of repeating ` +
            `the composition per component.`,
        });
      }
    }

    return diagnostics;
  },
};
