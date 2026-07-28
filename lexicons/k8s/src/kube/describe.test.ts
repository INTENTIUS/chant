import { describe, test, expect, vi, afterEach } from "vitest";
import { ClusterBindingMismatchError } from "@intentius/chant/kubectl-context";
import { fakeCluster, objectKey } from "../api/fake-cluster";
import { runDescribe } from "./describe";
import { fakeDeclarable, fakeProjectContext } from "./testing";

afterEach(() => vi.restoreAllMocks());

function spyConsole() {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  return { log, error };
}

describe("chant kube describe (#1079)", () => {
  test("happy path: prints identity, chant section, spec/status, and an events section", async () => {
    const cluster = fakeCluster({
      objects: {
        [objectKey("apps/v1", "Deployment", "web", "prod")]: {
          apiVersion: "apps/v1",
          kind: "Deployment",
          metadata: { name: "web", namespace: "prod", uid: "u1", labels: { app: "web" } },
          spec: { replicas: 2 },
          status: { readyReplicas: 2, replicas: 2 },
        },
      },
    });
    const { log } = spyConsole();

    const code = await runDescribe(["deployment", "web", "-n", "prod"], { connect: cluster.connector });

    expect(code).toBe(0);
    const out = log.mock.calls.map((c) => c[0]).join("\n");
    expect(out).toContain("Name:         web");
    expect(out).toContain("Namespace:    prod");
    expect(out).toContain("Chant:");
    expect(out).toContain("Verdict:    unavailable");
    expect(out).toContain("Spec:");
    expect(out).toContain("Events:");
  });

  test("with a project, a matched entity's verdict and source are reported", async () => {
    const cluster = fakeCluster({
      objects: {
        [objectKey("apps/v1", "Deployment", "web", "prod")]: {
          apiVersion: "apps/v1",
          kind: "Deployment",
          metadata: { name: "web", namespace: "prod", uid: "u1" },
          spec: { replicas: 2 },
        },
      },
    });
    const project = fakeProjectContext({
      web: fakeDeclarable(
        "K8s::Apps::Deployment",
        { metadata: { name: "web", namespace: "prod" }, spec: { replicas: 2 } },
        { sourceFile: "/project/src/infra.ts", composite: "WebApp" },
      ),
    });
    const { log } = spyConsole();

    await runDescribe(["deployment", "web", "-n", "prod"], { connect: cluster.connector, loadProject: async () => project });

    const out = log.mock.calls.map((c) => c[0]).join("\n");
    expect(out).toContain("Verdict:    declared");
    expect(out).toContain("Entity:     web");
    expect(out).toContain("src/infra.ts");
    expect(out).toContain("via WebApp");
  });

  test("binding mismatch renders NOT-OBSERVED", async () => {
    const { error } = spyConsole();
    const connect = async () => {
      throw new ClusterBindingMismatchError("prod", "prod-eks", "dev-eks");
    };

    const code = await runDescribe(["deployment", "web", "--env", "prod"], { connect });

    expect(code).toBe(1);
    expect(error.mock.calls[0][0]).toContain("no binding for this environment");
  });

  test("unknown flag is rejected", async () => {
    const { error } = spyConsole();
    const connect = vi.fn();

    const code = await runDescribe(["deployment", "web", "--bogus"], { connect });

    expect(code).toBe(1);
    expect(error.mock.calls[0][0]).toContain("Unknown flag");
    expect(connect).not.toHaveBeenCalled();
  });

  test("tri-state: a 500 on discovery renders NOT-OBSERVED, not an empty page", async () => {
    const cluster = fakeCluster({
      respond: (req) => (req.path === "/apis" ? { status: 500, body: { kind: "Status", message: "etcd unavailable" } } : undefined),
    });
    const { error, log } = spyConsole();

    const code = await runDescribe(["deployment", "web"], { connect: cluster.connector });

    expect(code).toBe(1);
    expect(error.mock.calls[0][0]).toContain("read failed");
    expect(log).not.toHaveBeenCalled();
  });
});
