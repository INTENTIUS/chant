/**
 * Cross-lexicon lifecycle integration (#163) — Kubernetes row.
 *
 * Drives the REAL k8sPlugin through core's live-import driver and the
 * changeset path, with the cluster edge faked at
 * `@kubernetes/client-node`'s request layer (chant #1074, previously at
 * `kubectl`). The plugin's own `describeResources` / `exportResources` are what
 * run; only the socket is replaced, and only a literal kubeconfig is ever read.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The plugin reaches the cluster through `./api/connect`'s default connector,
 * which is the one thing a test must not let run for real: it would read the
 * developer's kubeconfig. Replacing the module swaps in a connector backed by
 * `fakeCluster`, which still builds a real client over a literal kubeconfig.
 */
const clusterState: { objects: Record<string, unknown>; fail?: (path: string) => { status: number; body: unknown } | undefined } = {
  objects: {},
};

vi.mock("./api/connect", async () => {
  const { fakeCluster } = await import("./api/fake-cluster");
  return {
    defaultK8sConnector: (options: unknown) =>
      fakeCluster({
        objects: clusterState.objects as never,
        respond: (req) => clusterState.fail?.(req.path),
      }).connector(options as never),
  };
});

const { k8sPlugin } = await import("./plugin");
const { objectKey } = await import("./api/fake-cluster");
const { statusBody } = await import("@intentius/chant-k8s-client/testing");
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

const observedWeb = {
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: { name: "web", namespace: "prod", uid: "uid-1" },
  status: { readyReplicas: 3, replicas: 3 },
};

describe("k8s lifecycle integration (#163)", () => {
  beforeEach(() => {
    clusterState.objects = {};
    clusterState.fail = undefined;
  });

  test("live-import driver: real exportResources → IR → generated source", async () => {
    clusterState.objects = { [objectKey("apps/v1", "Deployment", "web", "default")]: liveDeployment };
    const output = mkdtempSync(join(tmpdir(), "chant-k8s-li-"));
    try {
      const result = await liveImportFromPlugins([k8sPlugin], { environment: "prod", output, force: true });
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
    clusterState.objects = { [objectKey("apps/v1", "Deployment", "web", "prod")]: observedWeb };

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

    const cs = buildChangeSet("prod", { declared: new Set(["webSvc"]), observedNow, observedThen: undefined });
    const byName = Object.fromEntries(cs.entries.map((e) => [e.name, e.action]));
    expect(byName.webSvc).toBe("create");
    expect(byName.web).toBe("adopt");

    const cs2 = buildChangeSet("prod", { declared: new Set(["web"]), observedNow, observedThen: undefined });
    expect(cs2.entries.find((e) => e.name === "web")!.action).toBe("noop");
  });

  /**
   * The #1089 chain, end to end on the real plugin. The entity that used to
   * demonstrate it — a CRD with no `KUBECTL_RESOURCE` entry — is no longer a
   * hole, because #1074 removed the map; an RBAC-denied read is what produces
   * a hole now, and it has to survive describe → plan → status the same way.
   */
  test("tri-state chain: an unreadable entity stays unobserved through describe → plan → status (#1089)", async () => {
    clusterState.objects = { [objectKey("apps/v1", "Deployment", "web", "prod")]: observedWeb };
    clusterState.fail = (path) =>
      path.endsWith("/deployments/widget")
        ? { status: 403, body: statusBody(403, "Forbidden", 'deployments.apps "widget" is forbidden') }
        : undefined;

    const entities = new Map([
      ["web", { entityType: "K8s::Apps::Deployment", props: { metadata: { name: "web", namespace: "prod" } } }],
      ["gone", { entityType: "K8s::Apps::Deployment", props: { metadata: { name: "gone", namespace: "prod" } } }],
      ["widget", { entityType: "K8s::Apps::Deployment", props: { metadata: { name: "widget", namespace: "prod" } } }],
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
    expect(observed.unobserved.widget.reason).toBe("no-credentials");
    expect(observed.unobserved.gone).toBeUndefined(); // NotFound is an absence

    // 2. plan — the unreadable one is `unobserved`; only the confirmed-absent
    // one is a create.
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
    const rows = reconcileStatus(
      "prod",
      [
        {
          component: "widget",
          env: "prod",
          digest: "sha256:abc",
          gitSha: "g",
          runId: "r",
          timestamp: "2026-01-01T00:00:00Z",
          actor: "ci",
        },
      ],
      { liveEvidence: liveEvidenceFromChangeSet(cs) },
    );
    const widgetRow = rows.find((r) => r.component === "widget")!;
    expect(widgetRow.reconciliation).toBe("unknown");
    expect(widgetRow.live).toBeUndefined();
    expect(widgetRow.unobserved?.reason).toBe("no-credentials");
    expect(widgetRow.detail).toContain("could not be observed");
  });

  /**
   * chant #1074's coverage claim, on the real plugin: a CRD that the old path
   * warn-skipped as `unsupported-kind` now reads like anything else.
   */
  test("a CRD is observed, not skipped (chant #1074)", async () => {
    clusterState.objects = {
      [objectKey("ray.io/v1", "RayCluster", "ml", "ray")]: {
        apiVersion: "ray.io/v1",
        kind: "RayCluster",
        metadata: { name: "ml", namespace: "ray", uid: "uid-ray" },
        status: { phase: "ready" },
      },
    };

    const observed = normalizeObservation(
      await k8sPlugin.describeResources!({
        environment: "prod",
        buildOutput: "",
        entityNames: ["ml"],
        entities: new Map([
          ["ml", { entityType: "K8s::Ray::RayCluster", props: { metadata: { name: "ml", namespace: "ray" } } }],
        ]),
      }),
    );

    expect(observed.unobserved).toEqual({});
    expect(observed.resources.ml?.physicalId).toBe("uid-ray");

    const cs = buildChangeSet("prod", {
      declared: new Set(["ml"]),
      observedNow: observed.resources,
      observedThen: undefined,
      unobserved: observed.unobserved,
    });
    expect(cs.entries.find((e) => e.name === "ml")!.action).toBe("noop");
  });
});

// The shared conformance suite (#1089) — every observing lexicon runs it.
describeObservationConformance({
  lexicon: "k8s",
  ownershipChannel: k8sPlugin.ownershipChannel,
  scenarios: [
    {
      name: "an RBAC-denied read alongside a confirmed absence",
      declared: ["widget", "gone"],
      expectUnobserved: ["widget"],
      expectAbsent: ["gone"],
      run: () => {
        clusterState.objects = {};
        clusterState.fail = (path) =>
          path.endsWith("/deployments/widget")
            ? { status: 403, body: statusBody(403, "Forbidden", "forbidden") }
            : undefined;
        return k8sPlugin.describeResources!({
          environment: "prod",
          buildOutput: "",
          entityNames: ["widget", "gone"],
          entities: new Map([
            ["widget", { entityType: "K8s::Apps::Deployment", props: { metadata: { name: "widget" } } }],
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
        clusterState.objects = {};
        clusterState.fail = () => {
          throw new Error("connect ECONNREFUSED 127.0.0.1:6443");
        };
        return k8sPlugin.describeResources!({
          environment: "prod",
          buildOutput: "",
          entityNames: ["web"],
          entities: new Map([["web", { entityType: "K8s::Apps::Deployment", props: { metadata: { name: "web" } } }]]),
        });
      },
    },
    {
      name: "a healthy read",
      declared: ["web"],
      expectPresent: ["web"],
      run: () => {
        clusterState.fail = undefined;
        clusterState.objects = {
          [objectKey("apps/v1", "Deployment", "web", "default")]: {
            apiVersion: "apps/v1",
            kind: "Deployment",
            metadata: {
              name: "web",
              namespace: "default",
              uid: "uid-1",
              labels: { "app.kubernetes.io/managed-by": "chant" },
            },
            status: { readyReplicas: 1, replicas: 1 },
          },
        };
        return k8sPlugin.describeResources!({
          environment: "prod",
          buildOutput: "",
          entityNames: ["web"],
          entities: new Map([["web", { entityType: "K8s::Apps::Deployment", props: { metadata: { name: "web" } } }]]),
        });
      },
    },
    {
      name: "a marker-stamped object surfaces its stack/env identity; a foreign one surfaces none (#1222)",
      declared: ["web", "legacy"],
      expectPresent: ["web", "legacy"],
      expectMarker: { web: { stack: "shop", env: "prod" } },
      expectNoMarker: ["legacy"],
      run: () => {
        clusterState.fail = undefined;
        clusterState.objects = {
          [objectKey("apps/v1", "Deployment", "web", "default")]: {
            apiVersion: "apps/v1",
            kind: "Deployment",
            metadata: {
              name: "web",
              namespace: "default",
              uid: "uid-1",
              labels: {
                "app.kubernetes.io/managed-by": "chant",
                "chant.intentius.io/stack": "shop",
                "chant.intentius.io/env": "prod",
              },
            },
            status: { readyReplicas: 1, replicas: 1 },
          },
          [objectKey("apps/v1", "Deployment", "legacy", "default")]: {
            apiVersion: "apps/v1",
            kind: "Deployment",
            metadata: { name: "legacy", namespace: "default", uid: "uid-2" },
            status: { readyReplicas: 1, replicas: 1 },
          },
        };
        return k8sPlugin.describeResources!({
          environment: "prod",
          buildOutput: "",
          entityNames: ["web", "legacy"],
          entities: new Map([
            ["web", { entityType: "K8s::Apps::Deployment", props: { metadata: { name: "web" } } }],
            ["legacy", { entityType: "K8s::Apps::Deployment", props: { metadata: { name: "legacy" } } }],
          ]),
        });
      },
    },
  ],
});
