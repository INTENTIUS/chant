import { describe, test, expect, vi, afterEach } from "vitest";
import { ClusterBindingMismatchError } from "@intentius/chant/kubectl-context";
import { fakeCluster, objectKey, ownedObject } from "../api/fake-cluster";
import { runDelete } from "./delete";

afterEach(() => vi.restoreAllMocks());

function spyConsole() {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  return { log, error };
}

describe("chant kube delete (#1079)", () => {
  test("without --yes, previews the delete and issues no DELETE request", async () => {
    const cluster = fakeCluster({
      objects: { [objectKey("apps/v1", "Deployment", "web", "prod")]: ownedObject("apps/v1", "Deployment", "web", "prod") },
    });
    const { log } = spyConsole();

    const code = await runDelete(["deployment", "web", "-n", "prod"], { connect: cluster.connector });

    expect(code).toBe(0);
    expect(log.mock.calls[0][0]).toContain("Would delete");
    expect(log.mock.calls[0][0]).toContain("--yes");
    expect(cluster.layer.requests.some((r) => r.method === "DELETE")).toBe(false);
  });

  test("--yes deletes through the typed client's own delete()", async () => {
    const cluster = fakeCluster({
      objects: { [objectKey("apps/v1", "Deployment", "web", "prod")]: ownedObject("apps/v1", "Deployment", "web", "prod") },
    });
    const { log } = spyConsole();

    const code = await runDelete(["deployment", "web", "-n", "prod", "--yes"], { connect: cluster.connector });

    expect(code).toBe(0);
    expect(log.mock.calls.at(-1)?.[0]).toContain("deleted");
    const deleted = cluster.layer.requests.find((r) => r.method === "DELETE");
    expect(deleted?.path).toBe("/apis/apps/v1/namespaces/prod/deployments/web");
  });

  test("a non-chant-owned object gets a visible warning but is still deletable (explicit name = informed decision)", async () => {
    const cluster = fakeCluster({
      objects: {
        [objectKey("apps/v1", "Deployment", "web", "prod")]: {
          apiVersion: "apps/v1",
          kind: "Deployment",
          metadata: { name: "web", namespace: "prod", uid: "u1" },
        },
      },
    });
    const { log } = spyConsole();

    const code = await runDelete(["deployment", "web", "-n", "prod", "--yes"], { connect: cluster.connector });

    expect(code).toBe(0);
    const out = log.mock.calls.map((c) => c[0]).join("\n");
    expect(out).toContain("no chant ownership marker");
    expect(out).toContain("deleted");
  });

  test("explicit-target requirement: a bare kind with no name is refused — no sweeps", async () => {
    const connect = vi.fn();
    const { error } = spyConsole();

    const code = await runDelete(["deployment"], { connect });

    expect(code).toBe(1);
    expect(error.mock.calls[0][0]).toContain("no bare kind sweeps");
    expect(connect).not.toHaveBeenCalled();
  });

  test("a resource that is already gone reports NotFound rather than a silent success", async () => {
    const cluster = fakeCluster({});
    const { error } = spyConsole();

    const code = await runDelete(["deployment", "ghost", "-n", "prod", "--yes"], { connect: cluster.connector });

    expect(code).toBe(1);
    expect(error.mock.calls[0][0]).toContain("NotFound");
  });

  test("binding mismatch refuses loudly, before any read or delete", async () => {
    const { error } = spyConsole();
    const connect = async () => {
      throw new ClusterBindingMismatchError("prod", "prod-eks", "dev-eks");
    };

    const code = await runDelete(["deployment", "web", "--env", "prod", "--yes"], { connect });

    expect(code).toBe(1);
    expect(error.mock.calls[0][0]).toContain("no binding for this environment");
  });

  test("unknown flag is rejected before any connection", async () => {
    const { error } = spyConsole();
    const connect = vi.fn();

    const code = await runDelete(["deployment", "web", "--bogus"], { connect });

    expect(code).toBe(1);
    expect(error.mock.calls[0][0]).toContain("Unknown flag");
    expect(connect).not.toHaveBeenCalled();
  });

  test("tri-state: an RBAC-denied read-before-delete renders NOT-OBSERVED, never a silent delete", async () => {
    const cluster = fakeCluster({
      respond: (req) =>
        req.path === "/apis/apps/v1/namespaces/prod/deployments/web"
          ? { status: 403, body: { kind: "Status", reason: "Forbidden", message: "forbidden" } }
          : undefined,
    });
    const { error, log } = spyConsole();

    const code = await runDelete(["deployment", "web", "-n", "prod", "--yes"], { connect: cluster.connector });

    expect(code).toBe(1);
    expect(error.mock.calls[0][0]).toContain("no credentials");
    expect(log).not.toHaveBeenCalled();
    expect(cluster.layer.requests.some((r) => r.method === "DELETE")).toBe(false);
  });
});
