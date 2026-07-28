import { describe, test, expect, vi, afterEach } from "vitest";
import { ClusterBindingMismatchError } from "@intentius/chant/kubectl-context";
import { fakeCluster, objectKey, ownedObject } from "../api/fake-cluster";
import { runGet } from "./get";
import { fakeDeclarable, fakeProjectContext } from "./testing";

afterEach(() => vi.restoreAllMocks());

function spyConsole() {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  return { log, error };
}

describe("chant kube get (#1079)", () => {
  test("happy path: lists live objects in a table, chant column reads unavailable with no project", async () => {
    const cluster = fakeCluster({
      objects: {
        [objectKey("apps/v1", "Deployment", "web", "prod")]: ownedObject("apps/v1", "Deployment", "web", "prod", {
          status: { readyReplicas: 2, replicas: 2 },
        }),
      },
    });
    const { log } = spyConsole();

    const code = await runGet(["deployments", "-n", "prod"], { connect: cluster.connector });

    expect(code).toBe(0);
    const out = log.mock.calls.map((c) => c[0]).join("\n");
    expect(out).toContain("NAME");
    expect(out).toContain("CHANT");
    expect(out).toContain("web");
    expect(out).toContain("unavailable");
  });

  test("with a project: a matching declared entity renders as declared, an unmatched foreign object as foreign-owned", async () => {
    const cluster = fakeCluster({
      objects: {
        [objectKey("apps/v1", "Deployment", "web", "prod")]: {
          apiVersion: "apps/v1",
          kind: "Deployment",
          metadata: { name: "web", namespace: "prod", uid: "u1", labels: { app: "web" } },
          spec: { replicas: 2 },
          status: { readyReplicas: 2, replicas: 2 },
        },
        [objectKey("apps/v1", "Deployment", "unrelated", "prod")]: {
          apiVersion: "apps/v1",
          kind: "Deployment",
          metadata: { name: "unrelated", namespace: "prod", uid: "u2" },
          status: { readyReplicas: 1, replicas: 1 },
        },
      },
    });
    const project = fakeProjectContext({
      web: fakeDeclarable("K8s::Apps::Deployment", {
        metadata: { name: "web", namespace: "prod" },
        spec: { replicas: 2 },
      }),
    });
    const { log } = spyConsole();

    const code = await runGet(["deployments", "-n", "prod"], {
      connect: cluster.connector,
      loadProject: async () => project,
    });

    expect(code).toBe(0);
    const out = log.mock.calls.map((c) => c[0]).join("\n");
    expect(out).toMatch(/web\s+.*declared/);
    expect(out).toMatch(/unrelated\s+.*foreign-owned/);
  });

  test("a declared match whose live spec disagrees renders as drifted", async () => {
    const cluster = fakeCluster({
      objects: {
        [objectKey("apps/v1", "Deployment", "web", "prod")]: {
          apiVersion: "apps/v1",
          kind: "Deployment",
          metadata: { name: "web", namespace: "prod", uid: "u1" },
          spec: { replicas: 9 },
          status: { readyReplicas: 9, replicas: 9 },
        },
      },
    });
    const project = fakeProjectContext({
      web: fakeDeclarable("K8s::Apps::Deployment", {
        metadata: { name: "web", namespace: "prod" },
        spec: { replicas: 2 },
      }),
    });
    const { log } = spyConsole();

    await runGet(["deployments", "-n", "prod"], { connect: cluster.connector, loadProject: async () => project });

    const out = log.mock.calls.map((c) => c[0]).join("\n");
    expect(out).toMatch(/web\s+.*drifted/);
  });

  test("binding mismatch: refuses loudly, renders NOT-OBSERVED, no resources printed", async () => {
    const { error, log } = spyConsole();
    const connect = async () => {
      throw new ClusterBindingMismatchError("prod", "prod-eks", "dev-eks");
    };

    const code = await runGet(["deployments", "--env", "prod"], { connect });

    expect(code).toBe(1);
    expect(error).toHaveBeenCalled();
    const message = error.mock.calls.map((c) => c[0]).join("\n");
    expect(message).toContain("no binding for this environment");
    expect(message).toContain("prod-eks");
    expect(log).not.toHaveBeenCalled();
  });

  test("unknown flag is rejected before any connection is attempted", async () => {
    const { error } = spyConsole();
    const connect = vi.fn();

    const code = await runGet(["deployments", "--bogus"], { connect });

    expect(code).toBe(1);
    expect(error.mock.calls[0][0]).toContain("Unknown flag");
    expect(connect).not.toHaveBeenCalled();
  });

  test("tri-state: an RBAC-denied list renders NOT-OBSERVED, not an empty table", async () => {
    const cluster = fakeCluster({
      respond: (req) =>
        req.path === "/apis/apps/v1/namespaces/prod/deployments"
          ? { status: 403, body: { kind: "Status", reason: "Forbidden", message: "deployments is forbidden", code: 403 } }
          : undefined,
    });
    const { error, log } = spyConsole();

    const code = await runGet(["deployments", "-n", "prod"], { connect: cluster.connector });

    expect(code).toBe(1);
    const message = error.mock.calls.map((c) => c[0]).join("\n");
    expect(message).toContain("no credentials");
    expect(log).not.toHaveBeenCalled();
  });

  test("tri-state: a kind the cluster's discovery has never heard of is an explicit error, not \"No resources found.\"", async () => {
    const cluster = fakeCluster({ serves: [] });
    const { error, log } = spyConsole();

    const code = await runGet(["widgets"], { connect: cluster.connector });

    expect(code).toBe(1);
    expect(error.mock.calls[0][0]).toContain(`doesn't have a resource type "widgets"`);
    expect(log).not.toHaveBeenCalled();
  });

  test("a single get with a name that does not exist reports NotFound, kubectl-style", async () => {
    const cluster = fakeCluster({});
    const { error } = spyConsole();

    const code = await runGet(["deployment", "ghost", "-n", "prod"], { connect: cluster.connector });

    expect(code).toBe(1);
    expect(error.mock.calls[0][0]).toContain("NotFound");
  });

  test("-o json prints the raw object, not the table", async () => {
    const cluster = fakeCluster({
      objects: {
        [objectKey("apps/v1", "Deployment", "web", "prod")]: ownedObject("apps/v1", "Deployment", "web", "prod"),
      },
    });
    const { log } = spyConsole();

    await runGet(["deployment", "web", "-n", "prod", "-o", "json"], { connect: cluster.connector });

    const parsed = JSON.parse(log.mock.calls[0][0] as string);
    expect(parsed.metadata.name).toBe("web");
  });

  test("resolves a declared entity name directly, chant vocabulary first", async () => {
    const cluster = fakeCluster({
      objects: {
        [objectKey("apps/v1", "Deployment", "web", "prod")]: ownedObject("apps/v1", "Deployment", "web", "prod"),
      },
    });
    const project = fakeProjectContext({
      myWeb: fakeDeclarable("K8s::Apps::Deployment", { metadata: { name: "web", namespace: "prod" } }),
    });
    const { log } = spyConsole();

    const code = await runGet(["myWeb"], { connect: cluster.connector, loadProject: async () => project });

    expect(code).toBe(0);
    const out = log.mock.calls.map((c) => c[0]).join("\n");
    expect(out).toContain("web");
  });
});
