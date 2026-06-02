import { describe, test, expect, vi, beforeEach } from "vitest";

// Deliver exec results synchronously (value, or Error for the failure path) so
// a skipped kind can't leave a dangling unhandled rejection.
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

const liveBucket = {
  apiVersion: "storage.cnrm.cloud.google.com/v1beta1",
  kind: "StorageBucket",
  metadata: { name: "my-bucket", namespace: "default", uid: "u-1" },
  spec: { location: "US", storageClass: "STANDARD" },
};

describe("gcp exportResources I/O glue (#160)", () => {
  beforeEach(() => execMock.mockReset());

  test("discovers cnrm kinds, sweeps each with `kubectl get`, maps to IR", async () => {
    execMock.mockImplementation((cmd?: string) => {
      if (cmd?.includes("api-resources")) {
        return {
          stdout:
            "storagebuckets.storage.cnrm.cloud.google.com\n" +
            "pubsubtopics.pubsub.cnrm.cloud.google.com\n" +
            "pods\n",
          stderr: "",
        };
      }
      if (cmd?.includes("storagebuckets.storage.cnrm")) {
        return { stdout: JSON.stringify({ items: [liveBucket] }), stderr: "" };
      }
      return { stdout: JSON.stringify({ items: [] }), stderr: "" };
    });

    const ir = await exportResources({ environment: "prod" });
    const cmds = execMock.mock.calls.map((c) => c[0] as string);
    expect(cmds.some((c) => c === "kubectl api-resources -o name")).toBe(true);
    expect(
      cmds.some((c) => c === "kubectl get storagebuckets.storage.cnrm.cloud.google.com -A -o json"),
    ).toBe(true);
    // The non-cnrm "pods" line must be filtered out of the sweep.
    expect(cmds.some((c) => c.includes("kubectl get pods"))).toBe(false);
    expect(ir.resources.map((r) => r.logicalId)).toContain("my-bucket");
  });

  test("a kind that errors (absent / RBAC) is skipped; export still succeeds", async () => {
    execMock.mockImplementation((cmd?: string) => {
      if (cmd?.includes("api-resources")) {
        return { stdout: "computenetworks.compute.cnrm.cloud.google.com\n", stderr: "" };
      }
      return new Error("Error from server (Forbidden)");
    });
    const ir = await exportResources({ environment: "prod" });
    expect(ir.resources).toEqual([]);
  });

  test("no cnrm kinds discovered → empty export, no get calls", async () => {
    execMock.mockImplementation(() => ({ stdout: "pods\nservices\n", stderr: "" }));
    const ir = await exportResources({ environment: "prod" });
    expect(ir.resources).toEqual([]);
    expect(execMock.mock.calls.filter((c) => (c[0] as string).includes("get")).length).toBe(0);
  });
});
