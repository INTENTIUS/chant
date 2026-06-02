import { describe, test, expect, vi, beforeEach } from "vitest";

// Synchronous delivery (value, or Error for skipped kinds) avoids dangling
// unhandled rejections when a kind is missing / RBAC-denied.
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

const liveDeployment = {
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: { name: "web", namespace: "default", uid: "d-1" },
  spec: { replicas: 3, selector: { matchLabels: { app: "web" } } },
};

const emptyList = { stdout: JSON.stringify({ items: [] }), stderr: "" };

describe("k8s exportResources I/O glue (#160)", () => {
  beforeEach(() => execMock.mockReset());

  test("sweeps known kinds via `kubectl get <kind> -A -o json` and maps to IR", async () => {
    execMock.mockImplementation((cmd?: string) =>
      cmd?.includes("get deployment.apps")
        ? { stdout: JSON.stringify({ items: [liveDeployment] }), stderr: "" }
        : emptyList,
    );
    const ir = await exportResources({ environment: "prod" });
    const cmds = execMock.mock.calls.map((c) => c[0] as string).filter(Boolean);
    expect(cmds.every((c) => c.startsWith("kubectl get ") && c.endsWith("-A -o json"))).toBe(true);
    expect(cmds).toContain("kubectl get deployment.apps -A -o json");
    expect(ir.resources.map((r) => r.type)).toContain("K8s::Apps::Deployment");
  });

  test("a kind that errors is skipped; the rest of the sweep still maps", async () => {
    execMock.mockImplementation((cmd?: string) => {
      if (cmd?.includes("get secret ")) return new Error("Error from server (Forbidden)");
      if (cmd?.includes("get deployment.apps")) {
        return { stdout: JSON.stringify({ items: [liveDeployment] }), stderr: "" };
      }
      return emptyList;
    });
    const ir = await exportResources({ environment: "prod" });
    expect(ir.resources.map((r) => r.type)).toContain("K8s::Apps::Deployment");
  });

  test("a type selector narrows the sweep to a single kubectl get", async () => {
    execMock.mockImplementation(() => ({
      stdout: JSON.stringify({ items: [liveDeployment] }),
      stderr: "",
    }));
    await exportResources({ environment: "prod", selector: { type: "K8s::Apps::Deployment" } });
    expect(execMock.mock.calls.length).toBe(1);
    expect(execMock.mock.calls[0][0]).toBe("kubectl get deployment.apps -A -o json");
  });
});
