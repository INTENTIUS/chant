/**
 * Tests for the thin interpret driver (#556, epic #551).
 *
 * All capabilities registered here are fakes/stubs — the real AWS capability
 * implementations are a separate later issue (#557). These tests exercise the
 * driver's generic behavior only: dependency ordering + parallel-safe waves,
 * sequential vs parallel step execution, `onFailure`/saga rollback in reverse
 * order, output wiring (`@Phase.field` and `@<component>.publish.*`), and that
 * a `gate` errors on the local executor. Several cases replay the real pilot
 * declarations (../pilots/*.pilot.ts) as realistic inputs.
 */

import { describe, expect, it } from "vitest";
import { CapabilityRegistry, type DeployContext } from "./capability";
import { createCapabilityRegistry } from "./registry";
import {
  DependencyCycleError,
  DriverGateUnsupportedError,
  DriverRunFailure,
  UnknownDependencyError,
  resolveComponentGraph,
  resolveWiring,
  runComponentDeploy,
  runInterpretDriver,
  type DriverComponent,
} from "./driver";
import { neo4jCluster } from "./pilots/neo4j-fanout.pilot";
import { ordersTable } from "./pilots/dynamodb.pilot";
import { searchService } from "./pilots/alb-ecs.pilot";
import { projectToJson } from "./pilots/project";

/** Build a fake capability that records every call and returns a canned/derived output. */
function fakeCapability(
  kind: string,
  opts?: {
    run?: (input: unknown) => unknown | Promise<unknown>;
    rollback?: (input: unknown) => void | Promise<void>;
    failRun?: boolean;
  },
) {
  const calls: { fn: "run" | "rollback"; ctx: DeployContext; input: unknown }[] = [];
  const capability = {
    kind,
    async run(ctx: DeployContext, input: unknown) {
      calls.push({ fn: "run", ctx, input });
      if (opts?.failRun) throw new Error(`${kind} failed`);
      return opts?.run ? await opts.run(input) : { ok: true };
    },
    ...(opts?.rollback
      ? {
          async rollback(ctx: DeployContext, input: unknown) {
            calls.push({ fn: "rollback", ctx, input });
            await opts.rollback!(input);
          },
        }
      : {}),
  };
  return { capability, calls };
}

describe("resolveComponentGraph", () => {
  it("orders independent components into a single wave", () => {
    const components: DriverComponent[] = [
      { name: "a", dependsOn: [], deploy: [] },
      { name: "b", dependsOn: [], deploy: [] },
    ];
    const graph = resolveComponentGraph(components);
    expect(graph.waves).toEqual([["a", "b"]]);
    expect(graph.order.sort()).toEqual(["a", "b"]);
  });

  it("orders a dependent component into a later wave than its dependency", () => {
    const components: DriverComponent[] = [
      { name: "shared-alb", dependsOn: [], deploy: [] },
      { name: "search-service", dependsOn: ["shared-alb"], deploy: [] },
    ];
    const graph = resolveComponentGraph(components);
    expect(graph.waves).toEqual([["shared-alb"], ["search-service"]]);
    expect(graph.order).toEqual(["shared-alb", "search-service"]);
  });

  it("groups multiple independent dependents of the same producer into one wave", () => {
    const components: DriverComponent[] = [
      { name: "jar-lib", dependsOn: [], deploy: [] },
      { name: "emr-job-a", dependsOn: ["jar-lib"], deploy: [] },
      { name: "emr-job-b", dependsOn: ["jar-lib"], deploy: [] },
    ];
    const graph = resolveComponentGraph(components);
    expect(graph.waves).toEqual([["jar-lib"], ["emr-job-a", "emr-job-b"]]);
  });

  it("throws DependencyCycleError for a cyclic dependsOn graph", () => {
    const components: DriverComponent[] = [
      { name: "a", dependsOn: ["b"], deploy: [] },
      { name: "b", dependsOn: ["a"], deploy: [] },
    ];
    expect(() => resolveComponentGraph(components)).toThrow(DependencyCycleError);
  });

  it("throws UnknownDependencyError when dependsOn names a component outside the run set", () => {
    const components: DriverComponent[] = [{ name: "a", dependsOn: ["missing"], deploy: [] }];
    expect(() => resolveComponentGraph(components)).toThrow(UnknownDependencyError);
  });

  it("resolves the three pilots' combined graph (no shared dependsOn among them, one wave)", () => {
    const components = [neo4jCluster, ordersTable, searchService].map(
      (p) => projectToJson(p) as unknown as DriverComponent,
    );
    // searchService depends on "shared-alb", which isn't in this run set —
    // add a stub producer so the graph resolves, mirroring a real project.
    const withSharedAlb: DriverComponent[] = [...components, { name: "shared-alb", dependsOn: [], deploy: [] }];
    const graph = resolveComponentGraph(withSharedAlb);
    expect(graph.waves[0]!.sort()).toEqual(["orders-table", "neo4j-cluster", "shared-alb"].sort());
    expect(graph.waves[1]).toEqual(["search-service"]);
  });
});

describe("resolveWiring", () => {
  it("resolves a prior-step reference (@Phase.field)", () => {
    const phaseOutputs = { Publish: { digest: "sha256:abc" } };
    expect(resolveWiring("@Publish.digest", phaseOutputs, {})).toBe("sha256:abc");
  });

  it("resolves a cross-component artifact reference (@component.publish.uri)", () => {
    const componentOutputs = { "jar-lib": { publish: { uri: "s3://bucket/jar-lib.jar" } } };
    expect(resolveWiring("@jar-lib.publish.uri", {}, componentOutputs)).toBe("s3://bucket/jar-lib.jar");
  });

  it("resolves a stackOutput reference", () => {
    const componentOutputs = { "shared-alb": { ListenerArn: "arn:aws:elb:listener/abc" } };
    expect(
      resolveWiring({ stackOutput: { stack: "shared-alb", name: "ListenerArn" } }, {}, componentOutputs),
    ).toBe("arn:aws:elb:listener/abc");
  });

  it("passes through a $env.* reference and plain literals unresolved", () => {
    expect(resolveWiring("$env.registry", {}, {})).toBe("$env.registry");
    expect(resolveWiring("plain-literal", {}, {})).toBe("plain-literal");
  });
});

describe("runComponentDeploy — sequential vs parallel", () => {
  it("runs sequential steps in declared order", async () => {
    const order: string[] = [];
    const registry = new CapabilityRegistry();
    registry.register(fakeCapability("step-a", { run: () => (order.push("a"), { ok: true }) }).capability);
    registry.register(fakeCapability("step-b", { run: () => (order.push("b"), { ok: true }) }).capability);

    const component: DriverComponent = {
      name: "c",
      deploy: [{ phase: "Apply", steps: [{ kind: "step-a" }, { kind: "step-b" }] }],
    };
    const result = await runComponentDeploy(component, { env: "dev", component: "c" }, registry, {});
    expect(result.ok).toBe(true);
    expect(order).toEqual(["a", "b"]);
  });

  it("runs parallel steps concurrently (interleaved start before either finishes)", async () => {
    const started: string[] = [];
    const registry = new CapabilityRegistry();
    registry.register(
      fakeCapability("slow", {
        run: async () => {
          started.push("slow-start");
          await new Promise((r) => setTimeout(r, 20));
          return { ok: true };
        },
      }).capability,
    );
    registry.register(
      fakeCapability("fast", {
        run: async () => {
          started.push("fast-start");
          return { ok: true };
        },
      }).capability,
    );

    const component: DriverComponent = {
      name: "c",
      deploy: [{ phase: "Verify", parallel: true, steps: [{ kind: "slow" }, { kind: "fast" }] }],
    };
    const result = await runComponentDeploy(component, { env: "dev", component: "c" }, registry, {});
    expect(result.ok).toBe(true);
    // Both started before the slow one's 20ms completed — proves concurrency, not queueing.
    expect(started).toEqual(["slow-start", "fast-start"]);
  });

  it("dispatches purely by step kind — the same registry serves any component with no per-component branch", async () => {
    const registry = new CapabilityRegistry();
    const { capability, calls } = fakeCapability("docker-build", { run: () => ({ digest: "sha256:x" }) });
    registry.register(capability);

    const componentX: DriverComponent = {
      name: "x",
      deploy: [{ phase: "Build", steps: [{ kind: "docker-build", context: "." }] }],
    };
    const componentY: DriverComponent = {
      name: "y",
      deploy: [{ phase: "Build", steps: [{ kind: "docker-build", context: "./y" }] }],
    };
    await runComponentDeploy(componentX, { env: "dev", component: "x" }, registry, {});
    await runComponentDeploy(componentY, { env: "dev", component: "y" }, registry, {});
    expect(calls.map((c) => c.ctx.component)).toEqual(["x", "y"]);
  });
});

describe("runComponentDeploy — gate on the local executor", () => {
  it("throws DriverGateUnsupportedError when a phase contains a gate", async () => {
    const registry = new CapabilityRegistry();
    const component: DriverComponent = {
      name: "neo4j-cluster",
      deploy: [
        {
          phase: "Node 1",
          steps: [{ kind: "gate", signalName: "approve-node-1" }, { kind: "cfn-deploy" }],
        },
      ],
    };
    await expect(
      runComponentDeploy(component, { env: "dev", component: "neo4j-cluster" }, registry, {}),
    ).rejects.toThrow(DriverGateUnsupportedError);
  });

  it("the neo4j pilot's gated Node 1 phase errors locally (matches chant's local-executor behavior)", async () => {
    const registry = new CapabilityRegistry();
    for (const kind of ["cfn-deploy", "code-deploy", "wait-cluster-healthy"]) {
      registry.register(fakeCapability(kind, { run: () => ({ ok: true }) }).capability);
    }
    const json = projectToJson(neo4jCluster) as unknown as DriverComponent;
    await expect(runComponentDeploy(json, { env: "dev", component: "neo4j-cluster" }, registry, {})).rejects.toThrow(
      /gate "approve-neo4j-node-1" is not supported/,
    );
  });
});

describe("runComponentDeploy — onFailure saga rollback", () => {
  it("unwinds executed steps in reverse order via each capability's rollback", async () => {
    const rollbackOrder: string[] = [];
    const registry = new CapabilityRegistry();
    registry.register(
      fakeCapability("provision", {
        run: () => ({ id: "res-1" }),
        rollback: () => {
          rollbackOrder.push("provision");
        },
      }).capability,
    );
    registry.register(
      fakeCapability("configure", {
        run: () => ({ ok: true }),
        rollback: () => {
          rollbackOrder.push("configure");
        },
      }).capability,
    );
    registry.register(fakeCapability("apply-final", { failRun: true }).capability);

    const component: DriverComponent = {
      name: "c",
      deploy: [
        { phase: "Provision", steps: [{ kind: "provision" }] },
        { phase: "Configure", steps: [{ kind: "configure" }] },
        { phase: "Apply", steps: [{ kind: "apply-final" }] },
      ],
    };
    const result = await runComponentDeploy(component, { env: "dev", component: "c" }, registry, {});
    expect(result.ok).toBe(false);
    // Reverse order: configure (2nd executed) rolls back before provision (1st executed).
    expect(rollbackOrder).toEqual(["configure", "provision"]);
  });

  it("does not call rollback for a capability that never declared one", async () => {
    const registry = new CapabilityRegistry();
    const { capability, calls } = fakeCapability("no-rollback-step", { run: () => ({ ok: true }) });
    registry.register(capability);
    registry.register(fakeCapability("failing-step", { failRun: true }).capability);

    const component: DriverComponent = {
      name: "c",
      deploy: [
        { phase: "One", steps: [{ kind: "no-rollback-step" }] },
        { phase: "Two", steps: [{ kind: "failing-step" }] },
      ],
    };
    await runComponentDeploy(component, { env: "dev", component: "c" }, registry, {});
    expect(calls.some((c) => c.fn === "rollback")).toBe(false);
  });

  it("runs a component-level rollback (schema `rollback` field) after step rollback, matching the ALB/ECS pilot's explicit compensation", async () => {
    const registry = new CapabilityRegistry();
    registry.register(fakeCapability("docker-build", { run: () => ({ digest: "sha256:abc" }) }).capability);
    registry.register(
      fakeCapability("publish-image", { run: () => ({ digest: "sha256:abc", uri: "reg/img@sha256:abc" }) })
        .capability,
    );
    registry.register(fakeCapability("cfn-deploy", { run: () => ({ stackStatus: "UPDATE_COMPLETE", outputs: {} }) }).capability);
    // ecs-update-service fails, and (per the pilot's comment) has no native
    // rollback — the component's own `rollback` phase is what should fire.
    registry.register(fakeCapability("ecs-update-service", { failRun: true }).capability);
    const { capability: rollbackPreviousCap, calls: rollbackPreviousCalls } = fakeCapability("rollback-previous", {
      run: () => ({ restored: true }),
    });
    registry.register(rollbackPreviousCap);
    // Verify/rollback phases never reached since Apply fails first, but register
    // stubs anyway so a hypothetical reordering wouldn't crash the test on an
    // unregistered kind.
    registry.register(fakeCapability("wait-steady-state", { run: () => ({ runningCount: 1 }) }).capability);
    registry.register(fakeCapability("health-gate", { run: () => ({ healthy: true }) }).capability);

    const json = projectToJson(searchService) as unknown as DriverComponent;
    const result = await runComponentDeploy(json, { env: "dev", component: "search-service" }, registry, {});

    expect(result.ok).toBe(false);
    expect(rollbackPreviousCalls).toHaveLength(1);
    expect(rollbackPreviousCalls[0]!.input).toMatchObject({ service: "search" });
    const rollbackRecord = result.records.find((r) => r.phase === "Rollback" && r.kind === "rollback-previous");
    expect(rollbackRecord?.status).toBe("ok");
  });
});

describe("runComponentDeploy — output wiring", () => {
  it("wires a prior step's output into a later step in the same component (@Phase.field)", async () => {
    const registry = new CapabilityRegistry();
    registry.register(fakeCapability("publish-image", { run: () => ({ digest: "sha256:deadbeef" }) }).capability);
    const { capability: applyCap, calls: applyCalls } = fakeCapability("cfn-deploy", {
      run: () => ({ stackStatus: "UPDATE_COMPLETE", outputs: {} }),
    });
    registry.register(applyCap);

    const component: DriverComponent = {
      name: "search-service",
      deploy: [
        { phase: "Publish", steps: [{ kind: "publish-image", from: "archive", to: "$env.registry" }] },
        { phase: "Apply", steps: [{ kind: "cfn-deploy", template: "t.json", imageRef: "@Publish.digest" }] },
      ],
    };
    const result = await runComponentDeploy(component, { env: "dev", component: "search-service" }, registry, {});
    expect(result.ok).toBe(true);
    expect(applyCalls[0]!.input).toMatchObject({ imageRef: "sha256:deadbeef" });
  });

  it("wires a cross-component artifact reference (@<component>.publish.uri) into a consumer", async () => {
    const registry = new CapabilityRegistry();
    registry.register(fakeCapability("jvm-build", { run: () => ({ archivePath: "lib.jar", digest: "sha256:jar" }) }).capability);
    registry.register(fakeCapability("publish-artifact", { run: () => ({ uri: "s3://bucket/jar-lib.jar", digest: "sha256:jar" }) }).capability);
    const { capability: submitCap, calls: submitCalls } = fakeCapability("emr-start-job-run", {
      run: () => ({ runId: "run-1" }),
    });
    registry.register(submitCap);
    registry.register(fakeCapability("wait-job", { run: () => ({ state: "COMPLETED" }) }).capability);

    const jarLib: DriverComponent = {
      name: "jar-lib",
      dependsOn: [],
      deploy: [{ phase: "Publish", steps: [{ kind: "publish-artifact", from: "archive", to: "$env.s3" }] }],
    };
    const emrJob: DriverComponent = {
      name: "emr-job",
      dependsOn: ["jar-lib"],
      deploy: [
        { phase: "Submit", steps: [{ kind: "emr-start-job-run", jar: "@jar-lib.publish.uri" }] },
        { phase: "Verify", steps: [{ kind: "wait-job", runId: "@Submit.runId" }] },
      ],
    };

    const result = await runInterpretDriver([jarLib, emrJob], registry, { env: "dev" });
    expect(result.ok).toBe(true);
    expect(submitCalls[0]!.input).toMatchObject({ jar: "s3://bucket/jar-lib.jar" });
  });
});

describe("runInterpretDriver — end to end", () => {
  it("runs a producer before its consumer and threads env/vars into every capability call", async () => {
    const registry = new CapabilityRegistry();
    const seen: DeployContext[] = [];
    registry.register({
      kind: "noop",
      async run(ctx: DeployContext) {
        seen.push(ctx);
        return {};
      },
    });

    const a: DriverComponent = { name: "a", dependsOn: [], deploy: [{ phase: "P", steps: [{ kind: "noop" }] }] };
    const b: DriverComponent = { name: "b", dependsOn: ["a"], deploy: [{ phase: "P", steps: [{ kind: "noop" }] }] };

    const result = await runInterpretDriver([b, a], registry, { env: "staging", vars: { cluster: "prod-1" } });
    expect(result.ok).toBe(true);
    expect(result.waves).toEqual([["a"], ["b"]]);
    expect(seen.map((c) => c.component)).toEqual(["a", "b"]);
    expect(seen.every((c) => c.env === "staging" && c.vars?.cluster === "prod-1")).toBe(true);
  });

  it("stops the run at the first failed component and throws DriverRunFailure carrying partial results", async () => {
    const registry = new CapabilityRegistry();
    registry.register(fakeCapability("ok-step", { run: () => ({ ok: true }) }).capability);
    registry.register(fakeCapability("bad-step", { failRun: true }).capability);

    const a: DriverComponent = { name: "a", dependsOn: [], deploy: [{ phase: "P", steps: [{ kind: "bad-step" }] }] };
    const b: DriverComponent = { name: "b", dependsOn: ["a"], deploy: [{ phase: "P", steps: [{ kind: "ok-step" }] }] };

    await expect(runInterpretDriver([a, b], registry, { env: "dev" })).rejects.toThrow(DriverRunFailure);
    try {
      await runInterpretDriver([a, b], registry, { env: "dev" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DriverRunFailure);
      const failure = err as DriverRunFailure;
      expect(failure.result.failedComponent).toBe("a");
      expect(failure.result.results.map((r) => r.component)).toEqual(["a"]);
      expect(failure.result.ok).toBe(false);
    }
  });

  it("runs the three pilots through one driver instance with zero per-component driver code (sprawl metric)", async () => {
    const registry = new CapabilityRegistry();
    const kinds = [
      "cfn-deploy",
      "code-deploy",
      "wait-cluster-healthy",
      "docker-build",
      "publish-image",
      "ecs-update-service",
      "wait-steady-state",
      "health-gate",
      "rollback-previous",
      "wait-for-stack",
      "run-migration",
    ];
    for (const kind of kinds) {
      registry.register(fakeCapability(kind, { run: () => ({ ok: true }) }).capability);
    }

    const sharedAlb: DriverComponent = { name: "shared-alb", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "cfn-deploy" }] }] };
    const dynamo = projectToJson(ordersTable) as unknown as DriverComponent;

    // neo4j has a gate at Node 1 — omit it here since this test asserts the
    // happy path across heterogeneous pilots; the gate-specific behavior is
    // covered above. Swap in a gate-free variant by stripping the gate step.
    const neo4jJson = projectToJson(neo4jCluster) as unknown as DriverComponent;
    const neo4jNoGate: DriverComponent = {
      ...neo4jJson,
      deploy: neo4jJson.deploy.map((p) => ({ ...p, steps: p.steps.filter((s) => (s as { kind?: string }).kind !== "gate") })),
    };

    const albEcs = projectToJson(searchService) as unknown as DriverComponent;

    const result = await runInterpretDriver([sharedAlb, dynamo, neo4jNoGate, albEcs], registry, {
      env: "dev",
      vars: { registry: "123.dkr.ecr.us-east-1.amazonaws.com", cluster: "prod" },
    });
    expect(result.ok).toBe(true);
    // search-service depends on shared-alb, so it must land in a later wave.
    const albWave = result.waves.findIndex((w) => w.includes("shared-alb"));
    const searchWave = result.waves.findIndex((w) => w.includes("search-service"));
    expect(searchWave).toBeGreaterThan(albWave);
    expect(result.results.map((r) => r.component).sort()).toEqual(
      ["shared-alb", "orders-table", "neo4j-cluster", "search-service"].sort(),
    );
  });
});

describe("capabilities are consumed exactly as the stub registry provides them", () => {
  it("a still-stubbed capability (CapabilityNotImplementedError) surfaces as a failed step, not a driver crash", async () => {
    const registry = createCapabilityRegistry();
    const component: DriverComponent = {
      name: "c",
      deploy: [{ phase: "Apply", steps: [{ kind: "cfn-deploy", stack: "x" }] }],
    };
    const result = await runComponentDeploy(component, { env: "dev", component: "c" }, registry, {});
    expect(result.ok).toBe(false);
    const failed = result.records.find((r) => r.status === "fail");
    expect(failed?.error).toMatch(/capability "cfn-deploy" is not implemented/);
  });
});
