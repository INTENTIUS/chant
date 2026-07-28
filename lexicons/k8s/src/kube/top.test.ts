import { describe, test, expect, vi, afterEach } from "vitest";
import { ClusterBindingMismatchError } from "@intentius/chant/kubectl-context";
import { fakeCluster } from "../api/fake-cluster";
import { runTop } from "./top";

afterEach(() => vi.restoreAllMocks());

function spyConsole() {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  return { log, error };
}

const METRICS_DISCOVERY = {
  path: "/apis/metrics.k8s.io/v1beta1",
  body: {
    kind: "APIResourceList",
    apiVersion: "v1",
    groupVersion: "metrics.k8s.io/v1beta1",
    resources: [
      { name: "pods", singularName: "", namespaced: true, kind: "PodMetrics", verbs: ["get", "list"] },
      { name: "nodes", singularName: "", namespaced: false, kind: "NodeMetrics", verbs: ["get", "list"] },
    ],
  },
};

function withMetricsGroup(respond: (req: { path: string }) => { status?: number; body?: unknown } | undefined) {
  return (req: { path: string }) => {
    if (req.path === "/apis") {
      return {
        body: {
          kind: "APIGroupList",
          groups: [
            {
              name: "metrics.k8s.io",
              preferredVersion: { groupVersion: "metrics.k8s.io/v1beta1" },
              versions: [{ groupVersion: "metrics.k8s.io/v1beta1" }],
            },
          ],
        },
      };
    }
    if (req.path === METRICS_DISCOVERY.path) return { body: METRICS_DISCOVERY.body };
    return respond(req);
  };
}

describe("chant kube top (#1079)", () => {
  test("happy path: pods usage, per container, unsummed", async () => {
    const cluster = fakeCluster({
      serves: [],
      respond: withMetricsGroup((req) =>
        req.path === "/apis/metrics.k8s.io/v1beta1/namespaces/prod/pods"
          ? {
              body: {
                items: [
                  {
                    metadata: { name: "web", namespace: "prod" },
                    containers: [{ name: "app", usage: { cpu: "250m", memory: "128Mi" } }],
                  },
                ],
              },
            }
          : undefined,
      ),
    });
    const { log } = spyConsole();

    const code = await runTop(["pods", "-n", "prod"], { connect: cluster.connector });

    expect(code).toBe(0);
    const out = log.mock.calls[0][0] as string;
    expect(out).toContain("web");
    expect(out).toContain("app:250m");
    expect(out).toContain("app:128Mi");
  });

  test("nodes usage", async () => {
    const cluster = fakeCluster({
      serves: [],
      respond: withMetricsGroup((req) =>
        req.path === "/apis/metrics.k8s.io/v1beta1/nodes"
          ? { body: { items: [{ metadata: { name: "node-1" }, usage: { cpu: "500m", memory: "2Gi" } }] } }
          : undefined,
      ),
    });
    const { log } = spyConsole();

    const code = await runTop(["nodes"], { connect: cluster.connector });

    expect(code).toBe(0);
    const out = log.mock.calls[0][0] as string;
    expect(out).toContain("node-1");
    expect(out).toContain("500m");
    expect(out).toContain("2Gi");
  });

  test("metrics-server absent renders a clear message, not an empty table", async () => {
    const cluster = fakeCluster({ serves: [] });
    const { error, log } = spyConsole();

    const code = await runTop(["pods"], { connect: cluster.connector });

    expect(code).toBe(1);
    expect(error.mock.calls[0][0]).toContain("metrics-server");
    expect(log).not.toHaveBeenCalled();
  });

  test("binding mismatch refuses loudly", async () => {
    const { error } = spyConsole();
    const connect = async () => {
      throw new ClusterBindingMismatchError("prod", "prod-eks", "dev-eks");
    };

    const code = await runTop(["pods", "--env", "prod"], { connect });

    expect(code).toBe(1);
    expect(error.mock.calls[0][0]).toContain("no binding for this environment");
  });

  test("unknown flag is rejected before any connection", async () => {
    const { error } = spyConsole();
    const connect = vi.fn();

    const code = await runTop(["pods", "--bogus"], { connect });

    expect(code).toBe(1);
    expect(error.mock.calls[0][0]).toContain("Unknown flag");
    expect(connect).not.toHaveBeenCalled();
  });

  test("tri-state: an RBAC-denied metrics read renders NOT-OBSERVED", async () => {
    const cluster = fakeCluster({
      serves: [],
      respond: withMetricsGroup((req) =>
        req.path === "/apis/metrics.k8s.io/v1beta1/namespaces/prod/pods"
          ? { status: 403, body: { kind: "Status", reason: "Forbidden", message: "forbidden" } }
          : undefined,
      ),
    });
    const { error, log } = spyConsole();

    const code = await runTop(["pods", "-n", "prod"], { connect: cluster.connector });

    expect(code).toBe(1);
    expect(error.mock.calls[0][0]).toContain("no credentials");
    expect(log).not.toHaveBeenCalled();
  });
});
