/**
 * ECS tasks as runtime nodes owned by their service (#5448), against recorded
 * ECS `DescribeServices`, `ListTasks` and `DescribeTasks` responses
 * (`testdata/recorded-ecs/`). No AWS call is made: every request goes to a fake
 * `http`.
 */
import { describe, expect, test, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildLiveGraphIr } from "@intentius/chant/graph-ir";
import { buildChangeSet } from "@intentius/chant/lifecycle/change-set";
import type { AwsHealthHttp } from "./health";
import { ECS_TASKS_PER_SERVICE_CAP, currentTaskDefinition, observeEcsTasks, taskDefinitionRevision } from "./ecs-tasks";

const here = dirname(fileURLToPath(import.meta.url));
const recorded = (name: string): string => readFileSync(join(here, "testdata", "recorded-ecs", name), "utf-8");

const SERVICE = "arn:aws:ecs:eu-west-1:111122223333:service/prod-cluster/web";
const TASK_DEF_8 = "arn:aws:ecs:eu-west-1:111122223333:task-definition/web:8";

interface Call {
  target: string;
  payload: Record<string, unknown>;
  url: string;
}

/** Answers each ECS call by its `x-amz-target`, from the recorded files, and keeps what was asked. */
function recordedHttp(overrides: Record<string, { status: number; text: string }> = {}): { http: AwsHealthHttp; calls: Call[] } {
  const calls: Call[] = [];
  const http: AwsHealthHttp = async (_method, url, init) => {
    const target = (init.headers["x-amz-target"] ?? "").split(".").pop() ?? "";
    calls.push({ target, payload: JSON.parse(init.body ?? "{}") as Record<string, unknown>, url });
    if (overrides[target]) return overrides[target]!;
    const file = { DescribeServices: "describe-services.web.json", ListTasks: "list-tasks.web.json", DescribeTasks: "describe-tasks.web.json" }[target];
    return file ? { status: 200, text: recorded(file) } : { status: 400, text: JSON.stringify({ __type: "UnknownOperationException" }) };
  };
  return { http, calls };
}

const client = { env: {} };

afterEach(() => vi.restoreAllMocks());

describe("observeEcsTasks", () => {
  test("each task is a runtime node owned by its service, with its revision and last status", async () => {
    const { http, calls } = recordedHttp();
    const { resources, notes } = await observeEcsTasks([{ entity: "WebService", arn: SERVICE }], { http, client });
    expect(notes).toEqual([]);
    expect(Object.keys(resources).sort()).toEqual([
      "Task/prod-cluster/0a1b2c3d4e5f60718293a4b5c6d7e8f9",
      "Task/prod-cluster/1b2c3d4e5f60718293a4b5c6d7e8f900",
      "Task/prod-cluster/2c3d4e5f60718293a4b5c6d7e8f90011",
    ]);
    const running = resources["Task/prod-cluster/0a1b2c3d4e5f60718293a4b5c6d7e8f9"]!;
    expect(running).toMatchObject({
      type: "AWS::ECS::Task",
      physicalId: "arn:aws:ecs:eu-west-1:111122223333:task/prod-cluster/0a1b2c3d4e5f60718293a4b5c6d7e8f9",
      status: "RUNNING",
      ownership: "unknown",
      ownerChain: { root: "declared", entity: "WebService" },
    });
    expect(running.attributes).toMatchObject({
      cluster: "prod-cluster",
      service: "web",
      taskDefinitionFamily: "web",
      taskDefinitionRevision: 8,
      serviceTaskDefinitionRevision: 8,
      staleRevision: false,
      healthStatus: "HEALTHY",
      launchType: "FARGATE",
    });
    expect(running.lastUpdated).toBe("2026-01-01T00:00:30.456Z");

    // The ECS calls are reads, and each is made against the service's own cluster and region.
    expect(calls.map((c) => c.target)).toEqual(["DescribeServices", "ListTasks", "DescribeTasks"]);
    expect(calls.every((c) => c.url.includes("eu-west-1"))).toBe(true);
    expect(calls[1]!.payload).toMatchObject({ cluster: "prod-cluster", serviceName: "web" });
    expect(calls[2]!.payload.tasks).toHaveLength(3);
  });

  test("a task on an older revision than the service's current one is marked stale, as in a rolling deploy", async () => {
    const { resources } = await observeEcsTasks([{ entity: "WebService", arn: SERVICE }], { http: recordedHttp().http, client });
    const old = resources["Task/prod-cluster/1b2c3d4e5f60718293a4b5c6d7e8f900"]!;
    expect(old.attributes).toMatchObject({ taskDefinitionRevision: 7, serviceTaskDefinitionRevision: 8, staleRevision: true });
    expect(old.attributes?.serviceTaskDefinition).toBe(TASK_DEF_8);
    const pending = resources["Task/prod-cluster/2c3d4e5f60718293a4b5c6d7e8f90011"]!;
    expect(pending.status).toBe("PENDING");
    expect(pending.attributes).toMatchObject({ staleRevision: false });
  });

  test("a cap on tasks per service, and a note that says it applied", async () => {
    const { http } = recordedHttp();
    const { resources, notes } = await observeEcsTasks([{ entity: "WebService", arn: SERVICE }], { http, client, cap: 2 });
    expect(Object.keys(resources)).toHaveLength(2);
    expect(notes).toEqual(["[aws] ECS service web has more than 2 tasks; the first 2 are reported"]);
  });

  test("pages through ListTasks until the cap, and asks for no more than the API allows", async () => {
    const pages = [
      { taskArns: ["arn:aws:ecs:eu-west-1:111122223333:task/prod-cluster/a"], nextToken: "t1" },
      { taskArns: ["arn:aws:ecs:eu-west-1:111122223333:task/prod-cluster/b"] },
    ];
    const calls: Array<Record<string, unknown>> = [];
    const http: AwsHealthHttp = async (_m, _u, init) => {
      const target = (init.headers["x-amz-target"] ?? "").split(".").pop();
      const payload = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
      if (target === "ListTasks") {
        calls.push(payload);
        return { status: 200, text: JSON.stringify(pages[calls.length - 1]) };
      }
      if (target === "DescribeServices") return { status: 200, text: recorded("describe-services.web.json") };
      const tasks = (payload.tasks as string[]).map((taskArn) => ({ taskArn, taskDefinitionArn: TASK_DEF_8, lastStatus: "RUNNING" }));
      return { status: 200, text: JSON.stringify({ tasks }) };
    };
    const { resources, notes } = await observeEcsTasks([{ entity: "WebService", arn: SERVICE }], { http, client });
    expect(Object.keys(resources).sort()).toEqual(["Task/prod-cluster/a", "Task/prod-cluster/b"]);
    expect(notes).toEqual([]);
    expect(calls[1]).toMatchObject({ nextToken: "t1" });
    expect(Math.max(...calls.map((c) => Number(c.maxResults)))).toBeLessThanOrEqual(100);
    expect(ECS_TASKS_PER_SERVICE_CAP).toBe(100);
  });

  test("a service with no tasks reports none", async () => {
    const { http } = recordedHttp({ ListTasks: { status: 200, text: JSON.stringify({ taskArns: [] }) } });
    const { resources, notes } = await observeEcsTasks([{ entity: "WebService", arn: SERVICE }], { http, client });
    expect(resources).toEqual({});
    expect(notes).toEqual([]);
  });

  test("a service that cannot be read leaves a note and no node, and the others are still read", async () => {
    const denied = { status: 400, text: recorded("access-denied.json") };
    const { http } = recordedHttp({ ListTasks: denied });
    const { resources, notes } = await observeEcsTasks([{ entity: "WebService", arn: SERVICE }], { http, client });
    expect(resources).toEqual({});
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/tasks of ECS service web were not read: AccessDeniedException: .*ecs:ListTasks/);
  });
});

describe("what the tasks are to the live graph and the change set", () => {
  test("the live graph draws a task as a node whose runtime owner is the service", async () => {
    const { resources } = await observeEcsTasks([{ entity: "WebService", arn: SERVICE }], { http: recordedHttp().http, client });
    const ir = buildLiveGraphIr([{ lexicon: "aws", resources: { WebService: { type: "AWS::ECS::Service", physicalId: SERVICE, status: "CREATE_COMPLETE" }, ...resources } }]);
    const task = ir.nodes.find((n) => n.id === "Task/prod-cluster/0a1b2c3d4e5f60718293a4b5c6d7e8f9")!;
    expect(task.runtimeOwner).toBe("WebService");
    expect(task.physicalId).toContain(":task/prod-cluster/");
    expect(ir.nodes.find((n) => n.id === "WebService")!.runtimeOwner).toBeUndefined();
  });

  test("the change set reads an owned task as runtime, never an orphan to delete", async () => {
    const { resources } = await observeEcsTasks([{ entity: "WebService", arn: SERVICE }], { http: recordedHttp().http, client });
    const cs = buildChangeSet("prod", {
      declared: new Set(["WebService"]),
      observedNow: { WebService: { type: "AWS::ECS::Service", physicalId: SERVICE, status: "CREATE_COMPLETE" }, ...resources },
      observedThen: undefined,
    });
    const byName = Object.fromEntries(cs.entries.map((e) => [e.name, e.action]));
    expect(byName["Task/prod-cluster/0a1b2c3d4e5f60718293a4b5c6d7e8f9"]).toBe("runtime");
  });
});

describe("task definition ARNs", () => {
  test("the revision and the service's current definition", () => {
    expect(taskDefinitionRevision(TASK_DEF_8)).toBe(8);
    expect(taskDefinitionRevision(undefined)).toBeUndefined();
    expect(currentTaskDefinition({ taskDefinition: "x:1", deployments: [{ status: "ACTIVE", taskDefinition: "x:1" }, { status: "PRIMARY", taskDefinition: "x:2" }] })).toBe("x:2");
    expect(currentTaskDefinition({ taskDefinition: "x:1" })).toBe("x:1");
  });
});
