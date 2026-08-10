import { describe, test, expect } from "vitest";
import { describeStackStatus } from "./describe-stack-status";
import type { K8sConnector } from "./api/connect";

/**
 * A connector whose client answers list() from a canned map keyed by kind.
 * Selector-bearing lists model the server having filtered to the stack's
 * objects (`byKind` holds what matched); the selector-less list is the CRD
 * discovery read (#1528), answered from `discovery` so a test can serve
 * definitions without them counting as the stack's own objects.
 */
function fakeConnector(
  byKind: Record<string, unknown[]>,
  opts: { failKinds?: string[]; recordSelectors?: string[]; discovery?: Record<string, unknown[]> } = {},
): K8sConnector {
  return (async () => ({
    client: {
      async list(selector: { kind: string }, listOpts?: { labelSelector?: string }) {
        if (opts.failKinds?.includes(selector.kind)) throw new Error("rbac denied");
        if (!listOpts?.labelSelector) return opts.discovery?.[selector.kind] ?? [];
        if (opts.recordSelectors) opts.recordSelectors.push(listOpts.labelSelector);
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

/** A served CRD, as the discovery read returns it — not the stack's object. */
const microvmCrd = {
  kind: "CustomResourceDefinition",
  metadata: { name: "microvms.lambda.aws.amazon.com" },
  spec: {
    group: "lambda.aws.amazon.com",
    names: { kind: "MicroVM" },
    versions: [{ name: "v1alpha1", served: true, storage: true }],
  },
};
const runningMicroVm = {
  kind: "MicroVM",
  metadata: { name: "kmv-vm", labels: { "chant.intentius.io/stack": "kmv-workload" } },
};
const microvmReplicaSet = {
  kind: "MicroVMReplicaSet",
  metadata: { name: "kmv-rs", labels: { "chant.intentius.io/stack": "kmv-workload" } },
  status: { replicas: 2, readyReplicas: 2 },
};

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
      fakeConnector({}, { failKinds: ["Deployment", "StatefulSet", "DaemonSet", "Service", "ConfigMap", "Secret", "ServiceAccount", "Namespace", "Ingress", "PodDisruptionBudget", "HorizontalPodAutoscaler", "CronJob", "CustomResourceDefinition"] }),
    );
    expect(out).toBeNull();
  });
});

describe("the sweep reaches what the cluster serves, not only built-ins (#1528)", () => {
  // A kubemicrovm estate made both gaps real: its crds unit deploys nothing
  // but definitions, its workload unit nothing but custom resources, and
  // under the fixed bound both read absent while the estate ran — which
  // painted every component touching them dead in `components status --live`.
  test("a unit that deploys the definitions themselves is present", async () => {
    const crdWithLabel = {
      ...microvmCrd,
      metadata: { ...microvmCrd.metadata, labels: { "chant.intentius.io/stack": "kmv-crds" } },
    };
    const out = await describeStackStatus(
      { environment: "local", stack: "kmv-crds" },
      fakeConnector({ CustomResourceDefinition: [crdWithLabel] }),
    );
    expect(out).toMatchObject({ present: true });
  });

  test("a unit of custom resources is present via the kinds the CRDs declare", async () => {
    const out = await describeStackStatus(
      { environment: "local", stack: "kmv-workload" },
      fakeConnector({ MicroVM: [runningMicroVm] }, { discovery: { CustomResourceDefinition: [microvmCrd] } }),
    );
    expect(out).toMatchObject({ present: true });
  });

  test("a custom controller reporting replica readiness asserts health like a built-in", async () => {
    const out = await describeStackStatus(
      { environment: "local", stack: "kmv-workload" },
      fakeConnector(
        { MicroVMReplicaSet: [microvmReplicaSet] },
        {
          discovery: {
            CustomResourceDefinition: [
              {
                ...microvmCrd,
                spec: { ...microvmCrd.spec, names: { kind: "MicroVMReplicaSet" } },
              },
            ],
          },
        },
      ),
    );
    expect(out).toMatchObject({ present: true, healthy: true, status: "1/1 workloads ready" });
  });

  test("an unserved or malformed CRD derives nothing and breaks nothing", async () => {
    const out = await describeStackStatus(
      { environment: "local", stack: "cc" },
      fakeConnector(
        { Deployment: [readyDeployment] },
        {
          discovery: {
            CustomResourceDefinition: [
              { kind: "CustomResourceDefinition", metadata: { name: "half" }, spec: { group: "x.io" } },
              { ...microvmCrd, spec: { ...microvmCrd.spec, versions: [{ name: "v1", served: false }] } },
            ],
          },
        },
      ),
    );
    expect(out).toMatchObject({ present: true, healthy: true });
  });
});
