import { describe, test, expect, vi, beforeEach } from "vitest";

const execMock = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, exec: (cmd: string, cb: (err: Error | null, out: { stdout: string; stderr: string }) => void) => {
    Promise.resolve(execMock(cmd)).then(
      (out) => cb(null, out),
      (err) => cb(err as Error, { stdout: "", stderr: "" }),
    );
  } };
});

const { describeResources } = await import("./describe-resources");

function makeEntities(records: Array<{ name: string; entityType: string; props: Record<string, unknown> }>) {
  return new Map(records.map((r) => [r.name, { entityType: r.entityType, props: r.props }]));
}

describe("gcp describeResources (Config Connector)", () => {
  beforeEach(() => {
    execMock.mockReset();
  });

  test("queries kubectl with the derived CC GVK and maps the response", async () => {
    let receivedCmd = "";
    execMock.mockImplementation((cmd: string) => {
      receivedCmd = cmd;
      return {
        stdout: JSON.stringify({
          metadata: { name: "data-bucket", namespace: "config-control", uid: "uid-1", creationTimestamp: "2026-05-01T00:00:00Z" },
          status: { conditions: [{ type: "Ready", status: "True" }] },
        }),
        stderr: "",
      };
    });

    const entities = makeEntities([
      { name: "dataBucket", entityType: "GCP::Storage::Bucket", props: { metadata: { name: "data-bucket", namespace: "config-control" } } },
    ]);

    const result = await describeResources({ environment: "prod", buildOutput: "", entityNames: ["dataBucket"], entities });

    // Resource name follows: <lowerKind>.<service>.cnrm.cloud.google.com
    expect(receivedCmd).toContain("storagebucket.storage.cnrm.cloud.google.com");
    expect(receivedCmd).toContain("data-bucket");
    expect(receivedCmd).toContain("-n config-control");

    expect(result["dataBucket"]).toMatchObject({
      type: "GCP::Storage::Bucket",
      physicalId: "uid-1",
      status: "READY",
    });
  });

  test("Compute resource derives correct GVK with service prefix", async () => {
    let receivedCmd = "";
    execMock.mockImplementation((cmd: string) => {
      receivedCmd = cmd;
      return {
        stdout: JSON.stringify({
          metadata: { name: "subnet-1", uid: "uid", creationTimestamp: "t" },
          status: { conditions: [{ type: "Ready", status: "True" }] },
        }),
        stderr: "",
      };
    });

    const entities = makeEntities([
      { name: "sub", entityType: "GCP::Compute::Subnetwork", props: { metadata: { name: "subnet-1" } } },
    ]);

    await describeResources({ environment: "prod", buildOutput: "", entityNames: ["sub"], entities });

    expect(receivedCmd).toContain("computesubnetwork.compute.cnrm.cloud.google.com");
  });

  test("Ready=False maps to the condition's reason", async () => {
    execMock.mockResolvedValue({
      stdout: JSON.stringify({
        metadata: { name: "x", uid: "uid", creationTimestamp: "t" },
        status: { conditions: [{ type: "Ready", status: "False", reason: "DependencyNotFound", message: "..." }] },
      }),
      stderr: "",
    });

    const entities = makeEntities([
      { name: "x", entityType: "GCP::Storage::Bucket", props: { metadata: { name: "x" } } },
    ]);

    const result = await describeResources({ environment: "prod", buildOutput: "", entityNames: ["x"], entities });

    expect(result["x"].status).toBe("DependencyNotFound");
  });

  test("missing Ready condition falls back to PRESENT", async () => {
    execMock.mockResolvedValue({
      stdout: JSON.stringify({
        metadata: { name: "x", uid: "uid", creationTimestamp: "t" },
        status: {},
      }),
      stderr: "",
    });

    const entities = makeEntities([
      { name: "x", entityType: "GCP::Storage::Bucket", props: { metadata: { name: "x" } } },
    ]);

    const result = await describeResources({ environment: "prod", buildOutput: "", entityNames: ["x"], entities });

    expect(result["x"].status).toBe("PRESENT");
  });

  test("kubectl-not-found leaves entity out of result", async () => {
    execMock.mockImplementation(() => { throw new Error('Error from server (NotFound): storagebucket "x" not found'); });

    const entities = makeEntities([
      { name: "x", entityType: "GCP::Storage::Bucket", props: { metadata: { name: "x" } } },
    ]);

    const result = await describeResources({ environment: "prod", buildOutput: "", entityNames: ["x"], entities });

    expect(result).toEqual({});
  });

  test("non-GCP entity types are skipped", async () => {
    const entities = makeEntities([
      { name: "x", entityType: "AWS::S3::Bucket", props: { metadata: { name: "x" } } },
    ]);

    const result = await describeResources({ environment: "prod", buildOutput: "", entityNames: ["x"], entities });

    expect(result).toEqual({});
    expect(execMock).not.toHaveBeenCalled();
  });

  test("entity without metadata.name is silently skipped", async () => {
    const entities = makeEntities([
      { name: "broken", entityType: "GCP::Storage::Bucket", props: {} },
    ]);

    const result = await describeResources({ environment: "prod", buildOutput: "", entityNames: ["broken"], entities });

    expect(result).toEqual({});
    expect(execMock).not.toHaveBeenCalled();
  });
});
