import { describe, test, expect, vi, beforeEach } from "vitest";

// execMock returns either a {stdout,stderr} result or an Error. We deliver it
// via the callback on a microtask — never as a rejected promise — so a failure
// case can't leave a dangling unhandled rejection that masks the assertion.
const execMock = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    exec: (
      cmd: string,
      cb: (err: Error | null, out: { stdout: string; stderr: string }) => void,
    ) => {
      const r = execMock(cmd);
      queueMicrotask(() =>
        r instanceof Error
          ? cb(r, { stdout: "", stderr: "" })
          : cb(null, r as { stdout: string; stderr: string }),
      );
    },
  };
});

const { exportResources } = await import("./export-resources");

const liveTemplate = {
  $schema:
    "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
  contentVersion: "1.0.0.0",
  resources: [
    {
      type: "Microsoft.Storage/storageAccounts",
      apiVersion: "2021-09-01",
      name: "mystore",
      location: "eastus",
      properties: {},
    },
  ],
};

describe("azure exportResources I/O glue (#159 / #160)", () => {
  beforeEach(() => execMock.mockReset());

  test("runs `az group export` against the resource group and maps the body", async () => {
    execMock.mockReturnValue({ stdout: JSON.stringify(liveTemplate), stderr: "" });
    const ir = await exportResources({ environment: "prod-rg" });
    expect(execMock).toHaveBeenCalledTimes(1);
    const cmd = execMock.mock.calls[0][0] as string;
    expect(cmd).toContain("az group export");
    expect(cmd).toContain("--resource-group prod-rg");
    expect(cmd).toContain("--output json");
    expect(ir.resources.map((r) => r.logicalId)).toEqual(["mystore"]);
  });

  test("a failing az invocation throws with the stderr surfaced", async () => {
    execMock.mockReturnValue(
      Object.assign(new Error("exit 1"), { stderr: "ERROR: Please run 'az login'" }),
    );
    await expect(exportResources({ environment: "prod-rg" })).rejects.toThrow(
      /Failed to export resource group "prod-rg".*az login/,
    );
  });

  test("selector and owned flags are threaded through to the mapper", async () => {
    const mixed = {
      ...liveTemplate,
      resources: [
        {
          type: "Microsoft.Storage/storageAccounts",
          apiVersion: "2021-09-01",
          name: "mine",
          location: "eastus",
          tags: { "chant-managed-by": "chant" },
          properties: {},
        },
        {
          type: "Microsoft.Storage/storageAccounts",
          apiVersion: "2021-09-01",
          name: "theirs",
          location: "eastus",
          properties: {},
        },
      ],
    };
    execMock.mockReturnValue({ stdout: JSON.stringify(mixed), stderr: "" });
    const ir = await exportResources({ environment: "prod-rg", owned: true });
    expect(ir.resources.map((r) => r.logicalId)).toEqual(["mine"]);
  });
});
