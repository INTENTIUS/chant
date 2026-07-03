/**
 * Presets reduce identical-composition duplication (#566's third acceptance
 * criterion, tied to the COMP007 copy-paste hint per epic #551's failure-mode
 * guardrail #3: "Composition copy-paste (declaration sprawl) ... Guard:
 * presets (Level 2) + a lint hint when an identical composition repeats
 * across components").
 *
 * This demonstrates the concrete before/after COMP007 exists for:
 *  - "before" — two components hand-authored with an identical phase/step-kind
 *    shape (the same scenario ../../lint/rules/comp/__fixtures__/comp007/fail/
 *    covers) trigger COMP007's declaration-sprawl warning, and require
 *    hand-copying the full phase/step composition a second time.
 *  - "after" — expressing both as two `EcsFargateComponent({...})` calls
 *    collapses each declaration to its own params (name/service/healthPath/
 *    stack), with the shared composition shape lifted into the preset once.
 *    COMP007 still fires on the *expanded* shape (its fingerprint is
 *    structural, over the projected composition, by design — see
 *    ../../lint/rules/comp/comp007-composition-sprawl.ts's docstring: "own
 *    destiny is in the params, not the shape" is exactly the case a preset
 *    should absorb) — the reduction is in what the *author* had to write and
 *    maintain, not in whether the lint hint still recognizes the shared shape.
 */

import { describe, expect, it } from "vitest";
import type { Component } from "../component";
import { phase } from "../component";
import { loadComponentChecks } from "../../lint/rules/comp/index";
import type { ComponentCheckContext, ComponentCheckEntry } from "../../lint/component-checks";
import { EcsFargateComponent } from "./ecs-fargate";

const checks = loadComponentChecks();

function contextFor(components: Component[]): ComponentCheckContext {
  const map = new Map<string, ComponentCheckEntry>();
  for (const component of components) {
    map.set(component.name, { component, filePath: `${component.name}.component.ts` });
  }
  return { components: map };
}

function comp007Diagnostics(components: Component[]) {
  const ctx = contextFor(components);
  return checks.flatMap((check) => check.check(ctx)).filter((d) => d.checkId === "COMP007");
}

describe("Presets reduce composition copy-paste (#566, tied to COMP007)", () => {
  it("before: two hand-authored components with an identical build->publish->apply->verify shape trigger COMP007", () => {
    // Two unrelated services, each requiring the full phase/step composition
    // to be hand-typed and kept in sync by hand — exactly the declaration
    // sprawl epic #551's failure mode #3 describes.
    const catalogService: Component = {
      name: "catalog-service",
      archetype: "service",
      dependsOn: ["shared-alb"],
      build: { kind: "docker-build", context: ".", into: "archive" },
      deploy: [
        phase("Publish", [{ kind: "publish-image", from: "archive", to: "$env.registry" }]),
        phase("Apply", [
          { kind: "cfn-deploy", template: "archive:catalog.template.json", imageRef: "@Publish.digest" },
          { kind: "ecs-update-service", cluster: "$env.cluster", service: "catalog" },
        ]),
        phase("Verify", [
          { kind: "wait-steady-state", service: "catalog" },
          { kind: "health-gate", path: "/healthz" },
        ]),
      ],
    };
    const billingService: Component = {
      name: "billing-service",
      archetype: "service",
      dependsOn: ["shared-alb"],
      build: { kind: "docker-build", context: ".", into: "archive" },
      deploy: [
        phase("Publish", [{ kind: "publish-image", from: "archive", to: "$env.registry" }]),
        phase("Apply", [
          { kind: "cfn-deploy", template: "archive:billing.template.json", imageRef: "@Publish.digest" },
          { kind: "ecs-update-service", cluster: "$env.cluster", service: "billing" },
        ]),
        phase("Verify", [
          { kind: "wait-steady-state", service: "billing" },
          { kind: "health-gate", path: "/healthz" },
        ]),
      ],
    };

    const diagnostics = comp007Diagnostics([catalogService, billingService]);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.map((d) => d.component).sort()).toEqual(["billing-service", "catalog-service"]);
    expect(diagnostics[0]!.message).toContain("consider extracting a shared preset");
  });

  it("after: the same two services expressed via EcsFargateComponent collapse to one line of params each, instead of a hand-copied phase/step composition", () => {
    const catalogService = EcsFargateComponent({
      name: "catalog-service",
      healthPath: "/healthz",
      sharedAlbStack: "shared-alb",
    });
    const billingService = EcsFargateComponent({
      name: "billing-service",
      healthPath: "/healthz",
      sharedAlbStack: "shared-alb",
    });

    // The two declarations are now just their own distinguishing params; the
    // shared composition shape is defined exactly once, in ./ecs-fargate.ts,
    // not copy-pasted per component. COMP007's fingerprint is structural
    // (over the *expanded* composition), so it still — correctly — reports
    // that these two share a shape; the point of the preset was never to
    // silence the lint hint, it was to make the shared shape a single
    // maintained definition instead of N hand-copied ones.
    const diagnostics = comp007Diagnostics([catalogService, billingService]);
    expect(diagnostics).toHaveLength(2);

    // The expanded contract is identical to the hand-authored "before" case
    // above (same phases, same step kinds/order) — the preset changed nothing
    // about the resulting composition, only how many times its shape had to
    // be typed out by hand (once, in the preset, instead of once per component).
    expect(catalogService.deploy.map((p) => ({ phase: p.phase, kinds: p.steps.map((s) => (s as { kind: string }).kind) }))).toEqual(
      billingService.deploy.map((p) => ({ phase: p.phase, kinds: p.steps.map((s) => (s as { kind: string }).kind) })),
    );
  });
});
