import { describe, test, expect, vi, afterEach } from "vitest";
import { ClusterBindingMismatchError } from "@intentius/chant/kubectl-context";
import { fakeCluster, objectKey } from "../api/fake-cluster";
import { runWait } from "./wait";

afterEach(() => vi.restoreAllMocks());

function spyConsole() {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  return { log, error };
}

function certificate(ready: boolean) {
  return {
    apiVersion: "cert-manager.io/v1",
    kind: "Certificate",
    metadata: { name: "web-tls", namespace: "prod", uid: "u1" },
    status: { conditions: ready ? [{ type: "Ready", status: "True" }] : [{ type: "Ready", status: "False" }] },
  };
}

describe("chant kube wait (#1079)", () => {
  test("happy path: the registry's default Ready condition is satisfied immediately", async () => {
    const cluster = fakeCluster({
      objects: { [objectKey("cert-manager.io/v1", "Certificate", "web-tls", "prod")]: certificate(true) },
    });
    const { log } = spyConsole();

    const code = await runWait(["certificate", "web-tls", "-n", "prod"], { connect: cluster.connector });

    expect(code).toBe(0);
    expect(log.mock.calls[0][0]).toContain("condition met");
  });

  test("--for=condition=<Type>=<Status> overrides the registry", async () => {
    const cluster = fakeCluster({
      objects: {
        [objectKey("apps/v1", "Deployment", "web", "prod")]: {
          apiVersion: "apps/v1",
          kind: "Deployment",
          metadata: { name: "web", namespace: "prod", uid: "u1" },
          status: { conditions: [{ type: "Available", status: "True" }] },
        },
      },
    });
    const { log } = spyConsole();

    const code = await runWait(["deployment", "web", "-n", "prod", "--for=condition=Available"], {
      connect: cluster.connector,
    });

    expect(code).toBe(0);
    expect(log.mock.calls[0][0]).toContain("condition met");
  });

  test("--for=delete polls for absence", async () => {
    const cluster = fakeCluster({});
    const { log } = spyConsole();

    const code = await runWait(["deployment", "ghost", "-n", "prod", "--for=delete", "--timeout=5s"], {
      connect: cluster.connector,
    });

    expect(code).toBe(0);
    expect(log.mock.calls[0][0]).toContain("deleted");
  });

  test("a resource that never becomes ready times out honestly", async () => {
    const cluster = fakeCluster({
      objects: { [objectKey("cert-manager.io/v1", "Certificate", "web-tls", "prod")]: certificate(false) },
    });
    const { error } = spyConsole();

    const code = await runWait(["certificate", "web-tls", "-n", "prod", "--timeout=1s"], { connect: cluster.connector });

    expect(code).toBe(1);
    expect(error.mock.calls[0][0]).toContain("timed out");
  }, 10_000);

  test("binding mismatch refuses loudly, before any wait loop starts", async () => {
    const { error } = spyConsole();
    const connect = async () => {
      throw new ClusterBindingMismatchError("prod", "prod-eks", "dev-eks");
    };

    const code = await runWait(["deployment", "web", "--env", "prod"], { connect });

    expect(code).toBe(1);
    expect(error.mock.calls[0][0]).toContain("no binding for this environment");
  });

  test("unknown flag is rejected before any connection", async () => {
    const { error } = spyConsole();
    const connect = vi.fn();

    const code = await runWait(["deployment", "web", "--bogus"], { connect });

    expect(code).toBe(1);
    expect(error.mock.calls[0][0]).toContain("Unknown flag");
    expect(connect).not.toHaveBeenCalled();
  });

  test("wait requires a single named resource", async () => {
    const { error } = spyConsole();
    const connect = vi.fn();

    const code = await runWait(["deployment"], { connect });

    expect(code).toBe(1);
    expect(error.mock.calls[0][0]).toContain("requires a single named resource");
    expect(connect).not.toHaveBeenCalled();
  });

  test("tri-state: a kind the cluster does not serve renders an explicit error", async () => {
    const cluster = fakeCluster({ serves: [] });
    const { error, log } = spyConsole();

    const code = await runWait(["widgets", "gizmo"], { connect: cluster.connector });

    expect(code).toBe(1);
    expect(error.mock.calls[0][0]).toContain(`doesn't have a resource type "widgets"`);
    expect(log).not.toHaveBeenCalled();
  });
});
