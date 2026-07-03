/**
 * `EcsFargateComponent` (#566): schema validity, and equivalence with the
 * hand-composed `alb-ecs.pilot.ts` reference component — the "preset-based
 * and hand-composed component produce equivalent contracts" acceptance
 * criterion from #566.
 */

import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020";
import componentSchema from "../component.schema.json";
import { projectToJson } from "../component";
import { searchService } from "../pilots/alb-ecs.pilot";
import { EcsFargateComponent } from "./ecs-fargate";

const ajv = new Ajv2020({ strict: true, allErrors: true });
const validate = ajv.compile(componentSchema);

describe("EcsFargateComponent preset", () => {
  it("expands to a component that projects to schema-valid JSON", () => {
    const component = EcsFargateComponent({
      name: "search-service",
      healthPath: "/healthz",
      sharedAlbStack: "shared-alb",
    });
    const projected = projectToJson(component);
    const valid = validate(projected);
    if (!valid) throw new Error(ajv.errorsText(validate.errors));
    expect(valid).toBe(true);
  });

  it("re-derives alb-ecs.pilot.ts's hand-composed searchService component byte-for-byte (as data)", () => {
    const fromPreset = EcsFargateComponent({
      name: "search-service",
      service: "search",
      // The pilot's template is derived from the service name ("search"), not
      // the component name ("search-service") this preset defaults from —
      // pass it explicitly to match the pre-existing hand-composed pilot exactly.
      template: "archive:search.template.json",
      healthPath: "/healthz",
      sharedAlbStack: "shared-alb",
    });

    // Same contract, whether authored via the preset or hand-composed from
    // raw capabilities — the preset is Level 2 convenience over the same
    // Level 1 primitives, never a different orchestrator behavior.
    expect(projectToJson(fromPreset)).toEqual(projectToJson(searchService));
  });

  it("supports dropping to a customized shape by spreading the preset's output — the 'starts from it and drops to raw capabilities where special' path #566 requires", () => {
    const base = EcsFargateComponent({
      name: "search-service-canary",
      healthPath: "/healthz",
      sharedAlbStack: "shared-alb",
    });

    // A component that is 90% the standard shape but needs one extra Verify
    // step (e.g. a canary-specific smoke test) starts from the preset and
    // edits the composition directly, rather than the preset needing a new
    // config knob for every possible variation.
    const customized = {
      ...base,
      deploy: base.deploy.map((p) =>
        p.phase === "Verify" ? { ...p, steps: [...p.steps, { kind: "shell", command: "./smoke-test.sh" }] } : p,
      ),
    };

    const projected = projectToJson(customized);
    const valid = validate(projected);
    if (!valid) throw new Error(ajv.errorsText(validate.errors));
    expect(valid).toBe(true);
    const verifyPhase = (projected as { deploy: Array<{ phase: string; steps: Array<{ kind: string }> }> }).deploy.find(
      (p) => p.phase === "Verify",
    )!;
    expect(verifyPhase.steps.map((s) => s.kind)).toEqual(["wait-steady-state", "health-gate", "shell"]);
  });

  it("omits shared-ALB cross-stack wiring and dependsOn when sharedAlbStack is not given", () => {
    const standalone = EcsFargateComponent({ name: "standalone-service", healthPath: "/healthz" });
    expect(standalone.dependsOn).toEqual([]);
    const applyPhase = standalone.deploy.find((p) => p.phase === "Apply")!;
    const cfnStep = applyPhase.steps[0] as { inputs?: unknown };
    expect(cfnStep.inputs).toBeUndefined();
  });
});
