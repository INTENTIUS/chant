import { describe, expect, it } from "vitest";
import { createSnapshotBeforeCapability, createRollbackPreviousCapability } from "./safety";
import { createMockCloudExecutor } from "./__tests__/mock-cloud-executor";

const ctx = { env: "dev", component: "orders" };

describe("snapshot-before (#557)", () => {
  it("dispatches to the executor's snapshot.create with the resource + kind, returning the snapshotId", async () => {
    const mock = createMockCloudExecutor();
    const out = await createSnapshotBeforeCapability(mock.executor).run(ctx, {
      resource: "orders-table",
      resourceKind: "dynamodb-table",
    });
    expect(out.snapshotId).toBe("snap-mock-dynamodb-table-orders-table");
    expect(mock.calls).toEqual([
      { client: "snapshot", method: "create", args: { resource: "orders-table", resourceKind: "dynamodb-table" } },
    ]);
  });

  it("passes the kind through for rds/ebs so the executor selects the right mechanism", async () => {
    const mock = createMockCloudExecutor();
    await createSnapshotBeforeCapability(mock.executor).run(ctx, { resource: "prod-db", resourceKind: "rds-instance" });
    expect(mock.calls[0]!.args).toEqual({ resource: "prod-db", resourceKind: "rds-instance" });
  });

  it("declares no rollback — the snapshot it takes IS the rollback artifact", () => {
    expect(createSnapshotBeforeCapability(createMockCloudExecutor().executor).rollback).toBeUndefined();
  });
});

describe("rollback-previous (#557)", () => {
  it("restores the resource from the given snapshot via the executor, returning restored: true", async () => {
    const mock = createMockCloudExecutor();
    const out = await createRollbackPreviousCapability(mock.executor).run(ctx, {
      resource: "orders-table",
      snapshotId: "arn:aws:dynamodb:us-east-2:1:table/orders-table/backup/abc",
    });
    expect(out).toEqual({ restored: true });
    expect(mock.calls).toEqual([
      { client: "snapshot", method: "restore", args: { resource: "orders-table", snapshotId: "arn:aws:dynamodb:us-east-2:1:table/orders-table/backup/abc" } },
    ]);
  });

  it("rolls an ECS service back to the named taskDefinition for the {service, cluster} shape (#990)", async () => {
    // An ECS-shaped input used to reach the snapshot path and throw "Cannot
    // read properties of undefined (reading 'includes')" on the absent snapshotId.
    const mock = createMockCloudExecutor();
    const out = await createRollbackPreviousCapability(mock.executor).run(ctx, {
      service: "loom-frontend-svc",
      cluster: "arn:aws:ecs:us-east-1:1:cluster/loom",
      taskDefinition: "loom-frontend:41",
    });
    expect(out).toEqual({ restored: true });
    expect(mock.calls).toEqual([
      { client: "ecs", method: "rollbackService", args: { cluster: "arn:aws:ecs:us-east-1:1:cluster/loom", service: "loom-frontend-svc", taskDefinition: "loom-frontend:41", desiredCount: undefined } },
    ]);
  });

  it("fails for an ECS service without a taskDefinition instead of reporting restored (#2605)", async () => {
    const mock = createMockCloudExecutor();
    await expect(
      createRollbackPreviousCapability(mock.executor).run(ctx, { service: "loom-frontend-svc", cluster: "loom" }),
    ).rejects.toThrow(/needs a taskDefinition to roll back to/);
    expect(mock.calls).toEqual([]);
  });

  it("fails with a clear message (not a cryptic undefined access) for an unrecognized shape", async () => {
    const cap = createRollbackPreviousCapability(createMockCloudExecutor().executor);
    await expect(cap.run(ctx, {} as never)).rejects.toThrow(/expected \{ service, cluster \}|\{ snapshotId, resource \}/);
  });

  it("declares no rollback — it is the rollback", () => {
    expect(createRollbackPreviousCapability(createMockCloudExecutor().executor).rollback).toBeUndefined();
  });
});
