import { describe, test, expect } from "bun:test";
import { INTRINSIC_MARKER } from "@intentius/chant/intrinsic";
import { HelmWebApp } from "./helm-web-app";
import { HelmStatefulService } from "./helm-stateful-service";
import { HelmCronJob } from "./helm-cron-job";
import { HelmMicroservice } from "./helm-microservice";
import { HelmLibrary } from "./helm-library";
import { HelmCRDLifecycle } from "./helm-crd-lifecycle";
import { HelmDaemonSet } from "./helm-daemon-set";
import { HelmWorker } from "./helm-worker";
import { HelmExternalSecret } from "./helm-external-secret";

function hasIntrinsic(obj: unknown): boolean {
  if (obj && typeof obj === "object" && INTRINSIC_MARKER in (obj as any)) return true;
  if (obj && typeof obj === "object") {
    for (const v of Object.values(obj as Record<string, unknown>)) {
      if (hasIntrinsic(v)) return true;
    }
  }
  if (Array.isArray(obj)) {
    for (const v of obj) {
      if (hasIntrinsic(v)) return true;
    }
  }
  return false;
}

describe("HelmWebApp", () => {
  test("returns chart, values, deployment, and service", () => {
    const result = HelmWebApp({ name: "my-app" });
    expect(result.chart).toBeDefined();
    expect(result.values).toBeDefined();
    expect(result.deployment).toBeDefined();
    expect(result.service).toBeDefined();
  });

  test("chart has correct metadata", () => {
    const result = HelmWebApp({ name: "web-ui" });
    expect(result.chart.name).toBe("web-ui");
    expect(result.chart.apiVersion).toBe("v2");
    expect(result.chart.type).toBe("application");
  });

  test("values include default image and service config", () => {
    const result = HelmWebApp({ name: "app" });
    const vals = result.values as any;
    expect(vals.image.repository).toBe("nginx");
    expect(vals.service.port).toBe(80);
    expect(vals.replicaCount).toBe(1);
  });

  test("custom props flow through to values", () => {
    const result = HelmWebApp({
      name: "api",
      imageRepository: "myregistry/api",
      port: 3000,
      replicas: 3,
    });
    const vals = result.values as any;
    expect(vals.image.repository).toBe("myregistry/api");
    expect(vals.service.port).toBe(3000);
    expect(vals.replicaCount).toBe(3);
  });

  test("includes ingress, hpa, and serviceAccount by default", () => {
    const result = HelmWebApp({ name: "app" });
    expect(result.ingress).toBeDefined();
    expect(result.hpa).toBeDefined();
    expect(result.serviceAccount).toBeDefined();
  });

  test("can exclude optional resources", () => {
    const result = HelmWebApp({ name: "app", ingress: false, autoscaling: false, serviceAccount: false });
    expect(result.ingress).toBeUndefined();
    expect(result.hpa).toBeUndefined();
    expect(result.serviceAccount).toBeUndefined();
  });

  test("deployment uses Helm intrinsics", () => {
    const result = HelmWebApp({ name: "app" });
    expect(hasIntrinsic(result.deployment)).toBe(true);
  });
});

describe("HelmStatefulService", () => {
  test("returns chart, values, statefulSet, and service", () => {
    const result = HelmStatefulService({ name: "db" });
    expect(result.chart).toBeDefined();
    expect(result.values).toBeDefined();
    expect(result.statefulSet).toBeDefined();
    expect(result.service).toBeDefined();
  });

  test("chart is marked as application", () => {
    const result = HelmStatefulService({ name: "db" });
    expect(result.chart.type).toBe("application");
  });

  test("service is headless (clusterIP: None)", () => {
    const result = HelmStatefulService({ name: "db" });
    expect((result.service as any).spec.clusterIP).toBe("None");
  });

  test("statefulSet has volumeClaimTemplates", () => {
    const result = HelmStatefulService({ name: "db" });
    const spec = (result.statefulSet as any).spec;
    expect(spec.volumeClaimTemplates).toBeDefined();
    expect(spec.volumeClaimTemplates).toHaveLength(1);
  });

  test("values include persistence config", () => {
    const result = HelmStatefulService({ name: "db", storageSize: "50Gi" });
    const vals = result.values as any;
    expect(vals.persistence.size).toBe("50Gi");
  });

  test("uses Helm intrinsics", () => {
    const result = HelmStatefulService({ name: "db" });
    expect(hasIntrinsic(result.statefulSet)).toBe(true);
  });
});

describe("HelmCronJob", () => {
  test("returns chart, values, and cronJob", () => {
    const result = HelmCronJob({ name: "cleanup" });
    expect(result.chart).toBeDefined();
    expect(result.values).toBeDefined();
    expect(result.cronJob).toBeDefined();
  });

  test("chart has correct name", () => {
    const result = HelmCronJob({ name: "backup" });
    expect(result.chart.name).toBe("backup");
  });

  test("default schedule is hourly", () => {
    const result = HelmCronJob({ name: "job" });
    const vals = result.values as any;
    expect(vals.schedule).toBe("0 * * * *");
  });

  test("custom schedule flows through", () => {
    const result = HelmCronJob({ name: "nightly", schedule: "0 0 * * *" });
    const vals = result.values as any;
    expect(vals.schedule).toBe("0 0 * * *");
  });

  test("uses Helm intrinsics", () => {
    const result = HelmCronJob({ name: "job" });
    expect(hasIntrinsic(result.cronJob)).toBe(true);
  });
});

describe("HelmMicroservice", () => {
  test("returns all core resources", () => {
    const result = HelmMicroservice({ name: "api" });
    expect(result.chart).toBeDefined();
    expect(result.values).toBeDefined();
    expect(result.deployment).toBeDefined();
    expect(result.service).toBeDefined();
    expect(result.serviceAccount).toBeDefined();
  });

  test("includes optional resources by default", () => {
    const result = HelmMicroservice({ name: "api" });
    expect(result.configMap).toBeDefined();
    expect(result.ingress).toBeDefined();
    expect(result.hpa).toBeDefined();
    expect(result.pdb).toBeDefined();
  });

  test("can exclude optional resources", () => {
    const result = HelmMicroservice({
      name: "api",
      ingress: false,
      autoscaling: false,
      pdb: false,
      configMap: false,
    });
    expect(result.configMap).toBeUndefined();
    expect(result.ingress).toBeUndefined();
    expect(result.hpa).toBeUndefined();
    expect(result.pdb).toBeUndefined();
  });

  test("default port is 8080", () => {
    const result = HelmMicroservice({ name: "api" });
    const vals = result.values as any;
    expect(vals.service.port).toBe(8080);
  });

  test("default replicas is 2", () => {
    const result = HelmMicroservice({ name: "api" });
    const vals = result.values as any;
    expect(vals.replicaCount).toBe(2);
  });

  test("values include health probes", () => {
    const result = HelmMicroservice({ name: "api" });
    const vals = result.values as any;
    expect(vals.livenessProbe).toBeDefined();
    expect(vals.readinessProbe).toBeDefined();
  });

  test("values include resource limits and requests", () => {
    const result = HelmMicroservice({ name: "api" });
    const vals = result.values as any;
    expect(vals.resources.limits).toBeDefined();
    expect(vals.resources.requests).toBeDefined();
  });

  test("uses Helm intrinsics", () => {
    const result = HelmMicroservice({ name: "api" });
    expect(hasIntrinsic(result.deployment)).toBe(true);
  });
});

describe("HelmLibrary", () => {
  test("returns chart and helpers", () => {
    const result = HelmLibrary({ name: "common" });
    expect(result.chart).toBeDefined();
    expect(result.helpers).toBeDefined();
  });

  test("chart type is library", () => {
    const result = HelmLibrary({ name: "common" });
    expect(result.chart.type).toBe("library");
  });

  test("default helpers include standard names", () => {
    const result = HelmLibrary({ name: "common" });
    expect(result.helpers).toContain("name");
    expect(result.helpers).toContain("fullname");
    expect(result.helpers).toContain("labels");
  });

  test("custom helpers override defaults", () => {
    const result = HelmLibrary({ name: "lib", helpers: ["custom-a", "custom-b"] });
    expect(result.helpers).toEqual(["custom-a", "custom-b"]);
  });

  test("dependencies are included when provided", () => {
    const result = HelmLibrary({
      name: "common",
      dependencies: [{ name: "base", version: "1.x.x", repository: "https://charts.example.com" }],
    });
    expect(result.chart.dependencies).toHaveLength(1);
  });

  test("no dependencies by default", () => {
    const result = HelmLibrary({ name: "common" });
    expect(result.chart.dependencies).toBeUndefined();
  });
});

describe("HelmCRDLifecycle", () => {
  test("returns all expected resources", () => {
    const result = HelmCRDLifecycle({
      name: "my-operator",
      crdContent: "apiVersion: apiextensions.k8s.io/v1\nkind: CustomResourceDefinition\n",
    });
    expect(result.chart).toBeDefined();
    expect(result.values).toBeDefined();
    expect(result.crdInstallJob).toBeDefined();
    expect(result.crdConfigMap).toBeDefined();
    expect(result.serviceAccount).toBeDefined();
    expect(result.clusterRole).toBeDefined();
    expect(result.clusterRoleBinding).toBeDefined();
  });

  test("Job has hook annotations", () => {
    const result = HelmCRDLifecycle({
      name: "my-operator",
      crdContent: "apiVersion: apiextensions.k8s.io/v1\nkind: CustomResourceDefinition\n",
    });
    const jobMeta = (result.crdInstallJob as any).metadata;
    expect(jobMeta.annotations["helm.sh/hook"]).toBe("pre-install,pre-upgrade");
    expect(jobMeta.annotations["helm.sh/hook-weight"]).toBe("-5");
    expect(jobMeta.annotations["helm.sh/hook-delete-policy"]).toBe("before-hook-creation");
  });

  test("ClusterRole has correct rules", () => {
    const result = HelmCRDLifecycle({
      name: "my-operator",
      crdContent: "crd content",
    });
    const rules = (result.clusterRole as any).rules;
    expect(rules).toHaveLength(1);
    expect(rules[0].apiGroups).toContain("apiextensions.k8s.io");
    expect(rules[0].resources).toContain("customresourcedefinitions");
  });

  test("ConfigMap contains CRD content", () => {
    const crdContent = "apiVersion: apiextensions.k8s.io/v1\nkind: CRD\n";
    const result = HelmCRDLifecycle({
      name: "my-operator",
      crdContent,
    });
    expect((result.crdConfigMap as any).data["crds.yaml"]).toBe(crdContent);
  });

  test("uses Helm intrinsics", () => {
    const result = HelmCRDLifecycle({
      name: "my-operator",
      crdContent: "crd",
    });
    expect(hasIntrinsic(result.crdInstallJob)).toBe(true);
    expect(hasIntrinsic(result.clusterRoleBinding)).toBe(true);
  });

  test("custom kubectl image flows through to values", () => {
    const result = HelmCRDLifecycle({
      name: "my-operator",
      crdContent: "crd",
      kubectlImage: "custom/kubectl",
      kubectlTag: "1.28",
    });
    const vals = result.values as any;
    expect(vals.crdLifecycle.kubectl.image).toBe("custom/kubectl");
    expect(vals.crdLifecycle.kubectl.tag).toBe("1.28");
  });
});

describe("HelmDaemonSet", () => {
  test("returns chart, values, and daemonSet", () => {
    const result = HelmDaemonSet({ name: "log-agent" });
    expect(result.chart).toBeDefined();
    expect(result.values).toBeDefined();
    expect(result.daemonSet).toBeDefined();
  });

  test("includes serviceAccount by default", () => {
    const result = HelmDaemonSet({ name: "log-agent" });
    expect(result.serviceAccount).toBeDefined();
  });

  test("can exclude serviceAccount", () => {
    const result = HelmDaemonSet({ name: "log-agent", serviceAccount: false });
    expect(result.serviceAccount).toBeUndefined();
  });

  test("DaemonSet has RollingUpdate strategy in values", () => {
    const result = HelmDaemonSet({ name: "log-agent" });
    const vals = result.values as any;
    expect(vals.updateStrategy.type).toBe("RollingUpdate");
  });

  test("default image is fluent-bit", () => {
    const result = HelmDaemonSet({ name: "log-agent" });
    const vals = result.values as any;
    expect(vals.image.repository).toBe("fluent/fluent-bit");
  });

  test("custom props flow through", () => {
    const result = HelmDaemonSet({
      name: "metrics",
      imageRepository: "prom/node-exporter",
      imageTag: "v1.6.0",
      port: 9100,
    });
    const vals = result.values as any;
    expect(vals.image.repository).toBe("prom/node-exporter");
    expect(vals.image.tag).toBe("v1.6.0");
  });

  test("uses Helm intrinsics", () => {
    const result = HelmDaemonSet({ name: "agent" });
    expect(hasIntrinsic(result.daemonSet)).toBe(true);
  });
});

describe("HelmWorker", () => {
  test("returns chart, values, deployment, and serviceAccount", () => {
    const result = HelmWorker({ name: "job-processor" });
    expect(result.chart).toBeDefined();
    expect(result.values).toBeDefined();
    expect(result.deployment).toBeDefined();
    expect(result.serviceAccount).toBeDefined();
  });

  test("no service by default (workers don't serve HTTP)", () => {
    const result = HelmWorker({ name: "job-processor" });
    expect((result as any).service).toBeUndefined();
  });

  test("default replicas is 2", () => {
    const result = HelmWorker({ name: "job-processor" });
    const vals = result.values as any;
    expect(vals.replicaCount).toBe(2);
  });

  test("includes PDB by default", () => {
    const result = HelmWorker({ name: "job-processor" });
    expect(result.pdb).toBeDefined();
  });

  test("no HPA by default", () => {
    const result = HelmWorker({ name: "job-processor" });
    expect(result.hpa).toBeUndefined();
  });

  test("can enable autoscaling", () => {
    const result = HelmWorker({ name: "job-processor", autoscaling: true });
    expect(result.hpa).toBeDefined();
    const vals = result.values as any;
    expect(vals.autoscaling).toBeDefined();
  });

  test("values include queue config", () => {
    const result = HelmWorker({ name: "job-processor" });
    const vals = result.values as any;
    expect(vals.queue).toBeDefined();
    expect(vals.queue.concurrency).toBe(5);
  });

  test("uses exec-based probes", () => {
    const result = HelmWorker({ name: "job-processor" });
    const vals = result.values as any;
    expect(vals.livenessProbe.exec).toBeDefined();
    expect(vals.readinessProbe.exec).toBeDefined();
  });

  test("uses Helm intrinsics", () => {
    const result = HelmWorker({ name: "job-processor" });
    expect(hasIntrinsic(result.deployment)).toBe(true);
  });
});

describe("HelmExternalSecret", () => {
  test("returns chart, values, and externalSecret", () => {
    const result = HelmExternalSecret({
      name: "app-secrets",
      secretStoreName: "vault",
      data: { API_KEY: "secret/data/api-key" },
    });
    expect(result.chart).toBeDefined();
    expect(result.values).toBeDefined();
    expect(result.externalSecret).toBeDefined();
  });

  test("externalSecret has correct apiVersion and kind", () => {
    const result = HelmExternalSecret({
      name: "app-secrets",
      secretStoreName: "vault",
      data: { API_KEY: "secret/data/api-key" },
    });
    expect((result.externalSecret as any).apiVersion).toBe("external-secrets.io/v1beta1");
    expect((result.externalSecret as any).kind).toBe("ExternalSecret");
  });

  test("data maps to secretKey/remoteRef format", () => {
    const result = HelmExternalSecret({
      name: "app-secrets",
      secretStoreName: "vault",
      data: {
        DB_PASSWORD: "secret/data/db-password",
        API_KEY: "secret/data/api-key",
      },
    });
    const spec = (result.externalSecret as any).spec;
    expect(spec.data).toHaveLength(2);
    expect(spec.data[0].secretKey).toBe("DB_PASSWORD");
    expect(spec.data[0].remoteRef.key).toBe("secret/data/db-password");
  });

  test("default secretStoreKind is ClusterSecretStore", () => {
    const result = HelmExternalSecret({
      name: "app-secrets",
      secretStoreName: "vault",
      data: { KEY: "path" },
    });
    const vals = result.values as any;
    expect(vals.externalSecret.secretStore.kind).toBe("ClusterSecretStore");
  });

  test("custom refreshInterval flows through", () => {
    const result = HelmExternalSecret({
      name: "app-secrets",
      secretStoreName: "vault",
      data: { KEY: "path" },
      refreshInterval: "30m",
    });
    const vals = result.values as any;
    expect(vals.externalSecret.refreshInterval).toBe("30m");
  });

  test("uses Helm intrinsics", () => {
    const result = HelmExternalSecret({
      name: "app-secrets",
      secretStoreName: "vault",
      data: { KEY: "path" },
    });
    expect(hasIntrinsic(result.externalSecret)).toBe(true);
  });
});
