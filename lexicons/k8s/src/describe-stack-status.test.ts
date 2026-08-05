import { describe, test, expect } from "vitest";
import { describeStackStatus } from "./describe-stack-status";
import type { K8sConnector } from "./api/connect";

/** A connector whose client answers list() from a canned map keyed by kind. */
function fakeConnector(byKind: Record<string, unknown[]>, opts: { failKinds?: string[]; recordSelectors?: string[] } = {}): K8sConnector {
  return (async () => ({
    client: {
      async list(selector: { kind: string }, listOpts?: { labelSelector?: string }) {
        if (listOpts?.labelSelector && opts.recordSelectors) opts.recordSelectors.push(listOpts.labelSelector);
        if (opts.failKinds?.includes(selector.kind)) throw new Error("rbac denied");
        return byKind[selector.kind] ?? [];
      },
    },
  })) as unknown as K8sConnector;
}

const readyDeployment = {
  kind: "Deployment",
  metadata: { name: "cc-api", labels: { "chant.intentius.io/stack": "cc" } },
  status: { replicas: 2, readyReplicas: 2 },
};
const laggingDeployment = { ...readyDeployment, status: { replicas: 2, readyReplicas: 1 } };
const service = { kind: "Service", metadata: { name: "cc-api" } };

describe("k8s describeStackStatus (#1495 piece 3)", () => {
  test("selects on the labels chant's serializer stamps", async () => {
    const selectors: string[] = [];
    await describeStackStatus({ environment: "local", stack: "kubemicrovm-ops" }, fakeConnector({}, { recordSelectors: selectors }));
    expect(selectors[0]).toBe("app.kubernetes.io/managed-by=chant,chant.intentius.io/stack=kubemicrovm-ops");
  });

  test("present + healthy when every matching workload is ready", async () => {
    const out = await describeStackStatus({ environment: "local", stack: "cc" }, fakeConnector({ Deployment: [readyDeployment], Service: [service] }));
    expect(out).toEqual({ stack: "cc", present: true, status: "1/1 workloads ready", healthy: true });
  });

  test("present but unhealthy when a workload lags its replica count", async () => {
    const out = await describeStackStatus({ environment: "local", stack: "cc" }, fakeConnector({ Deployment: [laggingDeployment] }));
    expect(out).toMatchObject({ present: true, healthy: false });
  });

  test("presence-only objects report present and assert nothing about health", async () => {
    const out = await describeStackStatus({ environment: "local", stack: "cc" }, fakeConnector({ Service: [service] }));
    expect(out).toEqual({ stack: "cc", present: true, status: "1 objects present", healthy: true });
  });

  test("zero matches is the pre-first-apply state — absent, not indeterminate", async () => {
    const out = await describeStackStatus({ environment: "local", stack: "cc" }, fakeConnector({}));
    expect(out).toEqual({ stack: "cc", present: false });
  });

  test("one kind's read failing does not fail the sweep", async () => {
    const out = await describeStackStatus(
      { environment: "local", stack: "cc" },
      fakeConnector({ Deployment: [readyDeployment] }, { failKinds: ["Ingress", "CronJob"] }),
    );
    expect(out).toMatchObject({ present: true, healthy: true });
  });

  test("no cluster binding is indeterminate — null, never a confident absence", async () => {
    const broken: K8sConnector = (async () => {
      throw new Error("no context bound for env");
    }) as unknown as K8sConnector;
    expect(await describeStackStatus({ environment: "local", stack: "cc" }, broken)).toBeNull();
  });

  test("every read failing is indeterminate too", async () => {
    const out = await describeStackStatus(
      { environment: "local", stack: "cc" },
      fakeConnector({}, { failKinds: ["Deployment", "StatefulSet", "DaemonSet", "Service", "ConfigMap", "Secret", "ServiceAccount", "Namespace", "Ingress", "PodDisruptionBudget", "HorizontalPodAutoscaler", "CronJob"] }),
    );
    expect(out).toBeNull();
  });
});
