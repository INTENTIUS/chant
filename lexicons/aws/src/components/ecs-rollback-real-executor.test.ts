import { beforeEach, describe, expect, it, vi } from "vitest";

// The real executor shells out through `exec`; record each command and answer
// `aws ecs update-service` with a minimal service, so these tests run the real
// executor's argument checks without an `aws` CLI (#2605).
const execMock = vi.fn<(cmd: string) => { stdout: string; stderr: string }>();

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    exec: (
      cmd: string,
      optsOrCb: unknown,
      maybeCb?: (err: Error | null, out: { stdout: string; stderr: string }) => void,
    ) => {
      const cb = (typeof optsOrCb === "function" ? optsOrCb : maybeCb) as (
        err: Error | null,
        out: { stdout: string; stderr: string },
      ) => void;
      try {
        cb(null, execMock(cmd));
      } catch (err) {
        cb(err as Error, { stdout: "", stderr: "" });
      }
    },
  };
});

const { realCloudExecutor } = await import("./cloud-executor");
const { createRollbackPreviousCapability } = await import("./safety");
const { createEcsUpdateServiceCapability } = await import("./apply");

const ctx = { env: "dev", component: "search-service" };
const updateServiceReply = { stdout: JSON.stringify({ service: { deployments: [{ id: "ecs-svc/1" }] } }), stderr: "" };
const describeServicesReply = {
  stdout: JSON.stringify({
    services: [{ runningCount: 2, desiredCount: 2, deployments: [{}], taskDefinition: "arn:aws:ecs:us-east-1:1:task-definition/search:6" }],
  }),
  stderr: "",
};

beforeEach(() => {
  execMock.mockReset();
  execMock.mockImplementation((cmd) => (cmd.includes("describe-services") ? describeServicesReply : updateServiceReply));
});

describe("real ECS executor argument checks (#2605)", () => {
  it("rollbackService without a taskDefinition throws and runs no aws command", async () => {
    const executor = realCloudExecutor();
    await expect(executor.ecs.rollbackService({ cluster: "prod", service: "search", desiredCount: 2 })).rejects.toThrow(
      /needs the taskDefinition to roll back to/,
    );
    expect(execMock).not.toHaveBeenCalled();
  });

  it("the forward updateService keeps accepting the preset's { cluster, service } shape", async () => {
    // The ECS preset and the ALB/ECS pilot run ecs-update-service after a
    // cfn-deploy that already changed the task definition; that forward step
    // is unchanged here.
    const out = await createEcsUpdateServiceCapability(realCloudExecutor()).run(ctx, { cluster: "prod", service: "search" });
    expect(out.deploymentId).toBe("ecs-svc/1");
    expect(execMock).toHaveBeenCalledTimes(2);
    expect(execMock.mock.calls[1]![0]).toMatch(/ecs update-service /);
    expect(execMock.mock.calls[1]![0]).not.toMatch(/--task-definition/);
  });
});

describe("rollback-previous on the real executor (#2605)", () => {
  it("an ECS service without a taskDefinition fails and changes nothing", async () => {
    const cap = createRollbackPreviousCapability(realCloudExecutor());
    await expect(cap.run(ctx, { service: "search", cluster: "prod" })).rejects.toThrow(
      /rollback-previous: ECS service "search" needs a taskDefinition to roll back to/,
    );
    expect(execMock).not.toHaveBeenCalled();
  });

  it("an ECS service with a taskDefinition runs update-service with it and reports restored", async () => {
    const cap = createRollbackPreviousCapability(realCloudExecutor());
    const out = await cap.run(ctx, { service: "search", cluster: "prod", taskDefinition: "search:41" });
    expect(out).toEqual({ restored: true });
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(execMock.mock.calls[0]![0]).toMatch(/ecs update-service .*--task-definition '?search:41'?/);
  });
});

describe("ecs-update-service rollback on the real executor (#2605, #2609)", () => {
  it("run reads the running task definition before update-service, and rollback sends that one, not the imageRef", async () => {
    const cap = createEcsUpdateServiceCapability(realCloudExecutor());
    const input = { cluster: "prod", service: "search", imageRef: "search:7" };
    const out = await cap.run(ctx, input);
    expect(execMock.mock.calls.map((c) => c[0].split(" ").slice(0, 3).join(" "))).toEqual([
      "aws ecs describe-services",
      "aws ecs update-service",
    ]);
    expect(execMock.mock.calls[1]![0]).toMatch(/--task-definition '?search:7'?/);
    expect(out.previousTaskDefinition).toBe("arn:aws:ecs:us-east-1:1:task-definition/search:6");

    execMock.mockClear();
    await cap.rollback!(ctx, input, out);
    expect(execMock).toHaveBeenCalledTimes(1);
    const sent = execMock.mock.calls[0]![0];
    expect(sent).toMatch(/ecs update-service .*--task-definition '?arn:aws:ecs:us-east-1:1:task-definition\/search:6'?/);
    expect(sent).not.toMatch(/search:7/);
  });

  it("when describe-services fails, the update still runs and the rollback fails naming the service", async () => {
    execMock.mockImplementation((cmd) => {
      if (cmd.includes("describe-services")) throw new Error("AccessDeniedException: ecs:DescribeServices");
      return updateServiceReply;
    });
    const cap = createEcsUpdateServiceCapability(realCloudExecutor());
    const input = { cluster: "prod", service: "search", imageRef: "search:7" };
    const out = await cap.run(ctx, input);
    expect(out).toEqual({ deploymentId: "ecs-svc/1" });

    execMock.mockClear();
    await expect(cap.rollback!(ctx, input, out)).rejects.toThrow(
      /ecs-update-service rollback: the task definition service "search" ran before the step was not recorded/,
    );
    expect(execMock).not.toHaveBeenCalled();
  });

  it("when describe-services reports no task definition, the rollback fails and runs no aws command", async () => {
    execMock.mockImplementation((cmd) =>
      cmd.includes("describe-services") ? { stdout: JSON.stringify({ services: [] }), stderr: "" } : updateServiceReply,
    );
    const cap = createEcsUpdateServiceCapability(realCloudExecutor());
    const input = { cluster: "prod", service: "search", imageRef: "search:7" };
    const out = await cap.run(ctx, input);
    execMock.mockClear();
    await expect(cap.rollback!(ctx, input, out)).rejects.toThrow(/service "search" ran before the step was not recorded/);
    expect(execMock).not.toHaveBeenCalled();
  });
});
