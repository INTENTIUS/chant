/**
 * End-to-end verification for #557: the three pilots (#555) run to completion
 * through the real, merged interpret driver (#556, ../driver.ts), dispatching
 * to the real AWS-leaf capability implementations this issue adds
 * (../verbs/{build,publish,apply,host-delivery,wait-verify}.ts) — not the
 * typed stubs `createCapabilityRegistry()` still returns for non-pilot verbs.
 *
 * Every capability here is wired to a `MockCloudExecutor`
 * (../verbs/__tests__/mock-cloud-executor.ts): no live AWS, no live docker.
 * This suite is the acceptance-criteria proof from the issue:
 *  - correct capability dispatch across all three pilots through one driver;
 *  - `cfn-deploy` refuses a data-losing replacement when `onReplace: "block"`;
 *  - every mutating capability the pilots use declares a `rollback`, or the
 *    component supplies its own explicit compensation phase (documented, not
 *    silent) where the capability itself has none.
 */

import { describe, expect, it } from "vitest";
import { CapabilityRegistry } from "../capability";
import { runInterpretDriver, DriverRunFailure, type DriverComponent } from "../driver";
import { neo4jCluster } from "./neo4j-fanout.pilot";
import { ordersTable } from "./dynamodb.pilot";
import { searchService } from "./alb-ecs.pilot";
import { projectToJson } from "./project";
import { createMockCloudExecutor, type MockCloudExecutor } from "../verbs/__tests__/mock-cloud-executor";
import { createDockerBuildCapability } from "../verbs/build";
import { createPublishImageCapability } from "../verbs/publish";
import { createCfnDeployCapability, createEcsUpdateServiceCapability, CfnReplacementBlockedError } from "../verbs/apply";
import { createCodeDeployCapability } from "../verbs/host-delivery";
import {
  createWaitForStackCapability,
  createWaitSteadyStateCapability,
  createWaitClusterHealthyCapability,
} from "../verbs/wait-verify";

/** Build a fresh registry with every real #557 capability wired to one shared mock executor, plus the still-stubbed verbs the pilots also reference (run-migration, health-gate, rollback-previous — none of which #557 scopes). */
function buildRegistry(mock: MockCloudExecutor): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registry.register(createDockerBuildCapability(mock.executor));
  registry.register(createPublishImageCapability(mock.executor));
  registry.register(createCfnDeployCapability(mock.executor));
  registry.register(createEcsUpdateServiceCapability(mock.executor));
  registry.register(createCodeDeployCapability(mock.executor));
  registry.register(createWaitForStackCapability(mock.executor));
  registry.register(createWaitSteadyStateCapability(mock.executor));
  registry.register(createWaitClusterHealthyCapability(mock.executor));
  // Non-AWS-leaf / non-pilot-scoped verbs the pilots still reference — out of
  // #557's scope (still typed stubs in ../verbs/*.ts), so faked here to
  // succeed so the happy-path E2E run can reach completion. `rollback-previous`
  // backs the ALB/ECS pilot's own compensation phase.
  registry.register({ kind: "run-migration", run: async () => ({ applied: true, version: "1" }) });
  registry.register({ kind: "health-gate", run: async () => ({ healthy: true }) });
  registry.register({ kind: "rollback-previous", run: async () => ({ restored: true }) });
  return registry;
}

/** Strip the Neo4j pilot's Node-1 human-approval gate — the local driver rejects any `gate` step (matches driver.test.ts's documented behavior); this suite is about capability dispatch, not gate handling, which #556 already covers. */
function neo4jWithoutGate(): DriverComponent {
  const json = projectToJson(neo4jCluster) as unknown as DriverComponent;
  return {
    ...json,
    deploy: json.deploy.map((p) => ({
      ...p,
      steps: p.steps.filter((s) => (s as { kind?: string }).kind !== "gate"),
    })),
  };
}

describe("Pilots end-to-end through the real interpret driver (#557 acceptance criteria)", () => {
  it("runs all three pilots to completion, dispatching every step to its real #557 capability", async () => {
    const mock = createMockCloudExecutor({
      stacks: {
        "orders-table": { outputs: {} },
        "search-service": { outputs: {} },
        "neo4j-cluster": { outputs: {} },
      },
      ecsServices: { "prod-cluster/search": { runningCount: 2, desiredCount: 2, stable: true } },
      clusters: {
        // The Neo4j pilot's per-instance phases omit `cluster`, so this
        // implementation falls back to `ctx.vars.clusterEndpoints` — supplied
        // below via `runInterpretDriver`'s `vars`.
        "az0:7687,az1:7687,az2:7687": { healthyCount: 3 },
      },
    });
    const registry = buildRegistry(mock);

    const dynamo = projectToJson(ordersTable) as unknown as DriverComponent;
    const albEcs = projectToJson(searchService) as unknown as DriverComponent;
    // The ALB/ECS pilot depends on "shared-alb", a cross-stack producer not
    // among the three pilots themselves — add a trivial stub component so the
    // graph resolves, exactly as driver.test.ts's own sprawl-metric case does.
    const sharedAlb: DriverComponent = {
      name: "shared-alb",
      dependsOn: [],
      deploy: [{ phase: "Apply", steps: [{ kind: "cfn-deploy", stack: "shared-alb", template: "archive:alb.json" }] }],
    };
    // The pilot's ecs-update-service step wires `cluster: "$env.cluster"` — a
    // literal the driver deliberately leaves unresolved (env resolution is the
    // caller's job, not the driver's; see driver.ts's resolveWiring docstring).
    // Substitute the concrete env value here, exactly as a real caller would
    // before invoking the driver.
    const albEcsResolved: DriverComponent = {
      ...albEcs,
      deploy: albEcs.deploy.map((p) => ({
        ...p,
        steps: p.steps.map((s) =>
          (s as { kind?: string }).kind === "ecs-update-service" ? { ...s, cluster: "prod-cluster" } : s,
        ),
      })),
      rollback: albEcs.rollback?.map((p) => ({
        ...p,
        steps: p.steps.map((s) => ({ ...s, cluster: "cluster" in s ? "prod-cluster" : undefined })),
      })),
    };

    const result = await runInterpretDriver([sharedAlb, dynamo, neo4jWithoutGate(), albEcsResolved], registry, {
      env: "dev",
      vars: { registry: "123.dkr.ecr.us-east-1.amazonaws.com", cluster: "prod-cluster", clusterEndpoints: "az0:7687,az1:7687,az2:7687" },
    });

    expect(result.ok).toBe(true);
    expect(result.results.map((r) => r.component).sort()).toEqual(
      ["shared-alb", "orders-table", "neo4j-cluster", "search-service"].sort(),
    );

    // Dispatch assertions: every `deploy`-phase step landed on the capability
    // its `kind` names. `docker-build` itself is the component's top-level
    // `build` field, not a `deploy` step — the driver (#556) only interprets
    // `deploy`/`rollback` phases, so build/archival happens upstream of this
    // driver run (see epic #551 §4); `publish-image` (a real `deploy` step,
    // the Publish phase) is what this run exercises for the image path.
    const callsByClient = mock.calls.map((c) => `${c.client}.${c.method}`);
    expect(callsByClient).toContain("docker.load"); // search-service's publish-image (loads the archived tarball)
    expect(callsByClient).toContain("docker.push"); // search-service's publish-image
    expect(callsByClient).toContain("cloudformation.createChangeSet"); // every cfn-deploy (shared-alb, orders-table, neo4j x3, search-service)
    expect(callsByClient).toContain("ecs.updateService"); // search-service's ecs-update-service
    expect(callsByClient).toContain("codeDeploy.createDeployment"); // neo4j's per-instance code-deploy
    expect(callsByClient).toContain("neo4j.probe"); // neo4j's wait-cluster-healthy

    // search-service depends on shared-alb, so it must run in a strictly later wave.
    const albWave = result.waves.findIndex((w) => w.includes("shared-alb"));
    const searchWave = result.waves.findIndex((w) => w.includes("search-service"));
    expect(searchWave).toBeGreaterThan(albWave);
  });

  it('cfn-deploy refuses a data-losing replacement when onReplace: "block" — the DynamoDB pilot\'s declared policy', async () => {
    const mock = createMockCloudExecutor({
      stacks: {
        "orders-table": {
          changes: [
            {
              action: "Modify",
              logicalResourceId: "OrdersTable",
              resourceType: "AWS::DynamoDB::Table",
              replacement: true, // CloudFormation proposes replacing (destroying + recreating) the table.
            },
          ],
        },
      },
    });
    const registry = buildRegistry(mock);
    const dynamo = projectToJson(ordersTable) as unknown as DriverComponent;

    // The DynamoDB pilot declares onReplace: "block" (see dynamodb.pilot.ts) —
    // confirm the composition itself, then confirm the driver run actually
    // refuses rather than silently applying a destructive replacement.
    const applyStep = dynamo.deploy[0]!.steps[0] as { onReplace?: string };
    expect(applyStep.onReplace).toBe("block");

    await expect(runInterpretDriver([dynamo], registry, { env: "dev" })).rejects.toThrow(DriverRunFailure);

    try {
      await runInterpretDriver([dynamo], registry, { env: "dev" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DriverRunFailure);
      const failure = err as DriverRunFailure;
      expect(failure.result.ok).toBe(false);
      expect(failure.result.failedComponent).toBe("orders-table");
      const failedStep = failure.result.results[0]!.records.find((r) => r.status === "fail");
      expect(failedStep?.kind).toBe("cfn-deploy");
      expect(failedStep?.error).toMatch(/refusing changeset/);
    }

    // The changeset must never have been executed — no mutation happened.
    expect(mock.calls.some((c) => c.method === "executeChangeSet")).toBe(false);
  });

  it('cfn-deploy allows the same replacing changeset when onReplace: "allow" is declared', async () => {
    const mock = createMockCloudExecutor({
      stacks: {
        "orders-table": {
          changes: [
            {
              action: "Modify",
              logicalResourceId: "OrdersTable",
              resourceType: "AWS::DynamoDB::Table",
              replacement: true,
            },
          ],
        },
      },
    });
    const registry = buildRegistry(mock);
    const dynamoAllow: DriverComponent = {
      ...(projectToJson(ordersTable) as unknown as DriverComponent),
      deploy: [
        {
          phase: "Apply",
          steps: [{ kind: "cfn-deploy", stack: "orders-table", template: "archive:orders-table.template.json", onReplace: "allow" }],
        },
      ],
    };
    const result = await runInterpretDriver([dynamoAllow], registry, { env: "dev" });
    expect(result.ok).toBe(true);
    expect(mock.calls.some((c) => c.method === "executeChangeSet")).toBe(true);
  });
});

describe("Every mutating #557 capability declares a rollback, or the pilot supplies an explicit opt-out", () => {
  it("cfn-deploy, ecs-update-service, and code-deploy declare a native rollback", () => {
    const mock = createMockCloudExecutor();
    expect(createCfnDeployCapability(mock.executor).rollback).toBeDefined();
    expect(createEcsUpdateServiceCapability(mock.executor).rollback).toBeDefined();
    expect(createCodeDeployCapability(mock.executor).rollback).toBeDefined();
  });

  it("docker-build and publish-image declare no rollback by design (no remote/mutable state to compensate) — an explicit, documented opt-out, not silence", () => {
    const mock = createMockCloudExecutor();
    expect(createDockerBuildCapability(mock.executor).rollback).toBeUndefined();
    expect(createPublishImageCapability(mock.executor).rollback).toBeUndefined();
  });

  it("wait-for-stack / wait-steady-state / wait-cluster-healthy declare no rollback — read-only observation, nothing to compensate", () => {
    const mock = createMockCloudExecutor();
    expect(createWaitForStackCapability(mock.executor).rollback).toBeUndefined();
    expect(createWaitSteadyStateCapability(mock.executor).rollback).toBeUndefined();
    expect(createWaitClusterHealthyCapability(mock.executor).rollback).toBeUndefined();
  });

  it("the ALB/ECS pilot supplies its own explicit rollback phase (rollback-previous) precisely because ecs-update-service's own rollback is a best-effort re-apply, not a true prior-state restore", () => {
    // Documents the pilot-level opt-out this issue's acceptance criteria asks
    // for: the component, not the capability, owns the compensation here.
    expect(searchService.rollback).toBeDefined();
    expect(searchService.rollback![0]!.steps[0]).toMatchObject({ kind: "rollback-previous" });
  });

  it("the DynamoDB pilot declares no component-level rollback — a blocked replacement is a stop, not something to compensate (documented opt-out)", () => {
    expect(ordersTable.rollback).toBeUndefined();
  });
});
