import { describe, test, expect, vi, afterEach } from "vitest";
import { ClusterBindingMismatchError } from "@intentius/chant/kubectl-context";
import { fakeCluster } from "../api/fake-cluster";
import { runLogs } from "./logs";
import { fakeDeclarable, fakeProjectContext } from "./testing";

afterEach(() => vi.restoreAllMocks());

function spyStdout() {
  return vi.spyOn(process.stdout, "write").mockImplementation(() => true);
}

function spyConsole() {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  return { log, error };
}

describe("chant kube logs (#1079)", () => {
  test("happy path: prints the pod's raw log text", async () => {
    const cluster = fakeCluster({
      respond: (req) =>
        req.path === "/api/v1/namespaces/prod/pods/web-abc/log" ? { body: "hello from the container\n" } : undefined,
    });
    const stdout = spyStdout();

    const code = await runLogs(["web-abc", "-n", "prod"], { connect: cluster.connector });

    expect(code).toBe(0);
    expect(stdout).toHaveBeenCalledWith("hello from the container\n");
  });

  test("--container/--tail/--since/--previous/--timestamps become query parameters", async () => {
    const cluster = fakeCluster({
      respond: (req) => (req.path === "/api/v1/namespaces/prod/pods/web-abc/log" ? { body: "x" } : undefined),
    });
    spyStdout();

    await runLogs(
      ["web-abc", "-n", "prod", "-c", "app", "--tail", "50", "--since", "1h", "-p", "--timestamps"],
      { connect: cluster.connector },
    );

    const req = cluster.layer.requests.find((r) => r.path === "/api/v1/namespaces/prod/pods/web-abc/log")!;
    expect(req.query).toEqual({ container: "app", tailLines: "50", sinceSeconds: "3600", previous: "true", timestamps: "true" });
  });

  test("resolves a declared entity name to its Pod, when the entity is a Pod", async () => {
    const cluster = fakeCluster({
      respond: (req) => (req.path === "/api/v1/namespaces/prod/pods/web-abc/log" ? { body: "log text" } : undefined),
    });
    const project = fakeProjectContext({
      myPod: fakeDeclarable("K8s::Core::Pod", { metadata: { name: "web-abc", namespace: "prod" } }),
    });
    const stdout = spyStdout();

    const code = await runLogs(["myPod"], { connect: cluster.connector, loadProject: async () => project });

    expect(code).toBe(0);
    expect(stdout).toHaveBeenCalledWith("log text\n");
  });

  test("a declared entity that is not a Pod is refused with a clear message", async () => {
    const project = fakeProjectContext({
      web: fakeDeclarable("K8s::Apps::Deployment", { metadata: { name: "web", namespace: "prod" } }),
    });
    const { error } = spyConsole();
    const connect = vi.fn();

    const code = await runLogs(["web"], { connect, loadProject: async () => project });

    expect(code).toBe(1);
    expect(error.mock.calls[0][0]).toContain("not a Pod");
    expect(connect).not.toHaveBeenCalled();
  });

  test("binding mismatch refuses loudly", async () => {
    const { error } = spyConsole();
    const connect = async () => {
      throw new ClusterBindingMismatchError("prod", "prod-eks", "dev-eks");
    };

    const code = await runLogs(["web-abc", "--env", "prod"], { connect });

    expect(code).toBe(1);
    expect(error.mock.calls[0][0]).toContain("no binding for this environment");
  });

  test("unknown flag is rejected before any connection", async () => {
    const { error } = spyConsole();
    const connect = vi.fn();

    const code = await runLogs(["web-abc", "--bogus"], { connect });

    expect(code).toBe(1);
    expect(error.mock.calls[0][0]).toContain("Unknown flag");
    expect(connect).not.toHaveBeenCalled();
  });

  test("tri-state: RBAC-denied log read renders NOT-OBSERVED, not empty output", async () => {
    const cluster = fakeCluster({
      respond: (req) =>
        req.path === "/api/v1/namespaces/prod/pods/web-abc/log"
          ? { status: 403, body: { kind: "Status", reason: "Forbidden", message: "pods/log is forbidden" } }
          : undefined,
    });
    const { error } = spyConsole();
    const stdout = spyStdout();

    const code = await runLogs(["web-abc", "-n", "prod"], { connect: cluster.connector });

    expect(code).toBe(1);
    expect(error.mock.calls[0][0]).toContain("no credentials");
    expect(stdout).not.toHaveBeenCalled();
  });

  test("a missing pod reports NotFound, kubectl-style", async () => {
    const cluster = fakeCluster({});
    const { error } = spyConsole();

    const code = await runLogs(["ghost", "-n", "prod"], { connect: cluster.connector });

    expect(code).toBe(1);
    expect(error.mock.calls[0][0]).toContain("NotFound");
  });
});
