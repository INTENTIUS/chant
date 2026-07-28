import { describe, test, expect, vi, afterEach } from "vitest";
import { ClusterBindingMismatchError } from "@intentius/chant/kubectl-context";
import { fakeCluster } from "../api/fake-cluster";
import { runEvents } from "./events";

afterEach(() => vi.restoreAllMocks());

function spyConsole() {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  return { log, error };
}

function event(name: string, reason: string, involved: { kind: string; name: string }, lastTimestamp: string) {
  return {
    apiVersion: "v1",
    kind: "Event",
    metadata: { name, namespace: "prod", uid: `uid-${name}` },
    involvedObject: involved,
    reason,
    type: "Normal",
    message: `${reason} happened`,
    lastTimestamp,
  };
}

describe("chant kube events (#1079)", () => {
  test("happy path: lists events oldest first", async () => {
    const cluster = fakeCluster({
      respond: (req) =>
        req.path === "/api/v1/namespaces/prod/events"
          ? {
              body: {
                items: [
                  event("e2", "Started", { kind: "Pod", name: "web" }, "2026-01-01T00:02:00Z"),
                  event("e1", "Scheduled", { kind: "Pod", name: "web" }, "2026-01-01T00:00:00Z"),
                ],
              },
            }
          : undefined,
    });
    const { log } = spyConsole();

    const code = await runEvents(["-n", "prod"], { connect: cluster.connector });

    expect(code).toBe(0);
    const out = log.mock.calls[0][0] as string;
    const scheduledIdx = out.indexOf("Scheduled");
    const startedIdx = out.indexOf("Started");
    expect(scheduledIdx).toBeGreaterThan(-1);
    expect(startedIdx).toBeGreaterThan(scheduledIdx);
  });

  test("--for filters by involvedObject kind/name", async () => {
    const cluster = fakeCluster({
      respond: (req) =>
        req.path === "/api/v1/namespaces/prod/events"
          ? {
              body: {
                items: [
                  event("e1", "Started", { kind: "Pod", name: "web" }, "2026-01-01T00:00:00Z"),
                  event("e2", "Started", { kind: "Pod", name: "other" }, "2026-01-01T00:00:00Z"),
                ],
              },
            }
          : undefined,
    });
    const { log } = spyConsole();

    await runEvents(["-n", "prod", "--for=Pod/web"], { connect: cluster.connector });

    const out = log.mock.calls[0][0] as string;
    expect(out).toContain("Pod/web");
    expect(out).not.toContain("Pod/other");
  });

  test("binding mismatch refuses loudly", async () => {
    const { error } = spyConsole();
    const connect = async () => {
      throw new ClusterBindingMismatchError("prod", "prod-eks", "dev-eks");
    };

    const code = await runEvents(["--env", "prod"], { connect });

    expect(code).toBe(1);
    expect(error.mock.calls[0][0]).toContain("no binding for this environment");
  });

  test("unknown flag is rejected before any connection", async () => {
    const { error } = spyConsole();
    const connect = vi.fn();

    const code = await runEvents(["--bogus"], { connect });

    expect(code).toBe(1);
    expect(error.mock.calls[0][0]).toContain("Unknown flag");
    expect(connect).not.toHaveBeenCalled();
  });

  test("tri-state: an RBAC-denied list renders NOT-OBSERVED, not an empty list", async () => {
    const cluster = fakeCluster({
      respond: (req) =>
        req.path === "/api/v1/namespaces/prod/events"
          ? { status: 403, body: { kind: "Status", reason: "Forbidden", message: "events is forbidden" } }
          : undefined,
    });
    const { error, log } = spyConsole();

    const code = await runEvents(["-n", "prod"], { connect: cluster.connector });

    expect(code).toBe(1);
    expect(error.mock.calls[0][0]).toContain("no credentials");
    expect(log).not.toHaveBeenCalled();
  });
});
