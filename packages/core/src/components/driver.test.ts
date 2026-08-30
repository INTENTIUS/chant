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
import { stubCapability } from "./verbs/stub";
import {
  DependencyCycleError,
  DriverGateUnsupportedError,
  DriverRunFailure,
  UnknownDependencyError,
  accumulateComponentOutputs,
  collectComponentOutputs,
  resolveComponentGraph,
  resolveWiring,
  runComponentDeploy,
  runInterpretDriver,
  type DriverComponent,
  type DriverStepRecord,
  type RunProgressEvent,
} from "./driver";
import { neo4jCluster } from "./pilots/neo4j-fanout.pilot";
import { ordersTable } from "./pilots/dynamodb.pilot";
import { searchService } from "./pilots/alb-ecs.pilot";
import { imageProcessor } from "./pilots/lambda.pilot";
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

  it("does not call rollback for a capability that never declared one, but reports it as opted-out rather than silently skipping it", async () => {
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
    const result = await runComponentDeploy(component, { env: "dev", component: "c" }, registry, {});
    expect(calls.some((c) => c.fn === "rollback")).toBe(false);

    const optedOutRecord = result.records.find(
      (r) => r.kind === "no-rollback-step" && r.status === "rollback-opted-out",
    );
    expect(optedOutRecord).toBeDefined();
    expect(optedOutRecord?.error).toMatch(/declares no rollback/);
  });

  it("carries the step's declared noRollback reason into the opted-out record instead of the generic fallback message", async () => {
    const registry = new CapabilityRegistry();
    registry.register(fakeCapability("emr-start-job-run", { run: () => ({ runId: "run-1" }) }).capability);
    registry.register(fakeCapability("failing-step", { failRun: true }).capability);

    const component: DriverComponent = {
      name: "c",
      deploy: [
        {
          phase: "Submit",
          steps: [
            {
              kind: "emr-start-job-run",
              jar: "s3://bucket/lib.jar",
              noRollback: "a submitted job run has no automatic undo; cancelling it does not revert data it already wrote",
            },
          ],
        },
        { phase: "Verify", steps: [{ kind: "failing-step" }] },
      ],
    };
    const result = await runComponentDeploy(component, { env: "dev", component: "c" }, registry, {});
    expect(result.ok).toBe(false);

    const optedOutRecord = result.records.find(
      (r) => r.kind === "emr-start-job-run" && r.status === "rollback-opted-out",
    );
    expect(optedOutRecord?.error).toBe(
      "a submitted job run has no automatic undo; cancelling it does not revert data it already wrote",
    );
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

describe("collectComponentOutputs / accumulateComponentOutputs — the shared accumulator (#700)", () => {
  // Exported so the durable path's `accumulateComponentOutputs` activity
  // (lexicons/temporal/src/component-op/activities.ts) captures outputs via
  // the same function `runComponentDeploy` does — the accumulation twin of
  // the already-shared `resolveStepInput`.
  const phaseOutputs = {
    Apply: { stackStatus: "CREATE_COMPLETE", outputs: { ClusterArn: "arn:cluster", ApiRepoUri: "repo" } },
    Publish: { uri: "repo@sha256:abc", digest: "sha256:abc" },
  };

  it("namespaces publish outputs under `publish` and merges stack outputs at the top level", () => {
    expect(collectComponentOutputs(phaseOutputs)).toEqual({
      ClusterArn: "arn:cluster",
      ApiRepoUri: "repo",
      publish: { uri: "repo@sha256:abc", digest: "sha256:abc" },
    });
  });

  it("returns undefined when no phase output looks like a publish or stack result", () => {
    expect(collectComponentOutputs({ Verify: { ok: true } })).toBeUndefined();
  });

  it("records under the component name, merging over a seeded entry, and returns the map", () => {
    const seeded = { "shared-alb": { Seeded: "keep" }, other: { x: 1 } };
    const out = accumulateComponentOutputs(seeded, "shared-alb", phaseOutputs);
    expect(out).toBe(seeded);
    expect(out["shared-alb"]).toEqual({
      Seeded: "keep",
      ClusterArn: "arn:cluster",
      ApiRepoUri: "repo",
      publish: { uri: "repo@sha256:abc", digest: "sha256:abc" },
    });
    expect(out.other).toEqual({ x: 1 });
    // Plain data throughout — survives the Temporal activity JSON boundary unchanged.
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  });

  it("is a no-op when the component exposed nothing", () => {
    const map = { other: { x: 1 } };
    expect(accumulateComponentOutputs(map, "svc", { Verify: { ok: true } })).toEqual({ other: { x: 1 } });
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

  it("feeds a deployed stack's outputs to a downstream component's stackOutput references (cross-stack apply-order, #556 follow-up)", async () => {
    const registry = new CapabilityRegistry();
    // shared-alb's apply returns real stack outputs — the values a downstream
    // service needs (its ECR repo URI, the cluster ARN).
    registry.register(
      fakeCapability("cfn-deploy", {
        run: () => ({
          stackStatus: "CREATE_COMPLETE",
          outputs: {
            ApiRepoUri: "123.dkr.ecr.us-east-1.amazonaws.com/alb-api",
            ClusterArn: "arn:aws:ecs:us-east-1:123:cluster/shared",
          },
        }),
      }).capability,
    );
    registry.register(fakeCapability("docker-build", { run: () => ({ archivePath: "api.tar", digest: "sha256:abc" }) }).capability);
    const publish = fakeCapability("publish-image", { run: () => ({ uri: "repo@sha256:abc", digest: "sha256:abc" }) });
    registry.register(publish.capability);
    const verify = fakeCapability("wait-steady-state", { run: () => ({ ok: true }) });
    registry.register(verify.capability);

    const sharedAlb: DriverComponent = {
      name: "shared-alb",
      dependsOn: [],
      deploy: [{ phase: "Apply", steps: [{ kind: "cfn-deploy", stack: "shared-alb", template: "shared-alb.json" }] }],
    };
    const api: DriverComponent = {
      name: "api",
      dependsOn: ["shared-alb"],
      deploy: [
        { phase: "Build", steps: [{ kind: "docker-build", context: "./api", into: "api.tar" }] },
        { phase: "Publish", steps: [{ kind: "publish-image", from: "archive:api.tar", to: { stackOutput: { stack: "shared-alb", name: "ApiRepoUri" } } }] },
        { phase: "Verify", steps: [{ kind: "wait-steady-state", service: "api", cluster: { stackOutput: { stack: "shared-alb", name: "ClusterArn" } } }] },
      ],
    };

    const result = await runInterpretDriver([sharedAlb, api], registry, { env: "prod" });
    expect(result.ok).toBe(true);
    // Before this fix the driver dropped shared-alb's outputs, so these refs
    // resolved to undefined. Now the downstream steps receive the real values.
    expect((publish.calls[0].input as { to: string }).to).toBe("123.dkr.ecr.us-east-1.amazonaws.com/alb-api");
    expect((verify.calls[0].input as { cluster: string }).cluster).toBe("arn:aws:ecs:us-east-1:123:cluster/shared");
    // The accumulated outputs are exposed on the result so the CLI can
    // `--dump-outputs` them for a downstream job to `--seed-outputs`.
    expect(result.componentOutputs["shared-alb"]).toMatchObject({
      ApiRepoUri: "123.dkr.ecr.us-east-1.amazonaws.com/alb-api",
      ClusterArn: "arn:aws:ecs:us-east-1:123:cluster/shared",
    });
  });

  it("seeded componentOutputs let a single downstream component resolve a cross-job stackOutput (artifact threading)", async () => {
    // Simulates the generated pipeline's downstream job: api runs alone (via the
    // single-component `runComponentDeploy` path, bypassing whole-graph
    // resolution — its dependency shared-alb is not in this process), seeded with
    // shared-alb's outputs from an earlier job, and still resolves the reference.
    const registry = new CapabilityRegistry();
    const publish = fakeCapability("publish-image", { run: () => ({ uri: "repo@sha256:abc", digest: "sha256:abc" }) });
    registry.register(publish.capability);

    const api: DriverComponent = {
      name: "api",
      dependsOn: ["shared-alb"],
      deploy: [
        { phase: "Publish", steps: [{ kind: "publish-image", from: "archive:api.tar", to: { stackOutput: { stack: "shared-alb", name: "ApiRepoUri" } } }] },
      ],
    };

    const seeded = { "shared-alb": { ApiRepoUri: "123.dkr.ecr.us-east-1.amazonaws.com/alb-api" } };
    const result = await runComponentDeploy(api, { env: "prod", component: "api" }, registry, seeded);
    expect(result.ok).toBe(true);
    expect((publish.calls[0].input as { to: string }).to).toBe("123.dkr.ecr.us-east-1.amazonaws.com/alb-api");
  });

  it("runs all four components — the original three pilots plus the #558 validation component — through one driver instance with zero per-component driver code (sprawl metric, extended)", async () => {
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
      "lambda-deploy",
    ];
    for (const kind of kinds) {
      registry.register(fakeCapability(kind, { run: () => ({ ok: true }) }).capability);
    }

    const sharedAlb: DriverComponent = {
      name: "shared-alb",
      dependsOn: [],
      deploy: [{ phase: "Apply", steps: [{ kind: "cfn-deploy" }] }],
    };
    const dynamo = projectToJson(ordersTable) as unknown as DriverComponent;
    const neo4jJson = projectToJson(neo4jCluster) as unknown as DriverComponent;
    const neo4jNoGate: DriverComponent = {
      ...neo4jJson,
      deploy: neo4jJson.deploy.map((p) => ({ ...p, steps: p.steps.filter((s) => (s as { kind?: string }).kind !== "gate") })),
    };
    const albEcs = projectToJson(searchService) as unknown as DriverComponent;
    const lambda = projectToJson(imageProcessor) as unknown as DriverComponent;

    const result = await runInterpretDriver([sharedAlb, dynamo, neo4jNoGate, albEcs, lambda], registry, {
      env: "dev",
      vars: { registry: "123.dkr.ecr.us-east-1.amazonaws.com", cluster: "prod" },
    });

    expect(result.ok).toBe(true);
    expect(result.results.map((r) => r.component).sort()).toEqual(
      ["shared-alb", "orders-table", "neo4j-cluster", "search-service", "image-processor-lambda"].sort(),
    );
  });
});

describe("onProgress — --progress-json event stream (M3, additive over the wave/component/phase/step loop)", () => {
  /** Drop the nondeterministic `durationMs` field so a run's records can be compared for equality across two invocations. */
  function stripTiming(records: DriverStepRecord[]): Omit<DriverStepRecord, "durationMs">[] {
    return records.map(({ durationMs: _durationMs, ...rest }) => rest);
  }

  it("emits run-start -> wave-start -> component-start -> phase-start -> step(running/ok) -> phase-done -> component-done -> wave-done, once per wave, then run-done", async () => {
    const registry = new CapabilityRegistry();
    registry.register(fakeCapability("step-a", { run: () => ({ ok: true }) }).capability);
    registry.register(fakeCapability("step-b", { run: () => ({ ok: true }) }).capability);

    const a: DriverComponent = { name: "a", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "step-a" }] }] };
    const b: DriverComponent = { name: "b", dependsOn: ["a"], deploy: [{ phase: "Apply", steps: [{ kind: "step-b" }] }] };

    const events: RunProgressEvent[] = [];
    const result = await runInterpretDriver([a, b], registry, { env: "dev", onProgress: (e) => events.push(e) });

    expect(result.ok).toBe(true);
    expect(events.map((e) => e.type)).toEqual([
      "run-start",
      "wave-start",
      "component-start",
      "phase-start",
      "step",
      "step",
      "phase-done",
      "component-done",
      "wave-done",
      "wave-start",
      "component-start",
      "phase-start",
      "step",
      "step",
      "phase-done",
      "component-done",
      "wave-done",
      "run-done",
    ]);

    // Wave 1: component "a".
    expect(events[0]).toEqual({ type: "run-start", waves: [["a"], ["b"]] });
    expect(events[1]).toEqual({ type: "wave-start", wave: 1, components: ["a"] });
    expect(events[2]).toEqual({ type: "component-start", wave: 1, component: "a" });
    expect(events[3]).toEqual({ type: "phase-start", component: "a", phase: "Apply" });
    expect(events[4]).toEqual({ type: "step", component: "a", phase: "Apply", step: "step-a", status: "running" });
    expect(events[5]).toEqual({ type: "step", component: "a", phase: "Apply", step: "step-a", status: "ok" });
    expect(events[6]).toEqual({ type: "phase-done", component: "a", phase: "Apply", status: "ok" });
    expect(events[7]).toEqual({ type: "component-done", wave: 1, component: "a", status: "ok" });
    expect(events[8]).toEqual({ type: "wave-done", wave: 1, status: "ok" });

    // Wave 2: component "b" (1-based wave numbering).
    expect(events[9]).toEqual({ type: "wave-start", wave: 2, components: ["b"] });
    expect(events[10]).toEqual({ type: "component-start", wave: 2, component: "b" });
    expect(events[15]).toEqual({ type: "component-done", wave: 2, component: "b", status: "ok" });
    expect(events[16]).toEqual({ type: "wave-done", wave: 2, status: "ok" });

    expect(events[17]).toEqual({ type: "run-done", status: "ok" });
  });

  it("a failing step yields step:failed (with error), phase-done:failed, component-done:failed, wave-done:failed, run-done:failed — and a later wave never starts", async () => {
    const registry = new CapabilityRegistry();
    registry.register(fakeCapability("bad-step", { failRun: true }).capability);
    registry.register(fakeCapability("step-b", { run: () => ({ ok: true }) }).capability);

    const a: DriverComponent = { name: "a", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "bad-step" }] }] };
    const b: DriverComponent = { name: "b", dependsOn: ["a"], deploy: [{ phase: "Apply", steps: [{ kind: "step-b" }] }] };

    const events: RunProgressEvent[] = [];
    await expect(
      runInterpretDriver([a, b], registry, { env: "dev", onProgress: (e) => events.push(e) }),
    ).rejects.toThrow(DriverRunFailure);

    expect(events.map((e) => e.type)).toEqual([
      "run-start",
      "wave-start",
      "component-start",
      "phase-start",
      "step",
      "step",
      "phase-done",
      "component-done",
      "wave-done",
      "run-done",
    ]);
    // Only wave 1 ever starts — the driver stops at the first failed
    // component, so wave 2 (containing "b") never runs.
    expect(events.filter((e) => e.type === "wave-start")).toHaveLength(1);
    expect(events.filter((e) => e.type === "component-start")).toEqual([{ type: "component-start", wave: 1, component: "a" }]);

    expect(events[4]).toEqual({ type: "step", component: "a", phase: "Apply", step: "bad-step", status: "running" });
    expect(events[5]).toEqual({
      type: "step",
      component: "a",
      phase: "Apply",
      step: "bad-step",
      status: "failed",
      error: "bad-step failed",
    });
    expect(events[6]).toEqual({ type: "phase-done", component: "a", phase: "Apply", status: "failed" });
    expect(events[7]).toEqual({ type: "component-done", wave: 1, component: "a", status: "failed" });
    expect(events[8]).toEqual({ type: "wave-done", wave: 1, status: "failed" });
    expect(events[9]).toEqual({ type: "run-done", status: "failed" });
  });

  it("produces the identical DriverRunResult (minus timing) whether or not onProgress is passed", async () => {
    function buildRegistry(): CapabilityRegistry {
      const registry = new CapabilityRegistry();
      registry.register(fakeCapability("step-a", { run: () => ({ ok: true }) }).capability);
      registry.register(fakeCapability("step-b", { run: () => ({ ok: true }) }).capability);
      return registry;
    }
    const a: DriverComponent = { name: "a", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "step-a" }] }] };
    const b: DriverComponent = { name: "b", dependsOn: ["a"], deploy: [{ phase: "Apply", steps: [{ kind: "step-b" }] }] };

    const withoutProgress = await runInterpretDriver([a, b], buildRegistry(), { env: "dev" });
    const events: RunProgressEvent[] = [];
    const withProgress = await runInterpretDriver([a, b], buildRegistry(), {
      env: "dev",
      onProgress: (e) => events.push(e),
    });

    // onProgress was actually exercised — otherwise this comparison would be vacuous.
    expect(events.length).toBeGreaterThan(0);

    const normalize = (r: typeof withoutProgress) => ({
      ...r,
      results: r.results.map((cr) => ({ ...cr, records: stripTiming(cr.records) })),
    });
    expect(normalize(withProgress)).toEqual(normalize(withoutProgress));
  });

  it("runComponentDeploy behaves identically with onProgress omitted (undefined-safe, no-op)", async () => {
    const registry = new CapabilityRegistry();
    registry.register(fakeCapability("step-a", { run: () => ({ ok: true }) }).capability);
    const component: DriverComponent = { name: "c", deploy: [{ phase: "Apply", steps: [{ kind: "step-a" }] }] };

    const result = await runComponentDeploy(component, { env: "dev", component: "c" }, registry, {});

    expect(result.ok).toBe(true);
    expect(stripTiming(result.records)).toEqual([
      { component: "c", phase: "Apply", kind: "step-a", status: "ok", output: { ok: true } },
    ]);
  });

  it("onFailure saga rollback: rollback-unwind steps are not reported as `step` progress events (only the forward failing step and the component's own authored rollback phase are)", async () => {
    const registry = new CapabilityRegistry();
    registry.register(
      fakeCapability("provision", { run: () => ({ id: "res-1" }), rollback: () => {} }).capability,
    );
    registry.register(fakeCapability("apply-final", { failRun: true }).capability);
    registry.register(fakeCapability("compensate", { run: () => ({ restored: true }) }).capability);

    const component: DriverComponent = {
      name: "c",
      deploy: [
        { phase: "Provision", steps: [{ kind: "provision" }] },
        { phase: "Apply", steps: [{ kind: "apply-final" }] },
      ],
      rollback: [{ phase: "Rollback", steps: [{ kind: "compensate" }] }],
    };

    const events: RunProgressEvent[] = [];
    const result = await runComponentDeploy(component, { env: "dev", component: "c" }, registry, {}, (e) =>
      events.push(e),
    );

    expect(result.ok).toBe(false);
    const stepEvents = events.filter((e): e is Extract<RunProgressEvent, { type: "step" }> => e.type === "step");
    // "provision" (forward, ok), "apply-final" (forward, failed), "compensate"
    // (the component's own authored rollback phase) — never the saga unwind's
    // reverse-order capability.rollback() call for "provision", which the
    // driver still performs but doesn't surface as a `step` event.
    expect(stepEvents.map((e) => `${e.step}:${e.status}`)).toEqual([
      "provision:running",
      "provision:ok",
      "apply-final:running",
      "apply-final:failed",
      "compensate:running",
      "compensate:ok",
    ]);
    expect(events.filter((e) => e.type === "phase-start").map((e) => (e as { phase: string }).phase)).toEqual([
      "Provision",
      "Apply",
      "Rollback",
    ]);
  });
});

describe("capabilities are consumed exactly as the registry provides them", () => {
  // No starter verb is a stub any more, but the stub *mechanism*
  // (./verbs/stub.ts) stays for third-party plugins / future verbs. A stub
  // registered by kind must surface its CapabilityNotImplementedError as an
  // ordinary failed step rather than crashing the driver.
  it("a stubbed capability (CapabilityNotImplementedError) surfaces as a failed step, not a driver crash", async () => {
    const registry = new CapabilityRegistry();
    registry.register(stubCapability("some-future-verb"));
    const component: DriverComponent = {
      name: "c",
      deploy: [{ phase: "Apply", steps: [{ kind: "some-future-verb" }] }],
    };
    const result = await runComponentDeploy(component, { env: "dev", component: "c" }, registry, {});
    expect(result.ok).toBe(false);
    const failed = result.records.find((r) => r.status === "fail");
    expect(failed?.error).toMatch(/capability "some-future-verb" is not implemented/);
  });
});
