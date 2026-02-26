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
import { HelmBatchJob } from "./helm-batch-job";
import { HelmMonitoredService } from "./helm-monitored-service";
import { HelmSecureIngress } from "./helm-secure-ingress";
import { HelmNamespaceEnv } from "./helm-namespace-env";

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

  test("omitted security/scheduling props produce no values change", () => {
    const result = HelmWebApp({ name: "app" });
    const vals = result.values as any;
    expect(vals.podSecurityContext).toBeUndefined();
    expect(vals.securityContext).toBeUndefined();
    expect(vals.nodeSelector).toBeUndefined();
    expect(vals.tolerations).toBeUndefined();
    expect(vals.affinity).toBeUndefined();
    expect(vals.podAnnotations).toBeUndefined();
    expect(vals.livenessProbe).toBeUndefined();
    expect(vals.readinessProbe).toBeUndefined();
    expect(vals.strategy).toBeUndefined();
  });

  test("security context props flow through to values", () => {
    const result = HelmWebApp({
      name: "app",
      podSecurityContext: { runAsNonRoot: true },
      securityContext: { readOnlyRootFilesystem: true },
    });
    const vals = result.values as any;
    expect(vals.podSecurityContext).toEqual({ runAsNonRoot: true });
    expect(vals.securityContext).toEqual({ readOnlyRootFilesystem: true });
  });

  test("scheduling props flow through to values", () => {
    const result = HelmWebApp({
      name: "app",
      nodeSelector: { "kubernetes.io/os": "linux" },
      tolerations: [{ key: "special", operator: "Exists" }],
      affinity: { nodeAffinity: {} },
    });
    const vals = result.values as any;
    expect(vals.nodeSelector).toEqual({ "kubernetes.io/os": "linux" });
    expect(vals.tolerations).toHaveLength(1);
    expect(vals.affinity).toBeDefined();
  });

  test("probe and strategy props flow through to values", () => {
    const result = HelmWebApp({
      name: "app",
      livenessProbe: { httpGet: { path: "/healthz", port: "http" } },
      readinessProbe: { httpGet: { path: "/readyz", port: "http" } },
      strategy: { type: "RollingUpdate" },
    });
    const vals = result.values as any;
    expect(vals.livenessProbe).toBeDefined();
    expect(vals.readinessProbe).toBeDefined();
    expect(vals.strategy).toBeDefined();
  });

  test("podAnnotations flows through to values", () => {
    const result = HelmWebApp({
      name: "app",
      podAnnotations: { "prometheus.io/scrape": "true" },
    });
    const vals = result.values as any;
    expect(vals.podAnnotations).toEqual({ "prometheus.io/scrape": "true" });
  });

  test("scheduling props use With() intrinsics in deployment", () => {
    const result = HelmWebApp({
      name: "app",
      nodeSelector: { "kubernetes.io/os": "linux" },
    });
    const podSpec = (result.deployment as any).spec.template.spec;
    expect(hasIntrinsic(podSpec.nodeSelector)).toBe(true);
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

  test("no serviceAccount by default", () => {
    const result = HelmStatefulService({ name: "db" });
    expect(result.serviceAccount).toBeUndefined();
  });

  test("serviceAccount can be enabled", () => {
    const result = HelmStatefulService({ name: "db", serviceAccount: true });
    expect(result.serviceAccount).toBeDefined();
    const vals = result.values as any;
    expect(vals.serviceAccount).toBeDefined();
  });

  test("omitted security/scheduling props produce no change", () => {
    const result = HelmStatefulService({ name: "db" });
    const vals = result.values as any;
    expect(vals.podSecurityContext).toBeUndefined();
    expect(vals.nodeSelector).toBeUndefined();
    expect(vals.livenessProbe).toBeUndefined();
    expect(vals.updateStrategy).toBeUndefined();
  });

  test("security and scheduling props flow through", () => {
    const result = HelmStatefulService({
      name: "db",
      podSecurityContext: { runAsNonRoot: true },
      nodeSelector: { "kubernetes.io/os": "linux" },
      livenessProbe: { tcpSocket: { port: 5432 } },
      readinessProbe: { tcpSocket: { port: 5432 } },
      updateStrategy: { type: "RollingUpdate" },
    });
    const vals = result.values as any;
    expect(vals.podSecurityContext).toBeDefined();
    expect(vals.nodeSelector).toBeDefined();
    expect(vals.livenessProbe).toBeDefined();
    expect(vals.readinessProbe).toBeDefined();
    expect(vals.updateStrategy).toBeDefined();
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

  test("omitted props produce no change", () => {
    const result = HelmCronJob({ name: "job" });
    const vals = result.values as any;
    expect(vals.podSecurityContext).toBeUndefined();
    expect(vals.concurrencyPolicy).toBeUndefined();
    expect(vals.backoffLimit).toBeUndefined();
    expect(result.serviceAccount).toBeUndefined();
  });

  test("job control props flow through", () => {
    const result = HelmCronJob({
      name: "job",
      concurrencyPolicy: "Forbid",
      successfulJobsHistoryLimit: 3,
      failedJobsHistoryLimit: 1,
      backoffLimit: 2,
    });
    const vals = result.values as any;
    expect(vals.concurrencyPolicy).toBe("Forbid");
    expect(vals.successfulJobsHistoryLimit).toBe(3);
    expect(vals.failedJobsHistoryLimit).toBe(1);
    expect(vals.backoffLimit).toBe(2);
  });

  test("serviceAccount can be enabled", () => {
    const result = HelmCronJob({ name: "job", serviceAccount: true });
    expect(result.serviceAccount).toBeDefined();
    const vals = result.values as any;
    expect(vals.serviceAccount).toBeDefined();
  });

  test("security and scheduling props flow through", () => {
    const result = HelmCronJob({
      name: "job",
      podSecurityContext: { runAsNonRoot: true },
      securityContext: { readOnlyRootFilesystem: true },
      nodeSelector: { "kubernetes.io/os": "linux" },
    });
    const vals = result.values as any;
    expect(vals.podSecurityContext).toBeDefined();
    expect(vals.securityContext).toBeDefined();
    expect(vals.nodeSelector).toBeDefined();
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

  test("omitted security/scheduling props produce no change", () => {
    const result = HelmMicroservice({ name: "api" });
    const vals = result.values as any;
    expect(vals.podSecurityContext).toBeUndefined();
    expect(vals.securityContext).toBeUndefined();
    expect(vals.nodeSelector).toBeUndefined();
    expect(vals.strategy).toBeUndefined();
  });

  test("security and scheduling props flow through", () => {
    const result = HelmMicroservice({
      name: "api",
      podSecurityContext: { runAsNonRoot: true },
      securityContext: { readOnlyRootFilesystem: true },
      nodeSelector: { "kubernetes.io/os": "linux" },
      tolerations: [{ key: "special", operator: "Exists" }],
      affinity: { nodeAffinity: {} },
      podAnnotations: { "prometheus.io/scrape": "true" },
      strategy: { type: "RollingUpdate" },
    });
    const vals = result.values as any;
    expect(vals.podSecurityContext).toBeDefined();
    expect(vals.securityContext).toBeDefined();
    expect(vals.nodeSelector).toBeDefined();
    expect(vals.tolerations).toHaveLength(1);
    expect(vals.affinity).toBeDefined();
    expect(vals.podAnnotations).toBeDefined();
    expect(vals.strategy).toBeDefined();
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

  test("nodeSelector uses With() intrinsic", () => {
    const result = HelmDaemonSet({ name: "agent" });
    const podSpec = (result.daemonSet as any).spec.template.spec;
    expect(hasIntrinsic(podSpec.nodeSelector)).toBe(true);
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

// ── New composites ────────────────────────────────────────

describe("HelmBatchJob", () => {
  test("returns chart, values, and job", () => {
    const result = HelmBatchJob({ name: "migrate" });
    expect(result.chart).toBeDefined();
    expect(result.values).toBeDefined();
    expect(result.job).toBeDefined();
  });

  test("chart has correct metadata", () => {
    const result = HelmBatchJob({ name: "migrate" });
    expect(result.chart.name).toBe("migrate");
    expect(result.chart.apiVersion).toBe("v2");
    expect(result.chart.type).toBe("application");
  });

  test("includes serviceAccount by default", () => {
    const result = HelmBatchJob({ name: "migrate" });
    expect(result.serviceAccount).toBeDefined();
    const vals = result.values as any;
    expect(vals.serviceAccount).toBeDefined();
  });

  test("can exclude serviceAccount", () => {
    const result = HelmBatchJob({ name: "migrate", serviceAccount: false });
    expect(result.serviceAccount).toBeUndefined();
  });

  test("no RBAC by default", () => {
    const result = HelmBatchJob({ name: "migrate" });
    expect(result.role).toBeUndefined();
    expect(result.roleBinding).toBeUndefined();
  });

  test("RBAC creates Role and RoleBinding when enabled", () => {
    const result = HelmBatchJob({ name: "migrate", rbac: true });
    expect(result.role).toBeDefined();
    expect(result.roleBinding).toBeDefined();
    expect((result.role as any).kind).toBe("Role");
    expect((result.roleBinding as any).kind).toBe("RoleBinding");
    const vals = result.values as any;
    expect(vals.rbac).toBeDefined();
    expect(vals.rbac.rules).toEqual([]);
  });

  test("default job settings", () => {
    const result = HelmBatchJob({ name: "migrate" });
    const vals = result.values as any;
    expect(vals.job.backoffLimit).toBe(6);
    expect(vals.job.completions).toBe(1);
    expect(vals.job.parallelism).toBe(1);
    expect(vals.restartPolicy).toBe("OnFailure");
  });

  test("custom job settings flow through", () => {
    const result = HelmBatchJob({
      name: "migrate",
      backoffLimit: 3,
      completions: 5,
      parallelism: 2,
      restartPolicy: "Never",
      ttlSecondsAfterFinished: 300,
    });
    const vals = result.values as any;
    expect(vals.job.backoffLimit).toBe(3);
    expect(vals.job.completions).toBe(5);
    expect(vals.job.parallelism).toBe(2);
    expect(vals.restartPolicy).toBe("Never");
    expect(vals.job.ttlSecondsAfterFinished).toBe(300);
  });

  test("default image is busybox", () => {
    const result = HelmBatchJob({ name: "migrate" });
    const vals = result.values as any;
    expect(vals.image.repository).toBe("busybox");
    expect(vals.image.tag).toBe("latest");
  });

  test("uses Helm intrinsics", () => {
    const result = HelmBatchJob({ name: "migrate" });
    expect(hasIntrinsic(result.job)).toBe(true);
  });

  test("security props flow through", () => {
    const result = HelmBatchJob({
      name: "migrate",
      podSecurityContext: { runAsNonRoot: true },
      securityContext: { readOnlyRootFilesystem: true },
    });
    const vals = result.values as any;
    expect(vals.podSecurityContext).toBeDefined();
    expect(vals.securityContext).toBeDefined();
  });

  test("scheduling props use With() intrinsic", () => {
    const result = HelmBatchJob({
      name: "migrate",
      nodeSelector: { "kubernetes.io/os": "linux" },
      tolerations: [{ key: "special", operator: "Exists" }],
    });
    const vals = result.values as any;
    expect(vals.nodeSelector).toBeDefined();
    expect(vals.tolerations).toHaveLength(1);
    const podSpec = (result.job as any).spec.template.spec;
    expect(hasIntrinsic(podSpec.nodeSelector)).toBe(true);
  });
});

describe("HelmMonitoredService", () => {
  test("returns chart, values, deployment, service, and serviceMonitor", () => {
    const result = HelmMonitoredService({ name: "api" });
    expect(result.chart).toBeDefined();
    expect(result.values).toBeDefined();
    expect(result.deployment).toBeDefined();
    expect(result.service).toBeDefined();
    expect(result.serviceMonitor).toBeDefined();
  });

  test("chart has correct metadata", () => {
    const result = HelmMonitoredService({ name: "api" });
    expect(result.chart.name).toBe("api");
    expect(result.chart.type).toBe("application");
  });

  test("includes serviceAccount by default", () => {
    const result = HelmMonitoredService({ name: "api" });
    expect(result.serviceAccount).toBeDefined();
  });

  test("can exclude serviceAccount", () => {
    const result = HelmMonitoredService({ name: "api", serviceAccount: false });
    expect(result.serviceAccount).toBeUndefined();
  });

  test("no PrometheusRule by default", () => {
    const result = HelmMonitoredService({ name: "api" });
    expect(result.prometheusRule).toBeUndefined();
  });

  test("PrometheusRule created when alertRules enabled", () => {
    const result = HelmMonitoredService({ name: "api", alertRules: true });
    expect(result.prometheusRule).toBeDefined();
    const vals = result.values as any;
    expect(vals.alerting).toBeDefined();
    expect(vals.alerting.rules).toEqual([]);
  });

  test("default monitoring config", () => {
    const result = HelmMonitoredService({ name: "api" });
    const vals = result.values as any;
    expect(vals.monitoring.enabled).toBe(true);
    expect(vals.monitoring.metricsPort).toBe(9090);
    expect(vals.monitoring.metricsPath).toBe("/metrics");
    expect(vals.monitoring.scrapeInterval).toBe("30s");
  });

  test("custom monitoring config", () => {
    const result = HelmMonitoredService({
      name: "api",
      metricsPort: 8081,
      metricsPath: "/actuator/prometheus",
      scrapeInterval: "15s",
    });
    const vals = result.values as any;
    expect(vals.monitoring.metricsPort).toBe(8081);
    expect(vals.monitoring.metricsPath).toBe("/actuator/prometheus");
    expect(vals.monitoring.scrapeInterval).toBe("15s");
  });

  test("service exposes both http and metrics ports", () => {
    const result = HelmMonitoredService({ name: "api" });
    const ports = (result.service as any).spec.ports;
    expect(ports).toHaveLength(2);
    expect(ports[0].name).toBe("http");
    expect(ports[1].name).toBe("metrics");
  });

  test("container has both http and metrics ports", () => {
    const result = HelmMonitoredService({ name: "api" });
    const container = (result.deployment as any).spec.template.spec.containers[0];
    expect(container.ports).toHaveLength(2);
  });

  test("serviceMonitor uses Helm intrinsics", () => {
    const result = HelmMonitoredService({ name: "api" });
    expect(hasIntrinsic(result.serviceMonitor)).toBe(true);
  });

  test("uses Helm intrinsics in deployment", () => {
    const result = HelmMonitoredService({ name: "api" });
    expect(hasIntrinsic(result.deployment)).toBe(true);
  });

  test("security and scheduling props flow through", () => {
    const result = HelmMonitoredService({
      name: "api",
      podSecurityContext: { runAsNonRoot: true },
      nodeSelector: { "kubernetes.io/os": "linux" },
      affinity: { nodeAffinity: {} },
    });
    const vals = result.values as any;
    expect(vals.podSecurityContext).toBeDefined();
    expect(vals.nodeSelector).toBeDefined();
    expect(vals.affinity).toBeDefined();
  });

  test("default replicas is 2", () => {
    const result = HelmMonitoredService({ name: "api" });
    const vals = result.values as any;
    expect(vals.replicaCount).toBe(2);
  });
});

describe("HelmSecureIngress", () => {
  test("returns chart, values, ingress, and certificate", () => {
    const result = HelmSecureIngress({ name: "web" });
    expect(result.chart).toBeDefined();
    expect(result.values).toBeDefined();
    expect(result.ingress).toBeDefined();
    expect(result.certificate).toBeDefined();
  });

  test("chart has correct metadata", () => {
    const result = HelmSecureIngress({ name: "web" });
    expect(result.chart.name).toBe("web");
    expect(result.chart.type).toBe("application");
  });

  test("default values include ingress and certManager config", () => {
    const result = HelmSecureIngress({ name: "web" });
    const vals = result.values as any;
    expect(vals.ingress.enabled).toBe(true);
    expect(vals.ingress.tls.enabled).toBe(true);
    expect(vals.certManager.enabled).toBe(true);
    expect(vals.certManager.clusterIssuer).toBe("letsencrypt-prod");
  });

  test("custom clusterIssuer flows through", () => {
    const result = HelmSecureIngress({ name: "web", clusterIssuer: "letsencrypt-staging" });
    const vals = result.values as any;
    expect(vals.certManager.clusterIssuer).toBe("letsencrypt-staging");
  });

  test("custom ingressClassName flows through", () => {
    const result = HelmSecureIngress({ name: "web", ingressClassName: "nginx" });
    const vals = result.values as any;
    expect(vals.ingress.className).toBe("nginx");
  });

  test("ingress uses Helm intrinsics", () => {
    const result = HelmSecureIngress({ name: "web" });
    expect(hasIntrinsic(result.ingress)).toBe(true);
  });

  test("certificate uses Helm intrinsics", () => {
    const result = HelmSecureIngress({ name: "web" });
    expect(hasIntrinsic(result.certificate!)).toBe(true);
  });

  test("ingress uses Range for hosts", () => {
    const result = HelmSecureIngress({ name: "web" });
    expect(hasIntrinsic(result.ingress)).toBe(true);
  });

  test("default host includes chart name", () => {
    const result = HelmSecureIngress({ name: "web" });
    const vals = result.values as any;
    expect(vals.ingress.hosts[0].host).toBe("web.example.com");
  });
});

describe("HelmNamespaceEnv", () => {
  test("returns chart, values, and namespace", () => {
    const result = HelmNamespaceEnv({ name: "dev" });
    expect(result.chart).toBeDefined();
    expect(result.values).toBeDefined();
    expect(result.namespace).toBeDefined();
  });

  test("chart has correct metadata", () => {
    const result = HelmNamespaceEnv({ name: "dev" });
    expect(result.chart.name).toBe("dev");
    expect(result.chart.type).toBe("application");
  });

  test("includes all governance resources by default", () => {
    const result = HelmNamespaceEnv({ name: "dev" });
    expect(result.resourceQuota).toBeDefined();
    expect(result.limitRange).toBeDefined();
    expect(result.networkPolicy).toBeDefined();
  });

  test("can exclude resourceQuota", () => {
    const result = HelmNamespaceEnv({ name: "dev", resourceQuota: false });
    expect(result.resourceQuota).toBeUndefined();
    const vals = result.values as any;
    expect(vals.resourceQuota).toBeUndefined();
  });

  test("can exclude limitRange", () => {
    const result = HelmNamespaceEnv({ name: "dev", limitRange: false });
    expect(result.limitRange).toBeUndefined();
    const vals = result.values as any;
    expect(vals.limitRange).toBeUndefined();
  });

  test("can exclude networkPolicy", () => {
    const result = HelmNamespaceEnv({ name: "dev", networkPolicy: false });
    expect(result.networkPolicy).toBeUndefined();
    const vals = result.values as any;
    expect(vals.networkPolicy).toBeUndefined();
  });

  test("can exclude all optional resources", () => {
    const result = HelmNamespaceEnv({
      name: "dev",
      resourceQuota: false,
      limitRange: false,
      networkPolicy: false,
    });
    expect(result.resourceQuota).toBeUndefined();
    expect(result.limitRange).toBeUndefined();
    expect(result.networkPolicy).toBeUndefined();
  });

  test("default resourceQuota values", () => {
    const result = HelmNamespaceEnv({ name: "dev" });
    const vals = result.values as any;
    expect(vals.resourceQuota.enabled).toBe(true);
    expect(vals.resourceQuota.hard.cpu).toBe("10");
    expect(vals.resourceQuota.hard.memory).toBe("20Gi");
    expect(vals.resourceQuota.hard.pods).toBe("50");
  });

  test("default limitRange values", () => {
    const result = HelmNamespaceEnv({ name: "dev" });
    const vals = result.values as any;
    expect(vals.limitRange.enabled).toBe(true);
    expect(vals.limitRange.default.cpu).toBe("500m");
    expect(vals.limitRange.defaultRequest.cpu).toBe("100m");
  });

  test("default networkPolicy values", () => {
    const result = HelmNamespaceEnv({ name: "dev" });
    const vals = result.values as any;
    expect(vals.networkPolicy.enabled).toBe(true);
    expect(vals.networkPolicy.denyIngress).toBe(true);
    expect(vals.networkPolicy.denyEgress).toBe(false);
  });

  test("namespace uses Helm intrinsics", () => {
    const result = HelmNamespaceEnv({ name: "dev" });
    expect(hasIntrinsic(result.namespace)).toBe(true);
  });

  test("governance resources use If() conditional", () => {
    const result = HelmNamespaceEnv({ name: "dev" });
    expect(hasIntrinsic(result.resourceQuota!)).toBe(true);
    expect(hasIntrinsic(result.limitRange!)).toBe(true);
    expect(hasIntrinsic(result.networkPolicy!)).toBe(true);
  });
});
