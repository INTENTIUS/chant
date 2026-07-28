import { describe, test, expect, vi, afterEach } from "vitest";
import { ClusterBindingMismatchError } from "@intentius/chant/kubectl-context";
import { fakeCluster, objectKey } from "../api/fake-cluster";
import { runSource } from "./source";
import { fakeDeclarable, fakeProjectContext } from "./testing";

afterEach(() => vi.restoreAllMocks());

function spyConsole() {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  return { log, error };
}

describe("chant kube source (#1079)", () => {
  test("happy path: resolves a live object to its declaring file and composite", async () => {
    const cluster = fakeCluster({
      objects: {
        [objectKey("apps/v1", "Deployment", "web", "prod")]: {
          apiVersion: "apps/v1",
          kind: "Deployment",
          metadata: { name: "web", namespace: "prod", uid: "u1" },
        },
      },
    });
    const project = fakeProjectContext({
      web: fakeDeclarable(
        "K8s::Apps::Deployment",
        { metadata: { name: "web", namespace: "prod" } },
        { sourceFile: "/project/src/infra.ts", composite: "WebApp", compositeInstance: "web" },
      ),
    });
    const { log } = spyConsole();

    const code = await runSource(["deployment", "web", "-n", "prod"], { connect: cluster.connector, loadProject: async () => project });

    expect(code).toBe(0);
    const out = log.mock.calls.map((c) => c[0]).join("\n");
    expect(out).toContain("web <- web");
    expect(out).toContain("src/infra.ts");
    expect(out).toContain("composite: WebApp");
    expect(out).toContain("line:      not tracked");
  });

  test("-o json emits a machine-readable envelope", async () => {
    const cluster = fakeCluster({
      objects: {
        [objectKey("apps/v1", "Deployment", "web", "prod")]: {
          apiVersion: "apps/v1",
          kind: "Deployment",
          metadata: { name: "web", namespace: "prod", uid: "u1" },
        },
      },
    });
    const project = fakeProjectContext({
      web: fakeDeclarable("K8s::Apps::Deployment", { metadata: { name: "web", namespace: "prod" } }, { sourceFile: "/project/src/infra.ts" }),
    });
    const { log } = spyConsole();

    await runSource(["deployment", "web", "-n", "prod", "-o", "json"], { connect: cluster.connector, loadProject: async () => project });

    const parsed = JSON.parse(log.mock.calls[0][0] as string);
    expect(parsed).toMatchObject({ found: true, entity: "web", file: "src/infra.ts" });
  });

  test("a live object with no declared source reports found:false, not an error", async () => {
    const cluster = fakeCluster({
      objects: {
        [objectKey("apps/v1", "Deployment", "unrelated", "prod")]: {
          apiVersion: "apps/v1",
          kind: "Deployment",
          metadata: { name: "unrelated", namespace: "prod", uid: "u2" },
        },
      },
    });
    const project = fakeProjectContext({});
    const { log } = spyConsole();

    const code = await runSource(["deployment", "unrelated", "-n", "prod"], { connect: cluster.connector, loadProject: async () => project });

    expect(code).toBe(0);
    expect(log.mock.calls[0][0]).toContain("no declared entity");
  });

  test("degrades gracefully outside a chant project — reports unavailable, does not connect", async () => {
    const { log } = spyConsole();
    const connect = vi.fn();

    const code = await runSource(["deployment", "web"], { connect, loadProject: async () => undefined });

    expect(code).toBe(1);
    expect(log.mock.calls[0][0]).toContain("unavailable");
    expect(connect).not.toHaveBeenCalled();
  });

  test("binding mismatch refuses loudly", async () => {
    const project = fakeProjectContext({});
    const { error } = spyConsole();
    const connect = async () => {
      throw new ClusterBindingMismatchError("prod", "prod-eks", "dev-eks");
    };

    const code = await runSource(["deployment", "web", "--env", "prod"], { connect, loadProject: async () => project });

    expect(code).toBe(1);
    expect(error.mock.calls[0][0]).toContain("no binding for this environment");
  });

  test("unknown flag is rejected before loading the project or connecting", async () => {
    const { error } = spyConsole();
    const loadProject = vi.fn();
    const connect = vi.fn();

    const code = await runSource(["deployment", "web", "--bogus"], { connect, loadProject });

    expect(code).toBe(1);
    expect(error.mock.calls[0][0]).toContain("Unknown flag");
    expect(loadProject).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  test("tri-state: an RBAC-denied read renders NOT-OBSERVED, not a false negative", async () => {
    const project = fakeProjectContext({});
    const cluster = fakeCluster({
      respond: (req) =>
        req.path === "/apis/apps/v1/namespaces/prod/deployments/web"
          ? { status: 403, body: { kind: "Status", reason: "Forbidden", message: "forbidden" } }
          : undefined,
    });
    const { error, log } = spyConsole();

    const code = await runSource(["deployment", "web", "-n", "prod"], { connect: cluster.connector, loadProject: async () => project });

    expect(code).toBe(1);
    expect(error.mock.calls[0][0]).toContain("no credentials");
    expect(log).not.toHaveBeenCalled();
  });
});
