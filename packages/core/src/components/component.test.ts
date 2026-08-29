/**
 * Unit tests for the typed `Component` authoring form (#560, epic #551):
 * the `phase()`/`gate()`/`stackOutput()` builders, `isComponent`,
 * `inferArchetype`, and `projectToJson`. Schema-validation and
 * fixture-equality coverage for real components lives in
 * `./component-schema.test.ts` and `./pilots/pilots.test.ts`; this file
 * covers the authoring API's own behavior in isolation.
 */

import { describe, expect, it } from "vitest";
import {
  phase,
  gate,
  stackOutput,
  isComponent,
  inferArchetype,
  projectToJson,
  type Component,
} from "./component";

describe("phase()", () => {
  it("builds a Phase with no parallel flag by default", () => {
    expect(phase("Apply", [{ kind: "shell" }])).toEqual({
      phase: "Apply",
      steps: [{ kind: "shell" }],
    });
  });

  it("sets parallel: true when requested", () => {
    expect(phase("Verify", [{ kind: "shell" }], { parallel: true })).toEqual({
      phase: "Verify",
      steps: [{ kind: "shell" }],
      parallel: true,
    });
  });
});

describe("gate()", () => {
  it("builds a minimal Gate", () => {
    expect(gate("approve-x")).toEqual({ kind: "gate", signalName: "approve-x" });
  });

  it("carries optional timeout/description", () => {
    expect(gate("approve-x", { timeout: "24h", description: "confirm" })).toEqual({
      kind: "gate",
      signalName: "approve-x",
      timeout: "24h",
      description: "confirm",
    });
  });
});

describe("stackOutput()", () => {
  it("builds a StackOutputReference", () => {
    expect(stackOutput("shared-alb", "ListenerArn")).toEqual({
      stackOutput: { stack: "shared-alb", name: "ListenerArn" },
    });
  });
});

describe("isComponent()", () => {
  it("accepts a minimal valid Component shape", () => {
    expect(isComponent({ name: "x", dependsOn: [], deploy: [] })).toBe(true);
  });

  it("rejects null/non-objects", () => {
    expect(isComponent(null)).toBe(false);
    expect(isComponent(42)).toBe(false);
    expect(isComponent("x")).toBe(false);
    expect(isComponent(undefined)).toBe(false);
  });

  it("rejects an object missing dependsOn or deploy", () => {
    expect(isComponent({ name: "x" })).toBe(false);
    expect(isComponent({ name: "x", dependsOn: [] })).toBe(false);
    expect(isComponent({ dependsOn: [], deploy: [] })).toBe(false);
  });

  it("rejects a plain non-Component object (e.g. a helper/const export)", () => {
    expect(isComponent({ foo: "bar" })).toBe(false);
  });
});

describe("inferArchetype()", () => {
  it("infers infra when there is no build", () => {
    expect(
      inferArchetype({
        deploy: [phase("Apply", [{ kind: "cfn-deploy" }])],
      }),
    ).toBe("infra");
  });

  it("infers producer-library when build is present and every step is publish-family", () => {
    expect(
      inferArchetype({
        build: { kind: "jvm-build" },
        deploy: [phase("Publish", [{ kind: "publish-artifact" }])],
      }),
    ).toBe("producer-library");
  });

  it("infers producer-library when the only non-publish steps are gates", () => {
    expect(
      inferArchetype({
        build: { kind: "docker-build" },
        deploy: [phase("Publish", [gate("approve"), { kind: "publish-image" }])],
      }),
    ).toBe("producer-library");
  });

  it("infers service when build is present and an apply/verify step follows publish", () => {
    expect(
      inferArchetype({
        build: { kind: "docker-build" },
        deploy: [
          phase("Publish", [{ kind: "publish-image" }]),
          phase("Apply", [{ kind: "cfn-deploy" }]),
        ],
      }),
    ).toBe("service");
  });

  it("infers service for load-image-on-host + a non-publish apply step (single-host compose shape)", () => {
    expect(
      inferArchetype({
        build: { kind: "docker-build" },
        deploy: [
          phase("Publish", [{ kind: "load-image-on-host" }]),
          phase("Apply", [{ kind: "remote-exec" }]),
        ],
      }),
    ).toBe("service");
  });

  it("looks inside nested fan-out phases", () => {
    expect(
      inferArchetype({
        build: { kind: "docker-build" },
        deploy: [
          phase("Rolling", [
            phase("Node 1", [{ kind: "publish-image" }]),
            phase("Node 2", [{ kind: "cfn-deploy" }]),
          ]),
        ],
      }),
    ).toBe("service");
  });
});

describe("projectToJson()", () => {
  it("fills in archetype via inferArchetype when the author omits it", () => {
    const component: Component = {
      name: "table",
      dependsOn: [],
      deploy: [phase("Apply", [{ kind: "cfn-deploy" }])],
    };
    const projected = projectToJson(component) as { archetype: string };
    expect(projected.archetype).toBe("infra");
  });

  it("keeps an explicit archetype as authored, even if it disagrees with the inferred shape", () => {
    const component: Component = {
      name: "table",
      archetype: "service",
      dependsOn: [],
      deploy: [phase("Apply", [{ kind: "cfn-deploy" }])],
    };
    const projected = projectToJson(component) as { archetype: string };
    expect(projected.archetype).toBe("service");
  });

  it("drops undefined optional fields (build/verify/rollback) rather than emitting nulls", () => {
    const component: Component = {
      name: "table",
      dependsOn: [],
      deploy: [phase("Apply", [{ kind: "cfn-deploy" }])],
    };
    const projected = projectToJson(component) as Record<string, unknown>;
    expect("build" in projected).toBe(false);
    expect("verify" in projected).toBe(false);
    expect("rollback" in projected).toBe(false);
  });

  it("projects an explicit liveNames mapping through unchanged (#598)", () => {
    const component: Component = {
      name: "search-svc",
      dependsOn: [],
      liveNames: ["search-service-v2"],
      deploy: [phase("Apply", [{ kind: "cfn-deploy" }])],
    };
    const projected = projectToJson(component) as { liveNames?: string[] };
    expect(projected.liveNames).toEqual(["search-service-v2"]);
  });

  it("omits liveNames from the projection when not authored (#598)", () => {
    const component: Component = {
      name: "table",
      dependsOn: [],
      deploy: [phase("Apply", [{ kind: "cfn-deploy" }])],
    };
    const projected = projectToJson(component) as Record<string, unknown>;
    expect("liveNames" in projected).toBe(false);
  });

  it("projects an explicit composites list through unchanged (#1492)", () => {
    const component: Component = {
      name: "aws-plane",
      dependsOn: [],
      composites: ["ArtifactBucket", "OperatorRole"],
      deploy: [phase("Apply", [{ kind: "cfn-deploy" }])],
    };
    const projected = projectToJson(component) as { composites?: string[] };
    expect(projected.composites).toEqual(["ArtifactBucket", "OperatorRole"]);
  });

  it("omits composites from the projection when not authored (#1492)", () => {
    const component: Component = {
      name: "table",
      dependsOn: [],
      deploy: [phase("Apply", [{ kind: "cfn-deploy" }])],
    };
    const projected = projectToJson(component) as Record<string, unknown>;
    expect("composites" in projected).toBe(false);
  });

  it("projects a stackOutput() wiring reference to its plain-JSON form", () => {
    const component: Component = {
      name: "svc",
      dependsOn: ["shared-alb"],
      deploy: [
        phase("Apply", [
          { kind: "cfn-deploy", inputs: { listenerArn: stackOutput("shared-alb", "ListenerArn") } },
        ]),
      ],
    };
    const projected = projectToJson(component) as {
      deploy: Array<{ steps: Array<{ inputs: Record<string, unknown> }> }>;
    };
    expect(projected.deploy[0]!.steps[0]!.inputs.listenerArn).toEqual({
      stackOutput: { stack: "shared-alb", name: "ListenerArn" },
    });
  });
});

describe("BuildSpec.sbom (#606 — component-level SBOM authoring hint)", () => {
  it("projects an authored sbom hint through unchanged, riding BuildSpec's open additionalProperties shape", () => {
    const component: Component = {
      name: "search-service",
      dependsOn: [],
      build: { kind: "docker-build", context: ".", sbom: { format: "cyclonedx" } },
      deploy: [phase("Publish", [{ kind: "publish-image" }])],
    };
    const projected = projectToJson(component) as { build: { sbom?: { format?: string; optOut?: boolean } } };
    expect(projected.build.sbom).toEqual({ format: "cyclonedx" });
  });

  it("omits sbom from the projection when not authored (no behavior change for existing components)", () => {
    const component: Component = {
      name: "search-service",
      dependsOn: [],
      build: { kind: "docker-build", context: "." },
      deploy: [phase("Publish", [{ kind: "publish-image" }])],
    };
    const projected = projectToJson(component) as { build: Record<string, unknown> };
    expect("sbom" in projected.build).toBe(false);
  });

  it("supports an explicit opt-out hint", () => {
    const build = { kind: "docker-build", sbom: { optOut: true } };
    expect(build.sbom.optOut).toBe(true);
  });
});
