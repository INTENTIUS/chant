import { describe, test, expect } from "vitest";
import { MASKED, normalizeDeepObservation } from "@intentius/chant/deep-observation";
import { fakeCluster, objectKey } from "@intentius/chant-lexicon-k8s/api/fake-cluster";
import { k8sDeepNormalizationHooks } from "@intentius/chant-lexicon-k8s/deep-observe-hooks";
import { observeResourcesDeepHelm } from "./deep-observe";
import { helmDeepNormalizationHooks } from "./deep-observe-hooks";
import type { HelmRunner } from "./release-observe";

const LIST = JSON.stringify([
  { name: "web-app", namespace: "prod", revision: "2", status: "deployed", chart: "web-app-0.1.0" },
]);

const MANIFEST = `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-app
spec:
  replicas: 2
---
apiVersion: v1
kind: Secret
metadata:
  name: web-app-creds
stringData:
  password: declared-secret
`;

const scripted = (outputs: { list?: string; manifest?: string; hooks?: string }): HelmRunner =>
  async (command) => {
    if (command.startsWith("helm list")) return { stdout: outputs.list ?? "[]" };
    if (command.startsWith("helm get manifest")) return { stdout: outputs.manifest ?? "" };
    if (command.startsWith("helm get hooks")) return { stdout: outputs.hooks ?? "" };
    throw new Error(`unexpected command: ${command}`);
  };

const entities = new Map([["chart", { entityType: "Helm::Chart", props: { name: "web-app" } }]]);
const baseOptions = {
  environment: "prod",
  buildOutput: "",
  entityNames: ["chart"],
  entities,
};

const liveDeployment = {
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: {
    name: "web-app",
    namespace: "prod",
    uid: "uid-dep",
    resourceVersion: "9",
    managedFields: [
      {
        manager: "hpa-controller",
        operation: "Update",
        fieldsType: "FieldsV1",
        fieldsV1: { "f:spec": { "f:replicas": {} } },
      },
    ],
  },
  spec: { replicas: 3 },
  status: { readyReplicas: 3, replicas: 3 },
};

const liveSecret = {
  apiVersion: "v1",
  kind: "Secret",
  metadata: { name: "web-app-creds", namespace: "prod", uid: "uid-sec" },
  data: { password: "aHVudGVyMg==" },
};

describe("helm observeResourcesDeep (#1247)", () => {
  test("the hooks ARE the k8s lexicon's — delegation, not a copy", () => {
    expect(helmDeepNormalizationHooks).toBe(k8sDeepNormalizationHooks);
  });

  test("deep rows come from the live cluster through the k8s machinery, keyed like the thin rows", async () => {
    const cluster = fakeCluster({
      objects: {
        [objectKey("apps/v1", "Deployment", "web-app", "prod")]: liveDeployment,
        [objectKey("v1", "Secret", "web-app-creds", "prod")]: liveSecret,
      },
    });
    const result = normalizeDeepObservation(
      await observeResourcesDeepHelm(baseOptions, {
        run: scripted({ list: LIST, manifest: MANIFEST }),
        connect: cluster.connector,
      }),
    );

    const dep = result.resources["Deployment/prod/web-app"];
    expect(dep).toBeDefined();
    expect(dep.type).toBe("K8s::Apps::Deployment");
    // The live value, not the declared one — this is what property drift diffs.
    expect((dep.properties.spec as { replicas?: number }).replicas).toBe(3);
    expect(result.unobserved).toEqual({});
  });

  test("normalization and masking come along for free via the k8s hooks: status pruned, Secret values masked", async () => {
    const cluster = fakeCluster({
      objects: {
        [objectKey("apps/v1", "Deployment", "web-app", "prod")]: liveDeployment,
        [objectKey("v1", "Secret", "web-app-creds", "prod")]: liveSecret,
      },
    });
    const result = normalizeDeepObservation(
      await observeResourcesDeepHelm(baseOptions, {
        run: scripted({ list: LIST, manifest: MANIFEST }),
        connect: cluster.connector,
      }),
    );

    const dep = result.resources["Deployment/prod/web-app"];
    // Server-populated envelope fields are pruned by the shared rules.
    expect(dep.properties.status).toBeUndefined();
    expect((dep.properties.metadata as Record<string, unknown>).uid).toBeUndefined();

    // Secret material never reaches a consumer — masked, not returned.
    const secret = result.resources["Secret/prod/web-app-creds"];
    expect((secret.properties.data as Record<string, unknown>).password).toBe(MASKED);
    expect(JSON.stringify(secret.properties)).not.toContain("aHVudGVyMg==");
  });

  test("managed-fields ownership rides through: the drift line can name the manager (#1189)", async () => {
    const cluster = fakeCluster({
      objects: { [objectKey("apps/v1", "Deployment", "web-app", "prod")]: liveDeployment },
    });
    const result = normalizeDeepObservation(
      await observeResourcesDeepHelm(baseOptions, {
        run: scripted({ list: LIST, manifest: MANIFEST }),
        connect: cluster.connector,
      }),
    );
    const dep = result.resources["Deployment/prod/web-app"];
    expect(dep.fieldOwners?.["spec.replicas"]).toBe("hpa-controller");
  });

  test("a rendered resource absent live is an absence, not a hole — the thin read owns existence", async () => {
    const cluster = fakeCluster({
      objects: { [objectKey("apps/v1", "Deployment", "web-app", "prod")]: liveDeployment },
    });
    const result = normalizeDeepObservation(
      await observeResourcesDeepHelm(baseOptions, {
        run: scripted({ list: LIST, manifest: MANIFEST }),
        connect: cluster.connector,
      }),
    );
    expect(result.resources["Secret/prod/web-app-creds"]).toBeUndefined();
    expect(result.unobserved["Secret/prod/web-app-creds"]).toBeUndefined();
  });

  test("a helm-side failure is a hole with a total reason, never a thin-but-clean tree (#1089)", async () => {
    const result = normalizeDeepObservation(
      await observeResourcesDeepHelm(baseOptions, {
        run: async () => {
          throw Object.assign(new Error("helm: command not found"), { code: 127 });
        },
        connect: fakeCluster().connector,
      }),
    );
    expect(result.resources).toEqual({});
    expect(result.unobserved.chart.reason).toBe("no-credentials");
  });
});
