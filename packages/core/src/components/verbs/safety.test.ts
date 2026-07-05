import { describe, expect, it } from "vitest";
import { createSnapshotBeforeCapability } from "./safety";
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
