/**
 * Cross-lexicon lifecycle integration (#163) — Kubernetes row.
 *
 * Drives the REAL k8sPlugin through core's live-import driver and the changeset
 * path, with the `kubectl` edge mocked.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const { k8sPlugin } = await import("./plugin");
const { liveImportFromPlugins } = await import("@intentius/chant/cli/commands/import");
const { buildChangeSet } = await import("@intentius/chant/lifecycle/change-set");
const { normalizeObservation } = await import("@intentius/chant/observation");
const { liveEvidenceFromChangeSet, reconcileStatus } = await import("@intentius/chant/lifecycle/status");
const { describeObservationConformance } = await import("@intentius/chant-test-utils");

const liveDeployment = {
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: { name: "web", namespace: "default", uid: "d-1" },
  spec: { replicas: 3, selector: { matchLabels: { app: "web" } } },
};

const emptyList = { stdout: JSON.stringify({ items: [] }), stderr: "" };

describe("k8s lifecycle integration (#163)", () => {
  beforeEach(() => execMock.mockReset());

  test("live-import driver: real exportResources → IR → generated source", async () => {
    execMock.mockImplementation((cmd?: string) =>
      cmd?.includes("get deployment.apps")
        ? { stdout: JSON.stringify({ items: [liveDeployment] }), stderr: "" }
        : emptyList,
    );
    const output = mkdtempSync(join(tmpdir(), "chant-k8s-li-"));
    try {
      const result = await liveImportFromPlugins([k8sPlugin], {
        environment: "prod",
        output,
        force: true,
      });
      expect(result.success).toBe(true);
      expect(result.generatedFiles.length).toBeGreaterThan(0);
      const all = readdirSync(output)
        .map((f) => readFileSync(join(output, f), "utf-8"))
        .join("\n")
        .toLowerCase();
      expect(all).toContain("deployment");
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  test("changeset path: real describeResources → buildChangeSet verdicts", async () => {
    execMock.mockImplementation((cmd?: string) =>
      cmd?.includes("deployment.apps web")
        ? {
            stdout: JSON.stringify({
              metadata: { name: "web", namespace: "prod", uid: "uid-1" },
              status: { readyReplicas: 3, replicas: 3 },
            }),
            stderr: "",
          }
        : new Error("not found"),
    );

    const { resources: observedNow } = normalizeObservation(
      await k8sPlugin.describeResources!({
        environment: "prod",
        buildOutput: "",
        entityNames: ["web"],
        entities: new Map([
          ["web", { entityType: "K8s::Apps::Deployment", props: { metadata: { name: "web", namespace: "prod" } } }],
        ]),
      }),
    );
    expect(observedNow.web?.type).toBe("K8s::Apps::Deployment");

    const cs = buildChangeSet("prod", {
      declared: new Set(["webSvc"]),
      observedNow,
      observedThen: undefined,
    });
    const byName = Object.fromEntries(cs.entries.map((e) => [e.name, e.action]));
    expect(byName.webSvc).toBe("create");
    expect(byName.web).toBe("adopt");

    const cs2 = buildChangeSet("prod", {
      declared: new Set(["web"]),
      observedNow,
      observedThen: undefined,
    });
    expect(cs2.entries.find((e) => e.name === "web")!.action).toBe("noop");
  });

  /**
   * The #1089 chain, end to end on the real plugin: a declared CRD the lexicon
   * has no reader for goes describe → plan → component status without ever
   * turning into a create or a "stale" component.
   */
  test("tri-state chain: an unreadable CRD stays unobserved through describe → plan → status (#1089)", async () => {
    execMock.mockImplementation((cmd?: string) =>
      cmd?.includes("deployment.apps web")
        ? {
            stdout: JSON.stringify({
              metadata: { name: "web", namespace: "prod", uid: "uid-1" },
              status: { readyReplicas: 3, replicas: 3 },
            }),
            stderr: "",
          }
        : new Error('Error from server (NotFound): deployments.apps "gone" not found'),
    );

    const entities = new Map([
      ["web", { entityType: "K8s::Apps::Deployment", props: { metadata: { name: "web", namespace: "prod" } } }],
      ["gone", { entityType: "K8s::Apps::Deployment", props: { metadata: { name: "gone", namespace: "prod" } } }],
      ["widget", { entityType: "K8s::Example::Widget", props: { metadata: { name: "widget", namespace: "prod" } } }],
    ]);

    // 1. describe — three declared entities, three different verdicts.
    const observed = normalizeObservation(
      await k8sPlugin.describeResources!({
        environment: "prod",
        buildOutput: "",
        entityNames: [...entities.keys()],
        entities,
      }),
    );
    expect(Object.keys(observed.resources)).toEqual(["web"]);
    expect(observed.unobserved.widget.reason).toBe("unsupported-kind");
    expect(observed.unobserved.gone).toBeUndefined(); // NotFound is an absence

    // 2. plan — the CRD is `unobserved`; only the confirmed-absent one is a create.
    const cs = buildChangeSet("prod", {
      declared: new Set(entities.keys()),
      observedNow: observed.resources,
      observedThen: undefined,
      unobserved: observed.unobserved,
    });
    const byName = Object.fromEntries(cs.entries.map((e) => [e.name, e.action]));
    expect(byName).toEqual({ web: "noop", gone: "create", widget: "unobserved" });

    // 3. status — a recorded component whose entity was never read reports
    // `unknown`, not `stale`, and carries no `live` boolean at all.
    const rows = reconcileStatus("prod", [
      { component: "widget", env: "prod", digest: "sha256:abc", gitSha: "g", runId: "r", timestamp: "2026-01-01T00:00:00Z", actor: "ci" },
    ], { liveEvidence: liveEvidenceFromChangeSet(cs) });
    const widgetRow = rows.find((r) => r.component === "widget")!;
    expect(widgetRow.reconciliation).toBe("unknown");
    expect(widgetRow.live).toBeUndefined();
    expect(widgetRow.unobserved?.reason).toBe("unsupported-kind");
    expect(widgetRow.detail).toContain("could not be observed");
  });
});

// The shared conformance suite (#1089) — every observing lexicon runs it.
describeObservationConformance({
  lexicon: "k8s",
  scenarios: [
    {
      name: "a CRD kind with no reader",
      declared: ["widget", "gone"],
      expectUnobserved: ["widget"],
      expectAbsent: ["gone"],
      run: () => {
        execMock.mockImplementation(() => new Error('Error from server (NotFound): deployments.apps "gone" not found'));
        return k8sPlugin.describeResources!({
          environment: "prod",
          buildOutput: "",
          entityNames: ["widget", "gone"],
          entities: new Map([
            ["widget", { entityType: "K8s::Example::Widget", props: { metadata: { name: "widget" } } }],
            ["gone", { entityType: "K8s::Apps::Deployment", props: { metadata: { name: "gone" } } }],
          ]),
        });
      },
    },
    {
      name: "an unreachable API server",
      declared: ["web"],
      expectUnobserved: ["web"],
      run: () => {
        execMock.mockImplementation(() =>
          Object.assign(new Error("kubectl failed"), {
            stderr: "The connection to the server 127.0.0.1:6443 was refused - did you specify the right host or port?",
          }),
        );
        return k8sPlugin.describeResources!({
          environment: "prod",
          buildOutput: "",
          entityNames: ["web"],
          entities: new Map([
            ["web", { entityType: "K8s::Apps::Deployment", props: { metadata: { name: "web" } } }],
          ]),
        });
      },
    },
    {
      name: "a healthy read",
      declared: ["web"],
      expectPresent: ["web"],
      run: () => {
        execMock.mockImplementation(() => ({
          stdout: JSON.stringify({
            metadata: { name: "web", namespace: "prod", uid: "uid-1", labels: { "app.kubernetes.io/managed-by": "chant" } },
            status: { readyReplicas: 1, replicas: 1 },
          }),
          stderr: "",
        }));
        return k8sPlugin.describeResources!({
          environment: "prod",
          buildOutput: "",
          entityNames: ["web"],
          entities: new Map([
            ["web", { entityType: "K8s::Apps::Deployment", props: { metadata: { name: "web" } } }],
          ]),
        });
      },
    },
  ],
});
