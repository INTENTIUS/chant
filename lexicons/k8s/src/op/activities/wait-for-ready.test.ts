import { describe, test, expect } from "vitest";
import {
  waitForReady,
  apiResourceFetcher,
  ReadinessFailedError,
  readinessFor,
  isReady,
  firstTerminal,
  DEFAULT_READINESS,
  type ResourceFetcher,
  type ReadinessSpec,
} from "./wait-for-ready";
// The k8sWait profile marks ReadinessFailedError non-retryable for this activity.
import { TEMPORAL_ACTIVITY_PROFILES } from "@intentius/chant-lexicon-temporal/config";
import { fakeCluster, objectKey } from "../../api/fake-cluster";

/** A fetcher returning a scripted sequence of objects, repeating the last. */
function scriptedFetcher(sequence: Array<Record<string, unknown>>): ResourceFetcher {
  let i = 0;
  return async () => {
    const obj = sequence[Math.min(i, sequence.length - 1)];
    i++;
    return obj;
  };
}

const ready = (conds: Array<{ type: string; status: string }>, extra: Record<string, unknown> = {}) => ({
  metadata: { generation: 1 },
  status: { observedGeneration: 1, conditions: conds, ...extra },
});

const fast = { kind: "certificate", name: "tls", intervalMs: 0 };

describe("readiness model", () => {
  test("default spec = Ready condition True + observedGeneration", () => {
    expect(readinessFor(undefined, "Certificate")).toBe(DEFAULT_READINESS);
    expect(isReady(ready([{ type: "Ready", status: "True" }]), DEFAULT_READINESS)).toBe(true);
    expect(isReady(ready([{ type: "Ready", status: "False" }]), DEFAULT_READINESS)).toBe(false);
    expect(isReady(ready([]), DEFAULT_READINESS)).toBe(false);
  });

  test("observedGeneration lagging metadata.generation blocks readiness", () => {
    const obj = { metadata: { generation: 5 }, status: { observedGeneration: 4, conditions: [{ type: "Ready", status: "True" }] } };
    expect(isReady(obj, DEFAULT_READINESS)).toBe(false);
  });

  test("absent observedGeneration does not block", () => {
    const obj = { metadata: { generation: 5 }, status: { conditions: [{ type: "Ready", status: "True" }] } };
    expect(isReady(obj, DEFAULT_READINESS)).toBe(true);
  });

  test("Flux overrides fail fast on Ready=False wedge reasons, wait on ordinary progress (#1549)", () => {
    // A Flux wedge (bad build, failed upgrade, unreachable source) keeps
    // Ready=False forever — before these entries the generic poll waited out
    // its whole timeout. The ready half is still the kstatus default.
    const spec = readinessFor("kustomize.toolkit.fluxcd.io", "Kustomization");
    expect(spec).not.toBe(DEFAULT_READINESS);
    expect(isReady(ready([{ type: "Ready", status: "True" }]), spec)).toBe(true);

    const wedged = ready([{ type: "Ready", status: "False", reason: "BuildFailed" } as never]);
    expect(isReady(wedged, spec)).toBe(false);
    expect(firstTerminal(wedged, spec)).toBeDefined();

    // Ready=False with a PROGRESS reason (a reconcile in flight) is not a
    // wedge — keep polling.
    const progressing = ready([{ type: "Ready", status: "False", reason: "Progressing" } as never]);
    expect(firstTerminal(progressing, spec)).toBeUndefined();

    // A reason on a TRUE condition is vocabulary, never terminal.
    const healthyWithReason = ready([{ type: "Ready", status: "True", reason: "ReconciliationSucceeded" } as never]);
    expect(firstTerminal(healthyWithReason, spec)).toBeUndefined();

    const hr = readinessFor("helm.toolkit.fluxcd.io", "HelmRelease");
    expect(firstTerminal(ready([{ type: "Ready", status: "False", reason: "UpgradeFailed" } as never]), hr)).toBeDefined();
    const git = readinessFor("source.toolkit.fluxcd.io", "GitRepository");
    expect(firstTerminal(ready([{ type: "Ready", status: "False", reason: "AuthenticationFailed" } as never]), git)).toBeDefined();
  });

  test("Argo override uses health/sync, not a Ready condition", () => {
    const spec = readinessFor("argoproj.io", "Application");
    expect(spec).not.toBe(DEFAULT_READINESS);
    const healthy = { status: { health: { status: "Healthy" }, sync: { status: "Synced" } } };
    const progressing = { status: { health: { status: "Progressing" }, sync: { status: "Synced" } } };
    const degraded = { status: { health: { status: "Degraded" }, sync: { status: "OutOfSync" } } };
    expect(isReady(healthy, spec)).toBe(true);
    expect(isReady(progressing, spec)).toBe(false);
    expect(firstTerminal(degraded, spec)).toBeDefined();
    expect(firstTerminal(healthy, spec)).toBeUndefined();
  });
});

describe("waitForReady", () => {
  test("resolves once the Ready condition flips True", async () => {
    const fetcher = scriptedFetcher([
      ready([{ type: "Ready", status: "False" }]),
      ready([{ type: "Ready", status: "False" }]),
      ready([{ type: "Ready", status: "True" }]),
    ]);
    const obj = await waitForReady(fast, undefined, fetcher);
    expect((obj as any).status.conditions[0].status).toBe("True");
  });

  test("polls past not-ready reads instead of returning early", async () => {
    let calls = 0;
    const fetcher: ResourceFetcher = async () => {
      calls++;
      return calls < 3 ? ready([{ type: "Ready", status: "False" }]) : ready([{ type: "Ready", status: "True" }]);
    };
    await waitForReady(fast, undefined, fetcher);
    expect(calls).toBe(3);
  });

  test("throws ReadinessFailedError on a terminal state", async () => {
    const spec: ReadinessSpec = {
      ready: [{ conditionType: "Ready", status: "True" }],
      terminal: [{ path: "status.phase", equals: "Failed" }],
    };
    const fetcher = scriptedFetcher([{ status: { phase: "Failed" } }]);
    await expect(
      waitForReady({ ...fast, spec }, undefined, fetcher),
    ).rejects.toBeInstanceOf(ReadinessFailedError);
  });

  test("k8sWait marks ReadinessFailedError non-retryable", () => {
    expect(TEMPORAL_ACTIVITY_PROFILES.k8sWait.retry?.nonRetryableErrorTypes).toContain("ReadinessFailedError");
  });

  test("explicit spec wins over the registry", async () => {
    const spec: ReadinessSpec = { ready: [{ path: "status.state", equals: "running" }], observedGeneration: false };
    const fetcher = scriptedFetcher([{ status: { state: "running" } }]);
    const obj = await waitForReady({ kind: "widget", name: "w", intervalMs: 0, spec }, undefined, fetcher);
    expect((obj as any).status.state).toBe("running");
  });
});

/**
 * chant #1074 — the reader underneath. The activity's contract is unchanged
 * (`kind` is still whatever `kubectl get` accepts), so what has to be proven is
 * that the same strings still resolve, now through the cluster's own API
 * discovery rather than by handing them to a `kubectl` process.
 */
describe("apiResourceFetcher (chant #1074)", () => {
  const readyObject = (apiVersion: string, kind: string, name: string, namespace?: string) => ({
    apiVersion,
    kind,
    metadata: { name, ...(namespace ? { namespace } : {}), generation: 1 },
    status: { observedGeneration: 1, conditions: [{ type: "Ready", status: "True" }] },
  });

  test.each([
    ["raycluster.ray.io", "ray.io/v1", "RayCluster", "rayclusters", "K8s::Ray::RayCluster"],
    ["certificates", "cert-manager.io/v1", "Certificate", "certificates", "K8s::CertManager::Certificate"],
    ["Certificate", "cert-manager.io/v1", "Certificate", "certificates", "K8s::CertManager::Certificate"],
    ["deployments", "apps/v1", "Deployment", "deployments", "K8s::Apps::Deployment"],
  ])("`%s` resolves to %s %s via discovery", async (kindArg, apiVersion, kind, plural, entityType) => {
    const cluster = fakeCluster({
      serves: [entityType],
      objects: { [objectKey(apiVersion, kind, "thing", "prod")]: readyObject(apiVersion, kind, "thing", "prod") },
    });

    const obj = await waitForReady(
      { kind: kindArg, name: "thing", namespace: "prod", intervalMs: 0 },
      undefined,
      apiResourceFetcher(cluster.connector),
    );

    expect((obj as Record<string, unknown>).kind).toBe(kind);
    expect(cluster.layer.paths()).toContain(
      `${apiVersion.includes("/") ? `/apis/${apiVersion}` : `/api/${apiVersion}`}/namespaces/prod/${plural}/thing`,
    );
  });

  test("resolution and the connection are done once, not once per poll", async () => {
    const notReady = {
      apiVersion: "cert-manager.io/v1",
      kind: "Certificate",
      metadata: { name: "tls", namespace: "prod", generation: 1 },
      status: { observedGeneration: 1, conditions: [{ type: "Ready", status: "False" }] },
    };
    let polls = 0;
    const cluster = fakeCluster({
      serves: ["K8s::CertManager::Certificate"],
      objects: { [objectKey("cert-manager.io/v1", "Certificate", "tls", "prod")]: notReady },
      respond: (req) => {
        if (!req.path.endsWith("/certificates/tls")) return undefined;
        polls++;
        return polls < 3
          ? { body: notReady }
          : { body: { ...notReady, status: { observedGeneration: 1, conditions: [{ type: "Ready", status: "True" }] } } };
      },
    });

    await waitForReady(
      { kind: "certificate", name: "tls", namespace: "prod", intervalMs: 0 },
      undefined,
      apiResourceFetcher(cluster.connector),
    );

    expect(polls).toBe(3);
    expect(cluster.connects).toHaveLength(1);
    // Discovery once; the three object reads reuse the cached resource list.
    expect(cluster.layer.paths().filter((p) => p === "/apis/cert-manager.io/v1")).toHaveLength(1);
  });

  test("a kind the cluster does not serve fails loudly instead of polling forever", async () => {
    const cluster = fakeCluster({ serves: ["K8s::Apps::Deployment"] });
    await expect(
      waitForReady({ kind: "widgets", name: "w", intervalMs: 0 }, undefined, apiResourceFetcher(cluster.connector)),
    ).rejects.toThrow(/no resource matching "widgets"/);
  });

  test("an explicit context is passed to the connector, closing the read/write split", async () => {
    const cluster = fakeCluster({
      serves: ["K8s::Apps::Deployment"],
      objects: { [objectKey("apps/v1", "Deployment", "web", "prod")]: readyObject("apps/v1", "Deployment", "web", "prod") },
    });

    await waitForReady(
      { kind: "deployments", name: "web", namespace: "prod", context: "test-context", intervalMs: 0 },
      undefined,
      apiResourceFetcher(cluster.connector),
    );

    expect(cluster.connects[0]).toMatchObject({ context: "test-context" });
  });
});
