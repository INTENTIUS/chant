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

describe("azure describeResources", () => {
  beforeEach(() => {
    execMock.mockReset();
  });

  test("queries az resource show with rg + name + type and maps response", async () => {
    let receivedCmd = "";
    execMock.mockImplementation((cmd: string) => {
      receivedCmd = cmd;
      return {
        stdout: JSON.stringify({
          id: "/subscriptions/sub/resourceGroups/prod-rg/providers/Microsoft.Storage/storageAccounts/mydata",
          name: "mydata",
          type: "Microsoft.Storage/storageAccounts",
          location: "eastus",
          properties: { provisioningState: "Succeeded" },
          tags: { env: "prod" },
        }),
        stderr: "",
      };
    });

    const entities = makeEntities([
      { name: "dataAccount", entityType: "Microsoft.Storage/storageAccounts", props: { name: "mydata" } },
    ]);

    const result = await describeResources({ environment: "prod-rg", buildOutput: "", entityNames: ["dataAccount"], entities });

    expect(receivedCmd).toContain("az resource show");
    expect(receivedCmd).toContain("--resource-group prod-rg");
    expect(receivedCmd).toContain("--name mydata");
    expect(receivedCmd).toContain("--resource-type Microsoft.Storage/storageAccounts");

    expect(result.resources["dataAccount"]).toMatchObject({
      type: "Microsoft.Storage/storageAccounts",
      physicalId: "/subscriptions/sub/resourceGroups/prod-rg/providers/Microsoft.Storage/storageAccounts/mydata",
      status: "Succeeded",
      attributes: expect.objectContaining({ location: "eastus", tags: { env: "prod" } }),
    });
  });

  test("missing provisioningState falls back to PRESENT", async () => {
    execMock.mockResolvedValue({
      stdout: JSON.stringify({ id: "id", name: "x", type: "Microsoft.Network/virtualNetworks", location: "eastus", properties: {} }),
      stderr: "",
    });

    const entities = makeEntities([
      { name: "vnet", entityType: "Microsoft.Network/virtualNetworks", props: { name: "x" } },
    ]);

    const result = await describeResources({ environment: "prod-rg", buildOutput: "", entityNames: ["vnet"], entities });

    expect(result.resources["vnet"].status).toBe("PRESENT");
  });

  test("az failure (resource not found) leaves entity out — a confirmed absence", async () => {
    execMock.mockImplementation(() => { throw new Error("ResourceNotFound: ..."); });

    const entities = makeEntities([
      { name: "missing", entityType: "Microsoft.Storage/storageAccounts", props: { name: "missing" } },
    ]);

    const result = await describeResources({ environment: "prod-rg", buildOutput: "", entityNames: ["missing"], entities });

    expect(result.resources).toEqual({});
    expect(result.unobserved ?? {}).toEqual({});
  });

  test("an expired az login is unobserved, not absent (#1089)", async () => {
    execMock.mockImplementation(() => {
      throw Object.assign(new Error("az failed"), {
        stderr: "Please run 'az login' to setup account.",
      });
    });

    const entities = makeEntities([
      { name: "acct", entityType: "Microsoft.Storage/storageAccounts", props: { name: "acct" } },
    ]);

    const result = await describeResources({ environment: "prod-rg", buildOutput: "", entityNames: ["acct"], entities });

    expect(result.resources).toEqual({});
    expect(result.unobserved?.acct?.reason).toBe("no-credentials");
  });

  test("nested-type entities are unobserved, not absent (#1089)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const entities = makeEntities([
      { name: "nested", entityType: "Microsoft.Storage/storageAccounts/blobServices", props: { name: "x" } },
    ]);

    const result = await describeResources({ environment: "prod-rg", buildOutput: "", entityNames: ["nested"], entities });

    expect(result.resources).toEqual({});
    expect(result.unobserved?.nested).toMatchObject({
      type: "Microsoft.Storage/storageAccounts/blobServices",
      reason: "unsupported-kind",
    });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("nested-type"));
    expect(execMock).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test("non-Azure entity types are unobserved — no ARM type to query", async () => {
    const entities = makeEntities([
      { name: "x", entityType: "AWS::S3::Bucket", props: { name: "x" } },
    ]);

    const result = await describeResources({ environment: "prod-rg", buildOutput: "", entityNames: ["x"], entities });

    expect(result.resources).toEqual({});
    expect(result.unobserved?.x?.reason).toBe("unsupported-kind");
    expect(execMock).not.toHaveBeenCalled();
  });

  test("entity without name is unobserved — nothing was queried", async () => {
    const entities = makeEntities([
      { name: "broken", entityType: "Microsoft.Storage/storageAccounts", props: {} },
    ]);

    const result = await describeResources({ environment: "prod-rg", buildOutput: "", entityNames: ["broken"], entities });

    expect(result.resources).toEqual({});
    expect(result.unobserved?.broken?.reason).toBe("read-failed");
    expect(execMock).not.toHaveBeenCalled();
  });
});
