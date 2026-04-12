import { describe, test, expect, vi } from "vitest";
import { isCompositeInstance } from "@intentius/chant";
import { emitYAML } from "@intentius/chant/yaml";
import { WebApp } from "./web-app";

/** Helper to access props on a Declarable member. */
function p(member: unknown): Record<string, unknown> {
  return (member as any).props;
}
import { StatefulApp } from "./stateful-app";
import { CronWorkload } from "./cron-workload";
import { AutoscaledService } from "./autoscaled-service";
import { WorkerPool } from "./worker-pool";
import { NamespaceEnv } from "./namespace-env";
import { NodeAgent } from "./node-agent";
import { BatchJob } from "./batch-job";
import { SecureIngress } from "./secure-ingress";
import { ConfiguredApp } from "./configured-app";
import { SidecarApp } from "./sidecar-app";
import { MonitoredService } from "./monitored-service";
import { NetworkIsolatedApp } from "./network-isolated-app";
import { IrsaServiceAccount } from "./irsa-service-account";
import { AlbIngress } from "./alb-ingress";
import { GceIngress } from "./gce-ingress";
import { EbsStorageClass } from "./ebs-storage-class";
import { EfsStorageClass } from "./efs-storage-class";
import { FluentBitAgent } from "./fluent-bit-agent";
import { ExternalDnsAgent } from "./external-dns-agent";
import { AdotCollector } from "./adot-collector";
import { MetricsServer } from "./metrics-server";
import { WorkloadIdentityServiceAccount } from "./workload-identity-service-account";
import { GcePdStorageClass } from "./gce-pd-storage-class";
import { FilestoreStorageClass } from "./filestore-storage-class";
import { GkeGateway } from "./gke-gateway";
import { ConfigConnectorContext } from "./config-connector-context";

// ── WebApp ──────────────────────────────────────────────────────────

describe("WebApp", () => {
  test("returns deployment and service", () => {
    const result = WebApp({ name: "app", image: "app:1.0" });
    expect(result.deployment).toBeDefined();
    expect(result.service).toBeDefined();
  });

  test("does not include ingress by default", () => {
    const result = WebApp({ name: "app", image: "app:1.0" });
    expect(result.ingress).toBeUndefined();
  });

  test("includes ingress when ingressHost is set", () => {
    const result = WebApp({
      name: "app",
      image: "app:1.0",
      ingressHost: "app.example.com",
    });
    expect(result.ingress).toBeDefined();
    const spec = p(result.ingress).spec as any;
    expect(spec.rules[0].host).toBe("app.example.com");
  });

  test("ingress includes TLS when ingressTlsSecret is set", () => {
    const result = WebApp({
      name: "app",
      image: "app:1.0",
      ingressHost: "app.example.com",
      ingressTlsSecret: "tls-secret",
    });
    const spec = p(result.ingress).spec as any;
    expect(spec.tls).toBeDefined();
    expect(spec.tls[0].secretName).toBe("tls-secret");
  });

  test("props flow through (image, port, replicas)", () => {
    const result = WebApp({
      name: "web",
      image: "web:2.0",
      port: 3000,
      replicas: 5,
    });
    const spec = p(result.deployment).spec as any;
    expect(spec.replicas).toBe(5);
    const container = spec.template.spec.containers[0];
    expect(container.image).toBe("web:2.0");
    expect(container.ports[0].containerPort).toBe(3000);
  });

  test("default port is 80", () => {
    const result = WebApp({ name: "app", image: "app:1.0" });
    const spec = p(result.deployment).spec as any;
    const container = spec.template.spec.containers[0];
    expect(container.ports[0].containerPort).toBe(80);
  });

  test("default replicas is 2", () => {
    const result = WebApp({ name: "app", image: "app:1.0" });
    const spec = p(result.deployment).spec as any;
    expect(spec.replicas).toBe(2);
  });

  test("service type is ClusterIP", () => {
    const result = WebApp({ name: "app", image: "app:1.0" });
    const spec = p(result.service).spec as any;
    expect(spec.type).toBe("ClusterIP");
  });

  test("includes common labels", () => {
    const result = WebApp({ name: "app", image: "app:1.0" });
    const meta = p(result.deployment).metadata as any;
    expect(meta.labels["app.kubernetes.io/name"]).toBe("app");
    expect(meta.labels["app.kubernetes.io/managed-by"]).toBe("chant");
  });

  test("namespace is set when provided", () => {
    const result = WebApp({
      name: "app",
      image: "app:1.0",
      namespace: "prod",
    });
    const meta = p(result.deployment).metadata as any;
    expect(meta.namespace).toBe("prod");
  });

  test("env vars passed to container", () => {
    const result = WebApp({
      name: "app",
      image: "app:1.0",
      env: [{ name: "FOO", value: "bar" }],
    });
    const spec = p(result.deployment).spec as any;
    const container = spec.template.spec.containers[0];
    expect(container.env).toEqual([{ name: "FOO", value: "bar" }]);
  });

  test("component labels on each resource", () => {
    const result = WebApp({
      name: "app",
      image: "app:1.0",
      ingressHost: "app.example.com",
    });
    expect((p(result.deployment).metadata as any).labels["app.kubernetes.io/component"]).toBe("server");
    expect((p(result.service).metadata as any).labels["app.kubernetes.io/component"]).toBe("server");
    expect((p(result.ingress).metadata as any).labels["app.kubernetes.io/component"]).toBe("ingress");
  });
});

// ── StatefulApp ─────────────────────────────────────────────────────

describe("StatefulApp", () => {
  test("returns statefulSet and service", () => {
    const result = StatefulApp({ name: "db", image: "postgres:16" });
    expect(result.statefulSet).toBeDefined();
    expect(result.service).toBeDefined();
  });

  test("service is headless (clusterIP: None)", () => {
    const result = StatefulApp({ name: "db", image: "postgres:16" });
    const spec = p(result.service).spec as any;
    expect(spec.clusterIP).toBe("None");
  });

  test("includes volumeClaimTemplates", () => {
    const result = StatefulApp({
      name: "db",
      image: "postgres:16",
      storageSize: "20Gi",
    });
    const spec = p(result.statefulSet).spec as any;
    expect(spec.volumeClaimTemplates).toBeDefined();
    expect(spec.volumeClaimTemplates[0].spec.resources.requests.storage).toBe(
      "20Gi",
    );
  });

  test("default port is 5432", () => {
    const result = StatefulApp({ name: "db", image: "postgres:16" });
    const spec = p(result.statefulSet).spec as any;
    const container = spec.template.spec.containers[0];
    expect(container.ports[0].containerPort).toBe(5432);
  });

  test("default replicas is 1", () => {
    const result = StatefulApp({ name: "db", image: "postgres:16" });
    const spec = p(result.statefulSet).spec as any;
    expect(spec.replicas).toBe(1);
  });

  test("serviceName matches name", () => {
    const result = StatefulApp({ name: "db", image: "postgres:16" });
    const spec = p(result.statefulSet).spec as any;
    expect(spec.serviceName).toBe("db");
  });

  test("storageClassName set when provided", () => {
    const result = StatefulApp({
      name: "db",
      image: "postgres:16",
      storageClassName: "ssd",
    });
    const spec = p(result.statefulSet).spec as any;
    expect(spec.volumeClaimTemplates[0].spec.storageClassName).toBe("ssd");
  });

  test("component labels on each resource", () => {
    const result = StatefulApp({ name: "db", image: "postgres:16" });
    expect((p(result.statefulSet).metadata as any).labels["app.kubernetes.io/component"]).toBe("database");
    expect((p(result.service).metadata as any).labels["app.kubernetes.io/component"]).toBe("database");
  });
});

// ── CronWorkload ────────────────────────────────────────────────────

describe("CronWorkload", () => {
  test("returns cronJob, serviceAccount, role, roleBinding", () => {
    const result = CronWorkload({
      name: "backup",
      image: "backup:1.0",
      schedule: "0 2 * * *",
    });
    expect(result.cronJob).toBeDefined();
    expect(result.serviceAccount).toBeDefined();
    expect(result.role).toBeDefined();
    expect(result.roleBinding).toBeDefined();
  });

  test("cronJob has correct schedule", () => {
    const result = CronWorkload({
      name: "backup",
      image: "backup:1.0",
      schedule: "0 2 * * *",
    });
    const spec = p(result.cronJob).spec as any;
    expect(spec.schedule).toBe("0 2 * * *");
  });

  test("RBAC references correct ServiceAccount", () => {
    const result = CronWorkload({
      name: "backup",
      image: "backup:1.0",
      schedule: "0 2 * * *",
    });
    const binding = p(result.roleBinding) as any;
    expect(binding.subjects[0].name).toBe("backup-sa");
    expect(binding.roleRef.name).toBe("backup-role");
  });

  test("serviceAccount name follows naming convention", () => {
    const result = CronWorkload({
      name: "cleanup",
      image: "cleanup:1.0",
      schedule: "*/5 * * * *",
    });
    const meta = p(result.serviceAccount).metadata as any;
    expect(meta.name).toBe("cleanup-sa");
  });

  test("custom RBAC rules are used", () => {
    const result = CronWorkload({
      name: "backup",
      image: "backup:1.0",
      schedule: "0 2 * * *",
      rbacRules: [
        { apiGroups: [""], resources: ["secrets"], verbs: ["get"] },
      ],
    });
    const role = p(result.role) as any;
    expect(role.rules[0].resources).toEqual(["secrets"]);
    expect(role.rules[0].verbs).toEqual(["get"]);
  });

  test("default RBAC rules when none provided", () => {
    const result = CronWorkload({
      name: "backup",
      image: "backup:1.0",
      schedule: "0 2 * * *",
    });
    const role = p(result.role) as any;
    expect(role.rules.length).toBeGreaterThan(0);
  });

  test("command and args passed through", () => {
    const result = CronWorkload({
      name: "backup",
      image: "backup:1.0",
      schedule: "0 2 * * *",
      command: ["pg_dump"],
      args: ["-h", "postgres"],
    });
    const spec = p(result.cronJob).spec as any;
    const container =
      spec.jobTemplate.spec.template.spec.containers[0];
    expect(container.command).toEqual(["pg_dump"]);
    expect(container.args).toEqual(["-h", "postgres"]);
  });

  test("default restartPolicy is OnFailure", () => {
    const result = CronWorkload({
      name: "backup",
      image: "backup:1.0",
      schedule: "0 2 * * *",
    });
    const spec = p(result.cronJob).spec as any;
    expect(spec.jobTemplate.spec.template.spec.restartPolicy).toBe(
      "OnFailure",
    );
  });

  test("includes common labels on all resources", () => {
    const result = CronWorkload({
      name: "backup",
      image: "backup:1.0",
      schedule: "0 2 * * *",
    });

    for (const resource of [
      result.cronJob,
      result.serviceAccount,
      result.role,
      result.roleBinding,
    ]) {
      const meta = p(resource).metadata as any;
      expect(meta.labels["app.kubernetes.io/name"]).toBe("backup");
    }
  });

  test("component labels on each resource", () => {
    const result = CronWorkload({
      name: "backup",
      image: "backup:1.0",
      schedule: "0 2 * * *",
    });
    expect((p(result.cronJob).metadata as any).labels["app.kubernetes.io/component"]).toBe("worker");
    expect((p(result.serviceAccount).metadata as any).labels["app.kubernetes.io/component"]).toBe("worker");
    expect((p(result.role).metadata as any).labels["app.kubernetes.io/component"]).toBe("rbac");
    expect((p(result.roleBinding).metadata as any).labels["app.kubernetes.io/component"]).toBe("rbac");
  });
});

// ── AutoscaledService ──────────────────────────────────────────────

describe("AutoscaledService", () => {
  const minProps = {
    name: "api",
    image: "api:1.0",
    maxReplicas: 10,
    cpuRequest: "100m",
    memoryRequest: "128Mi",
  };

  test("returns deployment, service, hpa, pdb", () => {
    const result = AutoscaledService(minProps);
    expect(result.deployment).toBeDefined();
    expect(result.service).toBeDefined();
    expect(result.hpa).toBeDefined();
    expect(result.pdb).toBeDefined();
  });

  test("default port is 80", () => {
    const result = AutoscaledService(minProps);
    const spec = p(result.deployment).spec as any;
    const container = spec.template.spec.containers[0];
    expect(container.ports[0].containerPort).toBe(80);
  });

  test("default minReplicas is 2", () => {
    const result = AutoscaledService(minProps);
    const spec = p(result.deployment).spec as any;
    expect(spec.replicas).toBe(2);
    const hpaSpec = p(result.hpa).spec as any;
    expect(hpaSpec.minReplicas).toBe(2);
  });

  test("HPA scaleTargetRef references the deployment", () => {
    const result = AutoscaledService(minProps);
    const hpaSpec = p(result.hpa).spec as any;
    expect(hpaSpec.scaleTargetRef.kind).toBe("Deployment");
    expect(hpaSpec.scaleTargetRef.name).toBe("api");
  });

  test("HPA has CPU metric with default 70%", () => {
    const result = AutoscaledService(minProps);
    const hpaSpec = p(result.hpa).spec as any;
    expect(hpaSpec.metrics[0].resource.name).toBe("cpu");
    expect(hpaSpec.metrics[0].resource.target.averageUtilization).toBe(70);
  });

  test("HPA includes memory metric when targetMemoryPercent set", () => {
    const result = AutoscaledService({ ...minProps, targetMemoryPercent: 80 });
    const hpaSpec = p(result.hpa).spec as any;
    expect(hpaSpec.metrics).toHaveLength(2);
    expect(hpaSpec.metrics[1].resource.name).toBe("memory");
    expect(hpaSpec.metrics[1].resource.target.averageUtilization).toBe(80);
  });

  test("no memory metric by default", () => {
    const result = AutoscaledService(minProps);
    const hpaSpec = p(result.hpa).spec as any;
    expect(hpaSpec.metrics).toHaveLength(1);
  });

  test("PDB selector matches deployment pod labels", () => {
    const result = AutoscaledService(minProps);
    const pdbSpec = p(result.pdb).spec as any;
    expect(pdbSpec.selector.matchLabels["app.kubernetes.io/name"]).toBe("api");
    expect(pdbSpec.minAvailable).toBe(1);
  });

  test("resource requests are always set", () => {
    const result = AutoscaledService(minProps);
    const spec = p(result.deployment).spec as any;
    const container = spec.template.spec.containers[0];
    expect(container.resources.requests.cpu).toBe("100m");
    expect(container.resources.requests.memory).toBe("128Mi");
  });

  test("resource limits only set when provided", () => {
    const result = AutoscaledService(minProps);
    const spec = p(result.deployment).spec as any;
    const container = spec.template.spec.containers[0];
    expect(container.resources.limits).toBeUndefined();

    const withLimits = AutoscaledService({ ...minProps, cpuLimit: "1", memoryLimit: "512Mi" });
    const spec2 = p(withLimits.deployment).spec as any;
    const container2 = spec2.template.spec.containers[0];
    expect(container2.resources.limits.cpu).toBe("1");
    expect(container2.resources.limits.memory).toBe("512Mi");
  });

  test("includes health probes", () => {
    const result = AutoscaledService(minProps);
    const spec = p(result.deployment).spec as any;
    const container = spec.template.spec.containers[0];
    expect(container.livenessProbe).toBeDefined();
    expect(container.readinessProbe).toBeDefined();
  });

  test("service type is ClusterIP", () => {
    const result = AutoscaledService(minProps);
    const spec = p(result.service).spec as any;
    expect(spec.type).toBe("ClusterIP");
  });

  test("includes common labels on all resources", () => {
    const result = AutoscaledService(minProps);
    for (const resource of [result.deployment, result.service, result.hpa, result.pdb]) {
      const meta = p(resource).metadata as any;
      expect(meta.labels["app.kubernetes.io/name"]).toBe("api");
      expect(meta.labels["app.kubernetes.io/managed-by"]).toBe("chant");
    }
  });

  test("namespace propagated to all resources", () => {
    const result = AutoscaledService({ ...minProps, namespace: "prod" });
    for (const resource of [result.deployment, result.service, result.hpa, result.pdb]) {
      const meta = p(resource).metadata as any;
      expect(meta.namespace).toBe("prod");
    }
  });

  test("env vars passed to container", () => {
    const result = AutoscaledService({
      ...minProps,
      env: [{ name: "LOG_LEVEL", value: "debug" }],
    });
    const spec = p(result.deployment).spec as any;
    const container = spec.template.spec.containers[0];
    expect(container.env).toEqual([{ name: "LOG_LEVEL", value: "debug" }]);
  });

  test("component labels on each resource", () => {
    const result = AutoscaledService(minProps);
    expect((p(result.deployment).metadata as any).labels["app.kubernetes.io/component"]).toBe("server");
    expect((p(result.service).metadata as any).labels["app.kubernetes.io/component"]).toBe("server");
    expect((p(result.hpa).metadata as any).labels["app.kubernetes.io/component"]).toBe("autoscaler");
    expect((p(result.pdb).metadata as any).labels["app.kubernetes.io/component"]).toBe("disruption-budget");
  });

  test("default probe paths are /healthz and /readyz", () => {
    const result = AutoscaledService(minProps);
    const spec = p(result.deployment).spec as any;
    const container = spec.template.spec.containers[0];
    expect(container.livenessProbe.httpGet.path).toBe("/healthz");
    expect(container.readinessProbe.httpGet.path).toBe("/readyz");
  });

  test("custom probe paths override defaults", () => {
    const result = AutoscaledService({
      ...minProps,
      livenessPath: "/alive",
      readinessPath: "/ready",
    });
    const spec = p(result.deployment).spec as any;
    const container = spec.template.spec.containers[0];
    expect(container.livenessProbe.httpGet.path).toBe("/alive");
    expect(container.readinessProbe.httpGet.path).toBe("/ready");
  });

  test("probe targets container port", () => {
    const result = AutoscaledService({ ...minProps, port: 8080 });
    const spec = p(result.deployment).spec as any;
    const container = spec.template.spec.containers[0];
    expect(container.livenessProbe.httpGet.port).toBe(8080);
    expect(container.readinessProbe.httpGet.port).toBe(8080);
  });

  test("topologySpread not present by default", () => {
    const result = AutoscaledService(minProps);
    const spec = p(result.deployment).spec as any;
    expect(spec.template.spec.topologySpreadConstraints).toBeUndefined();
  });

  test("topologySpread: true adds zone constraint", () => {
    const result = AutoscaledService({ ...minProps, topologySpread: true });
    const spec = p(result.deployment).spec as any;
    const tsc = spec.template.spec.topologySpreadConstraints;
    expect(tsc).toHaveLength(1);
    expect(tsc[0].topologyKey).toBe("topology.kubernetes.io/zone");
    expect(tsc[0].maxSkew).toBe(1);
    expect(tsc[0].whenUnsatisfiable).toBe("DoNotSchedule");
    expect(tsc[0].labelSelector.matchLabels["app.kubernetes.io/name"]).toBe("api");
  });

  test("topologySpread custom object", () => {
    const result = AutoscaledService({
      ...minProps,
      topologySpread: { maxSkew: 2, topologyKey: "kubernetes.io/hostname" },
    });
    const spec = p(result.deployment).spec as any;
    const tsc = spec.template.spec.topologySpreadConstraints;
    expect(tsc[0].maxSkew).toBe(2);
    expect(tsc[0].topologyKey).toBe("kubernetes.io/hostname");
  });

  test("minAvailable as string percentage", () => {
    const result = AutoscaledService({ ...minProps, minAvailable: "50%" });
    const pdbSpec = p(result.pdb).spec as any;
    expect(pdbSpec.minAvailable).toBe("50%");
  });

  test("custom targetCPUPercent", () => {
    const result = AutoscaledService({ ...minProps, targetCPUPercent: 85 });
    const hpaSpec = p(result.hpa).spec as any;
    expect(hpaSpec.metrics[0].resource.target.averageUtilization).toBe(85);
  });

  test("pod template labels include extra labels", () => {
    const result = AutoscaledService({ ...minProps, labels: { team: "platform" } });
    const spec = p(result.deployment).spec as any;
    const podLabels = spec.template.metadata.labels;
    expect(podLabels.team).toBe("platform");
    expect(podLabels["app.kubernetes.io/name"]).toBe("api");
  });

  test("serviceAccountName wired into pod spec", () => {
    const result = AutoscaledService({ ...minProps, serviceAccountName: "my-sa" });
    const spec = p(result.deployment).spec as any;
    expect(spec.template.spec.serviceAccountName).toBe("my-sa");
  });

  test("no serviceAccountName by default", () => {
    const result = AutoscaledService(minProps);
    const spec = p(result.deployment).spec as any;
    expect(spec.template.spec.serviceAccountName).toBeUndefined();
  });

  test("volumes and volumeMounts wired into pod spec", () => {
    const result = AutoscaledService({
      ...minProps,
      volumes: [{ name: "data", emptyDir: {} }],
      volumeMounts: [{ name: "data", mountPath: "/data" }],
    });
    const spec = p(result.deployment).spec as any;
    expect(spec.template.spec.volumes).toEqual([{ name: "data", emptyDir: {} }]);
    expect(spec.template.spec.containers[0].volumeMounts).toEqual([{ name: "data", mountPath: "/data" }]);
  });

  test("tmpDirs generates emptyDir volumes and mounts", () => {
    const result = AutoscaledService({
      ...minProps,
      tmpDirs: ["/tmp", "/var/cache/nginx"],
    });
    const spec = p(result.deployment).spec as any;
    expect(spec.template.spec.volumes).toEqual([
      { name: "tmp-0", emptyDir: {} },
      { name: "tmp-1", emptyDir: {} },
    ]);
    expect(spec.template.spec.containers[0].volumeMounts).toEqual([
      { name: "tmp-0", mountPath: "/tmp" },
      { name: "tmp-1", mountPath: "/var/cache/nginx" },
    ]);
  });

  test("tmpDirs merges with explicit volumes/volumeMounts", () => {
    const result = AutoscaledService({
      ...minProps,
      volumes: [{ name: "config", configMap: { name: "app-config" } }],
      volumeMounts: [{ name: "config", mountPath: "/etc/config" }],
      tmpDirs: ["/tmp"],
    });
    const spec = p(result.deployment).spec as any;
    expect(spec.template.spec.volumes).toEqual([
      { name: "config", configMap: { name: "app-config" } },
      { name: "tmp-0", emptyDir: {} },
    ]);
    expect(spec.template.spec.containers[0].volumeMounts).toEqual([
      { name: "config", mountPath: "/etc/config" },
      { name: "tmp-0", mountPath: "/tmp" },
    ]);
  });
});

// ── WorkerPool ─────────────────────────────────────────────────────

describe("WorkerPool", () => {
  const minProps = { name: "worker", image: "worker:1.0" };

  test("returns deployment, serviceAccount, role, roleBinding", () => {
    const result = WorkerPool(minProps);
    expect(result.deployment).toBeDefined();
    expect(result.serviceAccount).toBeDefined();
    expect(result.role).toBeDefined();
    expect(result.roleBinding).toBeDefined();
  });

  test("no configMap or hpa by default", () => {
    const result = WorkerPool(minProps);
    expect(result.configMap).toBeUndefined();
    expect(result.hpa).toBeUndefined();
  });

  test("default replicas is 1", () => {
    const result = WorkerPool(minProps);
    const spec = p(result.deployment).spec as any;
    expect(spec.replicas).toBe(1);
  });

  test("RBAC naming convention", () => {
    const result = WorkerPool(minProps);
    const saMeta = p(result.serviceAccount).metadata as any;
    const roleMeta = p(result.role).metadata as any;
    const bindingMeta = p(result.roleBinding).metadata as any;
    expect(saMeta.name).toBe("worker-sa");
    expect(roleMeta.name).toBe("worker-role");
    expect(bindingMeta.name).toBe("worker-binding");
  });

  test("default RBAC rules for secrets and configmaps", () => {
    const result = WorkerPool(minProps);
    const role = p(result.role!) as any;
    expect(role.rules[0].resources).toEqual(["secrets", "configmaps"]);
    expect(role.rules[0].verbs).toEqual(["get"]);
  });

  test("custom RBAC rules are used", () => {
    const result = WorkerPool({
      ...minProps,
      rbacRules: [{ apiGroups: ["batch"], resources: ["jobs"], verbs: ["create"] }],
    });
    const role = p(result.role!) as any;
    expect(role.rules[0].resources).toEqual(["jobs"]);
  });

  test("command and args passed through", () => {
    const result = WorkerPool({
      ...minProps,
      command: ["bundle", "exec", "sidekiq"],
      args: ["-c", "5"],
    });
    const spec = p(result.deployment).spec as any;
    const container = spec.template.spec.containers[0];
    expect(container.command).toEqual(["bundle", "exec", "sidekiq"]);
    expect(container.args).toEqual(["-c", "5"]);
  });

  test("config creates ConfigMap with envFrom", () => {
    const result = WorkerPool({
      ...minProps,
      config: { REDIS_URL: "redis://redis:6379" },
    });
    expect(result.configMap).toBeDefined();
    const data = (p(result.configMap) as any).data;
    expect(data.REDIS_URL).toBe("redis://redis:6379");

    const spec = p(result.deployment).spec as any;
    const container = spec.template.spec.containers[0];
    expect(container.envFrom[0].configMapRef.name).toBe("worker-config");
  });

  test("autoscaling creates HPA and overrides replicas", () => {
    const result = WorkerPool({
      ...minProps,
      autoscaling: { minReplicas: 2, maxReplicas: 8, targetCPUPercent: 60 },
    });
    expect(result.hpa).toBeDefined();
    const hpaSpec = (p(result.hpa) as any).spec;
    expect(hpaSpec.minReplicas).toBe(2);
    expect(hpaSpec.maxReplicas).toBe(8);
    expect(hpaSpec.scaleTargetRef.name).toBe("worker");

    const spec = p(result.deployment).spec as any;
    expect(spec.replicas).toBe(2);
  });

  test("default resource limits", () => {
    const result = WorkerPool(minProps);
    const spec = p(result.deployment).spec as any;
    const container = spec.template.spec.containers[0];
    expect(container.resources.requests.cpu).toBe("100m");
    expect(container.resources.requests.memory).toBe("128Mi");
    expect(container.resources.limits.cpu).toBe("500m");
    expect(container.resources.limits.memory).toBe("256Mi");
  });

  test("serviceAccountName on pod spec", () => {
    const result = WorkerPool(minProps);
    const spec = p(result.deployment).spec as any;
    expect(spec.template.spec.serviceAccountName).toBe("worker-sa");
  });

  test("includes common labels on all resources", () => {
    const result = WorkerPool(minProps);
    for (const resource of [result.deployment, result.serviceAccount!, result.role!, result.roleBinding!]) {
      const meta = p(resource).metadata as any;
      expect(meta.labels["app.kubernetes.io/name"]).toBe("worker");
      expect(meta.labels["app.kubernetes.io/managed-by"]).toBe("chant");
    }
  });

  test("namespace propagated", () => {
    const result = WorkerPool({ ...minProps, namespace: "jobs" });
    for (const resource of [result.deployment, result.serviceAccount!, result.role!, result.roleBinding!]) {
      const meta = p(resource).metadata as any;
      expect(meta.namespace).toBe("jobs");
    }
  });

  test("rbacRules: [] produces no RBAC resources", () => {
    const result = WorkerPool({ ...minProps, rbacRules: [] });
    expect(result.serviceAccount).toBeUndefined();
    expect(result.role).toBeUndefined();
    expect(result.roleBinding).toBeUndefined();
    const spec = p(result.deployment).spec as any;
    expect(spec.template.spec.serviceAccountName).toBeUndefined();
  });

  test("rbacRules undefined produces default RBAC", () => {
    const result = WorkerPool(minProps);
    expect(result.serviceAccount).toBeDefined();
    expect(result.role).toBeDefined();
    expect(result.roleBinding).toBeDefined();
    const role = p(result.role) as any;
    expect(role.rules[0].resources).toEqual(["secrets", "configmaps"]);
  });

  test("env vars on container", () => {
    const result = WorkerPool({
      ...minProps,
      env: [{ name: "LOG_LEVEL", value: "debug" }],
    });
    const spec = p(result.deployment).spec as any;
    const container = spec.template.spec.containers[0];
    expect(container.env).toEqual([{ name: "LOG_LEVEL", value: "debug" }]);
  });

  test("ConfigMap carries namespace and labels", () => {
    const result = WorkerPool({
      ...minProps,
      config: { KEY: "val" },
      namespace: "jobs",
    });
    const meta = (p(result.configMap) as any).metadata;
    expect(meta.namespace).toBe("jobs");
    expect(meta.labels["app.kubernetes.io/name"]).toBe("worker");
  });

  test("HPA carries namespace", () => {
    const result = WorkerPool({
      ...minProps,
      autoscaling: { minReplicas: 1, maxReplicas: 5 },
      namespace: "jobs",
    });
    const meta = (p(result.hpa) as any).metadata;
    expect(meta.namespace).toBe("jobs");
  });

  test("autoscaling default targetCPUPercent is 70", () => {
    const result = WorkerPool({
      ...minProps,
      autoscaling: { minReplicas: 1, maxReplicas: 5 },
    });
    const hpaSpec = (p(result.hpa) as any).spec;
    expect(hpaSpec.metrics[0].resource.target.averageUtilization).toBe(70);
  });

  test("component labels on each resource", () => {
    const result = WorkerPool({
      ...minProps,
      config: { K: "V" },
      autoscaling: { minReplicas: 1, maxReplicas: 5 },
    });
    expect((p(result.deployment).metadata as any).labels["app.kubernetes.io/component"]).toBe("worker");
    expect((p(result.serviceAccount).metadata as any).labels["app.kubernetes.io/component"]).toBe("worker");
    expect((p(result.role).metadata as any).labels["app.kubernetes.io/component"]).toBe("rbac");
    expect((p(result.roleBinding).metadata as any).labels["app.kubernetes.io/component"]).toBe("rbac");
    expect((p(result.configMap).metadata as any).labels["app.kubernetes.io/component"]).toBe("config");
    expect((p(result.hpa).metadata as any).labels["app.kubernetes.io/component"]).toBe("autoscaler");
  });
});

// ── NamespaceEnv ───────────────────────────────────────────────────

describe("NamespaceEnv", () => {
  test("returns namespace only with minimal props", () => {
    const result = NamespaceEnv({
      name: "team-alpha",
      defaultDenyIngress: false,
    });
    expect(result.namespace).toBeDefined();
    expect(result.resourceQuota).toBeUndefined();
    expect(result.limitRange).toBeUndefined();
    expect(result.networkPolicy).toBeUndefined();
  });

  test("default-deny ingress NetworkPolicy created by default", () => {
    const result = NamespaceEnv({ name: "team-alpha" });
    expect(result.networkPolicy).toBeDefined();
    const spec = p(result.networkPolicy).spec as any;
    expect(spec.policyTypes).toEqual(["Ingress"]);
    expect(spec.podSelector).toEqual({});
  });

  test("egress deny when enabled", () => {
    const result = NamespaceEnv({
      name: "team-alpha",
      defaultDenyEgress: true,
    });
    const spec = p(result.networkPolicy).spec as any;
    expect(spec.policyTypes).toContain("Ingress");
    expect(spec.policyTypes).toContain("Egress");
  });

  test("ResourceQuota created when quota props set", () => {
    const result = NamespaceEnv({
      name: "team-alpha",
      cpuQuota: "8",
      memoryQuota: "16Gi",
      maxPods: 50,
    });
    expect(result.resourceQuota).toBeDefined();
    const spec = p(result.resourceQuota).spec as any;
    expect(spec.hard["limits.cpu"]).toBe("8");
    expect(spec.hard["limits.memory"]).toBe("16Gi");
    expect(spec.hard.pods).toBe("50");
  });

  test("ResourceQuota in correct namespace", () => {
    const result = NamespaceEnv({ name: "team-alpha", cpuQuota: "4" });
    const meta = p(result.resourceQuota).metadata as any;
    expect(meta.namespace).toBe("team-alpha");
    expect(meta.name).toBe("team-alpha-quota");
  });

  test("LimitRange created when limit defaults set", () => {
    const result = NamespaceEnv({
      name: "team-alpha",
      defaultCpuRequest: "100m",
      defaultMemoryRequest: "128Mi",
      defaultCpuLimit: "500m",
      defaultMemoryLimit: "512Mi",
    });
    expect(result.limitRange).toBeDefined();
    const spec = p(result.limitRange).spec as any;
    const limit = spec.limits[0];
    expect(limit.type).toBe("Container");
    expect(limit.default.cpu).toBe("500m");
    expect(limit.default.memory).toBe("512Mi");
    expect(limit.defaultRequest.cpu).toBe("100m");
    expect(limit.defaultRequest.memory).toBe("128Mi");
  });

  test("LimitRange in correct namespace", () => {
    const result = NamespaceEnv({ name: "team-alpha", defaultCpuLimit: "1" });
    const meta = p(result.limitRange).metadata as any;
    expect(meta.namespace).toBe("team-alpha");
    expect(meta.name).toBe("team-alpha-limits");
  });

  test("includes common labels", () => {
    const result = NamespaceEnv({ name: "team-alpha" });
    const meta = p(result.namespace).metadata as any;
    expect(meta.labels["app.kubernetes.io/name"]).toBe("team-alpha");
    expect(meta.labels["app.kubernetes.io/managed-by"]).toBe("chant");
  });

  test("namespace resource has no namespace field (cluster-scoped)", () => {
    const result = NamespaceEnv({ name: "team-alpha" });
    const meta = p(result.namespace).metadata as any;
    expect(meta.namespace).toBeUndefined();
  });

  test("warns when quota set without limits", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    NamespaceEnv({ name: "warn-test", cpuQuota: "4", defaultDenyIngress: false });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("ResourceQuota set but no LimitRange defaults"),
    );
    warnSpy.mockRestore();
  });

  test("no warning when both quota and limits set", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    NamespaceEnv({
      name: "both-test",
      cpuQuota: "4",
      defaultCpuRequest: "100m",
      defaultDenyIngress: false,
    });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test("no warning when limits only (no quota)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    NamespaceEnv({
      name: "limits-only",
      defaultCpuRequest: "100m",
      defaultDenyIngress: false,
    });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test("egress-only deny (no ingress)", () => {
    const result = NamespaceEnv({
      name: "egress-only",
      defaultDenyIngress: false,
      defaultDenyEgress: true,
    });
    expect(result.networkPolicy).toBeDefined();
    const spec = p(result.networkPolicy).spec as any;
    expect(spec.policyTypes).toEqual(["Egress"]);
  });

  test("NetworkPolicy namespace is the namespace name", () => {
    const result = NamespaceEnv({ name: "team-beta", defaultDenyIngress: true });
    const meta = p(result.networkPolicy).metadata as any;
    expect(meta.namespace).toBe("team-beta");
  });

  test("extra labels on all resources", () => {
    const result = NamespaceEnv({
      name: "team-gamma",
      cpuQuota: "4",
      defaultCpuRequest: "100m",
      defaultDenyIngress: true,
      labels: { env: "staging" },
    });
    for (const resource of [result.namespace, result.resourceQuota!, result.limitRange!, result.networkPolicy!]) {
      const meta = p(resource).metadata as any;
      expect(meta.labels.env).toBe("staging");
    }
  });

  test("component labels on each resource", () => {
    const result = NamespaceEnv({
      name: "team-delta",
      cpuQuota: "4",
      defaultCpuRequest: "100m",
      defaultDenyIngress: true,
    });
    expect((p(result.namespace).metadata as any).labels["app.kubernetes.io/component"]).toBe("namespace");
    expect((p(result.resourceQuota).metadata as any).labels["app.kubernetes.io/component"]).toBe("quota");
    expect((p(result.limitRange).metadata as any).labels["app.kubernetes.io/component"]).toBe("limits");
    expect((p(result.networkPolicy).metadata as any).labels["app.kubernetes.io/component"]).toBe("network-policy");
  });
});

// ── NodeAgent ──────────────────────────────────────────────────────

describe("NodeAgent", () => {
  const minProps = {
    name: "log-agent",
    image: "fluentd:v1.16",
    rbacRules: [
      { apiGroups: [""], resources: ["pods", "namespaces"], verbs: ["get", "list", "watch"] },
    ],
  };

  test("returns daemonSet, serviceAccount, clusterRole, clusterRoleBinding", () => {
    const result = NodeAgent(minProps);
    expect(result.daemonSet).toBeDefined();
    expect(result.serviceAccount).toBeDefined();
    expect(result.clusterRole).toBeDefined();
    expect(result.clusterRoleBinding).toBeDefined();
  });

  test("no configMap by default", () => {
    const result = NodeAgent(minProps);
    expect(result.configMap).toBeUndefined();
  });

  test("uses ClusterRole/ClusterRoleBinding (not Role)", () => {
    const result = NodeAgent(minProps);
    const binding = p(result.clusterRoleBinding) as any;
    expect(binding.roleRef.kind).toBe("ClusterRole");
    expect(binding.roleRef.apiGroup).toBe("rbac.authorization.k8s.io");
  });

  test("ClusterRole/ClusterRoleBinding are cluster-scoped (no namespace)", () => {
    const result = NodeAgent({ ...minProps, namespace: "monitoring" });
    const crMeta = p(result.clusterRole).metadata as any;
    const crbMeta = p(result.clusterRoleBinding).metadata as any;
    expect(crMeta.namespace).toBeUndefined();
    expect(crbMeta.namespace).toBeUndefined();
  });

  test("namespaced resources get namespace", () => {
    const result = NodeAgent({ ...minProps, namespace: "monitoring" });
    const dsMeta = p(result.daemonSet).metadata as any;
    const saMeta = p(result.serviceAccount).metadata as any;
    expect(dsMeta.namespace).toBe("monitoring");
    expect(saMeta.namespace).toBe("monitoring");
  });

  test("tolerateAllTaints adds Exists toleration by default", () => {
    const result = NodeAgent(minProps);
    const spec = p(result.daemonSet).spec as any;
    const tolerations = spec.template.spec.tolerations;
    expect(tolerations).toEqual([{ operator: "Exists" }]);
  });

  test("tolerateAllTaints can be disabled", () => {
    const result = NodeAgent({ ...minProps, tolerateAllTaints: false });
    const spec = p(result.daemonSet).spec as any;
    expect(spec.template.spec.tolerations).toBeUndefined();
  });

  test("hostPaths mounted with readOnly true by default", () => {
    const result = NodeAgent({
      ...minProps,
      hostPaths: [{ name: "varlog", hostPath: "/var/log", mountPath: "/var/log" }],
    });
    const spec = p(result.daemonSet).spec as any;
    const volumes = spec.template.spec.volumes;
    expect(volumes[0].name).toBe("varlog");
    expect(volumes[0].hostPath.path).toBe("/var/log");

    const mounts = spec.template.spec.containers[0].volumeMounts;
    expect(mounts[0].mountPath).toBe("/var/log");
    expect(mounts[0].readOnly).toBe(true);
  });

  test("hostPaths readOnly can be set to false", () => {
    const result = NodeAgent({
      ...minProps,
      hostPaths: [{ name: "data", hostPath: "/data", mountPath: "/data", readOnly: false }],
    });
    const spec = p(result.daemonSet).spec as any;
    const mounts = spec.template.spec.containers[0].volumeMounts;
    expect(mounts[0].readOnly).toBe(false);
  });

  test("config creates ConfigMap mounted at /etc/{name}/", () => {
    const result = NodeAgent({
      ...minProps,
      config: { "fluent.conf": "some config" },
    });
    expect(result.configMap).toBeDefined();
    const data = (p(result.configMap) as any).data;
    expect(data["fluent.conf"]).toBe("some config");

    const spec = p(result.daemonSet).spec as any;
    const volumes = spec.template.spec.volumes;
    const configVol = volumes.find((v: any) => v.name === "config");
    expect(configVol.configMap.name).toBe("log-agent-config");

    const mounts = spec.template.spec.containers[0].volumeMounts;
    const configMount = mounts.find((m: any) => m.name === "config");
    expect(configMount.mountPath).toBe("/etc/log-agent");
    expect(configMount.readOnly).toBe(true);
  });

  test("port creates metrics port on container", () => {
    const result = NodeAgent({ ...minProps, port: 9100 });
    const spec = p(result.daemonSet).spec as any;
    const container = spec.template.spec.containers[0];
    expect(container.ports[0].containerPort).toBe(9100);
    expect(container.ports[0].name).toBe("metrics");
  });

  test("RBAC naming convention", () => {
    const result = NodeAgent(minProps);
    const saMeta = p(result.serviceAccount).metadata as any;
    const crMeta = p(result.clusterRole).metadata as any;
    const crbMeta = p(result.clusterRoleBinding).metadata as any;
    expect(saMeta.name).toBe("log-agent-sa");
    expect(crMeta.name).toBe("log-agent-role");
    expect(crbMeta.name).toBe("log-agent-binding");
  });

  test("RBAC rules passed through to ClusterRole", () => {
    const result = NodeAgent(minProps);
    const cr = p(result.clusterRole) as any;
    expect(cr.rules[0].resources).toEqual(["pods", "namespaces"]);
  });

  test("includes common labels on all resources", () => {
    const result = NodeAgent(minProps);
    for (const resource of [result.daemonSet, result.serviceAccount, result.clusterRole, result.clusterRoleBinding]) {
      const meta = p(resource).metadata as any;
      expect(meta.labels["app.kubernetes.io/name"]).toBe("log-agent");
      expect(meta.labels["app.kubernetes.io/managed-by"]).toBe("chant");
    }
  });

  test("env vars passed to container", () => {
    const result = NodeAgent({
      ...minProps,
      env: [{ name: "LOG_LEVEL", value: "info" }],
    });
    const spec = p(result.daemonSet).spec as any;
    const container = spec.template.spec.containers[0];
    expect(container.env).toEqual([{ name: "LOG_LEVEL", value: "info" }]);
  });

  test("serviceAccountName on pod spec", () => {
    const result = NodeAgent(minProps);
    const spec = p(result.daemonSet).spec as any;
    expect(spec.template.spec.serviceAccountName).toBe("log-agent-sa");
  });

  test("default resource requests and limits on container", () => {
    const result = NodeAgent(minProps);
    const spec = p(result.daemonSet).spec as any;
    const container = spec.template.spec.containers[0];
    expect(container.resources.requests.cpu).toBe("50m");
    expect(container.resources.requests.memory).toBe("64Mi");
    expect(container.resources.limits.cpu).toBe("200m");
    expect(container.resources.limits.memory).toBe("128Mi");
  });

  test("custom resource limits", () => {
    const result = NodeAgent({
      ...minProps,
      cpuRequest: "100m",
      memoryRequest: "256Mi",
      cpuLimit: "500m",
      memoryLimit: "512Mi",
    });
    const spec = p(result.daemonSet).spec as any;
    const container = spec.template.spec.containers[0];
    expect(container.resources.requests.cpu).toBe("100m");
    expect(container.resources.requests.memory).toBe("256Mi");
    expect(container.resources.limits.cpu).toBe("500m");
    expect(container.resources.limits.memory).toBe("512Mi");
  });

  test("multiple hostPaths", () => {
    const result = NodeAgent({
      ...minProps,
      hostPaths: [
        { name: "varlog", hostPath: "/var/log", mountPath: "/var/log" },
        { name: "run", hostPath: "/run", mountPath: "/run", readOnly: false },
      ],
    });
    const spec = p(result.daemonSet).spec as any;
    expect(spec.template.spec.volumes).toHaveLength(2);
    expect(spec.template.spec.containers[0].volumeMounts).toHaveLength(2);
    expect(spec.template.spec.containers[0].volumeMounts[1].readOnly).toBe(false);
  });

  test("configMap carries namespace", () => {
    const result = NodeAgent({
      ...minProps,
      config: { key: "val" },
      namespace: "monitoring",
    });
    const meta = (p(result.configMap) as any).metadata;
    expect(meta.namespace).toBe("monitoring");
  });

  test("component labels on each resource", () => {
    const result = NodeAgent({
      ...minProps,
      config: { key: "val" },
    });
    expect((p(result.daemonSet).metadata as any).labels["app.kubernetes.io/component"]).toBe("agent");
    expect((p(result.serviceAccount).metadata as any).labels["app.kubernetes.io/component"]).toBe("agent");
    expect((p(result.clusterRole).metadata as any).labels["app.kubernetes.io/component"]).toBe("rbac");
    expect((p(result.clusterRoleBinding).metadata as any).labels["app.kubernetes.io/component"]).toBe("rbac");
    expect((p(result.configMap).metadata as any).labels["app.kubernetes.io/component"]).toBe("config");
  });
});

// ── Hardening Additions ─────────────────────────────────────────────

describe("WebApp hardening", () => {
  test("PDB created when minAvailable set", () => {
    const result = WebApp({ name: "app", image: "app:1.0", minAvailable: 1 });
    expect(result.pdb).toBeDefined();
    const spec = p(result.pdb).spec as any;
    expect(spec.minAvailable).toBe(1);
    expect(spec.selector.matchLabels["app.kubernetes.io/name"]).toBe("app");
  });

  test("no PDB by default", () => {
    const result = WebApp({ name: "app", image: "app:1.0" });
    expect(result.pdb).toBeUndefined();
  });

  test("initContainers passed through", () => {
    const result = WebApp({
      name: "app",
      image: "app:1.0",
      initContainers: [{ name: "migrate", image: "migrate:1.0", command: ["./migrate.sh"] }],
    });
    const spec = p(result.deployment).spec as any;
    expect(spec.template.spec.initContainers).toHaveLength(1);
    expect(spec.template.spec.initContainers[0].name).toBe("migrate");
  });

  test("securityContext passed through", () => {
    const result = WebApp({
      name: "app",
      image: "app:1.0",
      securityContext: { runAsNonRoot: true, readOnlyRootFilesystem: true },
    });
    const spec = p(result.deployment).spec as any;
    const container = spec.template.spec.containers[0];
    expect(container.securityContext.runAsNonRoot).toBe(true);
  });

  test("securityContext supports PSS restricted fields", () => {
    const result = WebApp({
      name: "app",
      image: "app:1.0",
      securityContext: {
        runAsNonRoot: true,
        readOnlyRootFilesystem: true,
        allowPrivilegeEscalation: false,
        capabilities: { drop: ["ALL"] },
        seccompProfile: { type: "RuntimeDefault" },
      },
    });
    const spec = p(result.deployment).spec as any;
    const sc = spec.template.spec.containers[0].securityContext;
    expect(sc.allowPrivilegeEscalation).toBe(false);
    expect(sc.capabilities).toEqual({ drop: ["ALL"] });
    expect(sc.seccompProfile).toEqual({ type: "RuntimeDefault" });
  });

  test("terminationGracePeriodSeconds set", () => {
    const result = WebApp({ name: "app", image: "app:1.0", terminationGracePeriodSeconds: 60 });
    const spec = p(result.deployment).spec as any;
    expect(spec.template.spec.terminationGracePeriodSeconds).toBe(60);
  });

  test("priorityClassName set", () => {
    const result = WebApp({ name: "app", image: "app:1.0", priorityClassName: "high-priority" });
    const spec = p(result.deployment).spec as any;
    expect(spec.template.spec.priorityClassName).toBe("high-priority");
  });

  test("multi-path ingress", () => {
    const result = WebApp({
      name: "app",
      image: "app:1.0",
      ingressHost: "app.example.com",
      ingressPaths: [
        { path: "/api", serviceName: "api", servicePort: 8080 },
        { path: "/web", serviceName: "web", servicePort: 3000 },
      ],
    });
    const spec = p(result.ingress).spec as any;
    expect(spec.rules[0].http.paths).toHaveLength(2);
    expect(spec.rules[0].http.paths[0].path).toBe("/api");
    expect(spec.rules[0].http.paths[1].backend.service.name).toBe("web");
  });
});

describe("StatefulApp hardening", () => {
  test("PDB created when minAvailable set", () => {
    const result = StatefulApp({ name: "db", image: "postgres:16", minAvailable: 1 });
    expect(result.pdb).toBeDefined();
    const spec = p(result.pdb).spec as any;
    expect(spec.minAvailable).toBe(1);
  });

  test("initContainers passed through", () => {
    const result = StatefulApp({
      name: "db",
      image: "postgres:16",
      initContainers: [{ name: "init", image: "init:1.0" }],
    });
    const spec = p(result.statefulSet).spec as any;
    expect(spec.template.spec.initContainers).toHaveLength(1);
  });

  test("securityContext passed through", () => {
    const result = StatefulApp({
      name: "db",
      image: "postgres:16",
      securityContext: { runAsNonRoot: true },
    });
    const spec = p(result.statefulSet).spec as any;
    expect(spec.template.spec.containers[0].securityContext.runAsNonRoot).toBe(true);
  });

  test("securityContext supports PSS restricted fields", () => {
    const result = StatefulApp({
      name: "db",
      image: "postgres:16",
      securityContext: {
        runAsNonRoot: true,
        allowPrivilegeEscalation: false,
        capabilities: { drop: ["ALL"] },
        seccompProfile: { type: "RuntimeDefault" },
      },
    });
    const spec = p(result.statefulSet).spec as any;
    const sc = spec.template.spec.containers[0].securityContext;
    expect(sc.allowPrivilegeEscalation).toBe(false);
    expect(sc.capabilities).toEqual({ drop: ["ALL"] });
    expect(sc.seccompProfile).toEqual({ type: "RuntimeDefault" });
  });
});

describe("WorkerPool hardening", () => {
  test("PDB created when minAvailable set", () => {
    const result = WorkerPool({ name: "w", image: "w:1.0", minAvailable: 1 });
    expect(result.pdb).toBeDefined();
    const spec = p(result.pdb).spec as any;
    expect(spec.minAvailable).toBe(1);
  });

  test("securityContext on container", () => {
    const result = WorkerPool({
      name: "w",
      image: "w:1.0",
      securityContext: { runAsNonRoot: true },
    });
    const spec = p(result.deployment).spec as any;
    expect(spec.template.spec.containers[0].securityContext.runAsNonRoot).toBe(true);
  });

  test("securityContext supports PSS restricted fields", () => {
    const result = WorkerPool({
      name: "w",
      image: "w:1.0",
      securityContext: {
        runAsNonRoot: true,
        allowPrivilegeEscalation: false,
        capabilities: { drop: ["ALL"] },
        seccompProfile: { type: "RuntimeDefault" },
      },
    });
    const spec = p(result.deployment).spec as any;
    const sc = spec.template.spec.containers[0].securityContext;
    expect(sc.allowPrivilegeEscalation).toBe(false);
    expect(sc.capabilities).toEqual({ drop: ["ALL"] });
    expect(sc.seccompProfile).toEqual({ type: "RuntimeDefault" });
  });
});

describe("AutoscaledService hardening", () => {
  const minProps = { name: "api", image: "api:1.0", maxReplicas: 10, cpuRequest: "100m", memoryRequest: "128Mi" };

  test("initContainers passed through", () => {
    const result = AutoscaledService({
      ...minProps,
      initContainers: [{ name: "migrate", image: "m:1.0" }],
    });
    const spec = p(result.deployment).spec as any;
    expect(spec.template.spec.initContainers).toHaveLength(1);
  });

  test("securityContext on container", () => {
    const result = AutoscaledService({
      ...minProps,
      securityContext: { runAsNonRoot: true },
    });
    const spec = p(result.deployment).spec as any;
    expect(spec.template.spec.containers[0].securityContext.runAsNonRoot).toBe(true);
  });

  test("securityContext supports PSS restricted fields", () => {
    const result = AutoscaledService({
      ...minProps,
      securityContext: {
        runAsNonRoot: true,
        allowPrivilegeEscalation: false,
        capabilities: { drop: ["ALL"] },
        seccompProfile: { type: "RuntimeDefault" },
      },
    });
    const spec = p(result.deployment).spec as any;
    const sc = spec.template.spec.containers[0].securityContext;
    expect(sc.allowPrivilegeEscalation).toBe(false);
    expect(sc.capabilities).toEqual({ drop: ["ALL"] });
    expect(sc.seccompProfile).toEqual({ type: "RuntimeDefault" });
  });

  test("terminationGracePeriodSeconds set", () => {
    const result = AutoscaledService({ ...minProps, terminationGracePeriodSeconds: 30 });
    const spec = p(result.deployment).spec as any;
    expect(spec.template.spec.terminationGracePeriodSeconds).toBe(30);
  });
});

// ── BatchJob ────────────────────────────────────────────────────────

describe("BatchJob", () => {
  const minProps = { name: "migrate", image: "migrate:1.0" };

  test("returns job with default RBAC", () => {
    const result = BatchJob(minProps);
    expect(result.job).toBeDefined();
    expect(result.serviceAccount).toBeDefined();
    expect(result.role).toBeDefined();
    expect(result.roleBinding).toBeDefined();
  });

  test("default backoffLimit is 6", () => {
    const result = BatchJob(minProps);
    const spec = p(result.job).spec as any;
    expect(spec.backoffLimit).toBe(6);
  });

  test("custom backoffLimit and ttl", () => {
    const result = BatchJob({ ...minProps, backoffLimit: 3, ttlSecondsAfterFinished: 3600 });
    const spec = p(result.job).spec as any;
    expect(spec.backoffLimit).toBe(3);
    expect(spec.ttlSecondsAfterFinished).toBe(3600);
  });

  test("parallelism and completions", () => {
    const result = BatchJob({ ...minProps, parallelism: 3, completions: 10 });
    const spec = p(result.job).spec as any;
    expect(spec.parallelism).toBe(3);
    expect(spec.completions).toBe(10);
  });

  test("rbacRules: [] skips RBAC", () => {
    const result = BatchJob({ ...minProps, rbacRules: [] });
    expect(result.serviceAccount).toBeUndefined();
    expect(result.role).toBeUndefined();
    expect(result.roleBinding).toBeUndefined();
  });

  test("command and args passed through", () => {
    const result = BatchJob({ ...minProps, command: ["python"], args: ["migrate.py"] });
    const spec = p(result.job).spec as any;
    const container = spec.template.spec.containers[0];
    expect(container.command).toEqual(["python"]);
    expect(container.args).toEqual(["migrate.py"]);
  });

  test("namespace propagated", () => {
    const result = BatchJob({ ...minProps, namespace: "jobs" });
    expect((p(result.job).metadata as any).namespace).toBe("jobs");
    expect((p(result.serviceAccount).metadata as any).namespace).toBe("jobs");
  });

  test("component labels", () => {
    const result = BatchJob(minProps);
    expect((p(result.job).metadata as any).labels["app.kubernetes.io/component"]).toBe("batch");
    expect((p(result.role).metadata as any).labels["app.kubernetes.io/component"]).toBe("rbac");
  });
});

// ── SecureIngress ───────────────────────────────────────────────────

describe("SecureIngress", () => {
  const minProps = {
    name: "app-ingress",
    hosts: [{ hostname: "app.example.com", paths: [{ path: "/", serviceName: "app", servicePort: 80 }] }],
  };

  test("returns ingress without certificate by default", () => {
    const result = SecureIngress(minProps);
    expect(result.ingress).toBeDefined();
    expect(result.certificate).toBeUndefined();
  });

  test("creates certificate when clusterIssuer set", () => {
    const result = SecureIngress({ ...minProps, clusterIssuer: "letsencrypt-prod" });
    expect(result.certificate).toBeDefined();
    const certSpec = p(result.certificate!).spec as any;
    expect(certSpec.issuerRef.name).toBe("letsencrypt-prod");
    expect(certSpec.dnsNames).toEqual(["app.example.com"]);
  });

  test("TLS on ingress when clusterIssuer set", () => {
    const result = SecureIngress({ ...minProps, clusterIssuer: "letsencrypt-prod" });
    const spec = p(result.ingress).spec as any;
    expect(spec.tls).toBeDefined();
    expect(spec.tls[0].hosts).toEqual(["app.example.com"]);
  });

  test("multi-host support", () => {
    const result = SecureIngress({
      name: "multi",
      hosts: [
        { hostname: "api.example.com", paths: [{ path: "/", serviceName: "api", servicePort: 80 }] },
        { hostname: "admin.example.com", paths: [{ path: "/", serviceName: "admin", servicePort: 80 }] },
      ],
      clusterIssuer: "letsencrypt-prod",
    });
    const spec = p(result.ingress).spec as any;
    expect(spec.rules).toHaveLength(2);
    const certSpec = p(result.certificate!).spec as any;
    expect(certSpec.dnsNames).toHaveLength(2);
  });

  test("multi-path support", () => {
    const result = SecureIngress({
      name: "multi-path",
      hosts: [{
        hostname: "app.example.com",
        paths: [
          { path: "/api", serviceName: "api", servicePort: 8080 },
          { path: "/web", serviceName: "web", servicePort: 3000 },
        ],
      }],
    });
    const spec = p(result.ingress).spec as any;
    expect(spec.rules[0].http.paths).toHaveLength(2);
  });

  test("ingressClassName set", () => {
    const result = SecureIngress({ ...minProps, ingressClassName: "nginx" });
    const spec = p(result.ingress).spec as any;
    expect(spec.ingressClassName).toBe("nginx");
  });

  test("cert-manager annotation added", () => {
    const result = SecureIngress({ ...minProps, clusterIssuer: "letsencrypt-prod" });
    const meta = p(result.ingress).metadata as any;
    expect(meta.annotations["cert-manager.io/cluster-issuer"]).toBe("letsencrypt-prod");
  });
});

// ── ConfiguredApp ───────────────────────────────────────────────────

describe("ConfiguredApp", () => {
  const minProps = { name: "api", image: "api:1.0" };

  test("returns deployment and service", () => {
    const result = ConfiguredApp(minProps);
    expect(result.deployment).toBeDefined();
    expect(result.service).toBeDefined();
    expect(result.configMap).toBeUndefined();
  });

  test("creates ConfigMap when configData provided", () => {
    const result = ConfiguredApp({ ...minProps, configData: { "app.conf": "key=val" }, configMountPath: "/etc/app" });
    expect(result.configMap).toBeDefined();
    expect((p(result.configMap) as any).data["app.conf"]).toBe("key=val");
  });

  test("configMap volume mounted", () => {
    const result = ConfiguredApp({ ...minProps, configData: { "k": "v" }, configMountPath: "/etc/app" });
    const spec = p(result.deployment).spec as any;
    const container = spec.template.spec.containers[0];
    expect(container.volumeMounts).toHaveLength(1);
    expect(container.volumeMounts[0].mountPath).toBe("/etc/app");
    expect(spec.template.spec.volumes[0].configMap.name).toBe("api-config");
  });

  test("secret volume mounted", () => {
    const result = ConfiguredApp({ ...minProps, secretName: "creds", secretMountPath: "/secrets" });
    const spec = p(result.deployment).spec as any;
    const container = spec.template.spec.containers[0];
    expect(container.volumeMounts[0].mountPath).toBe("/secrets");
    expect(spec.template.spec.volumes[0].secret.secretName).toBe("creds");
  });

  test("envFrom with configMapRef and secretRef", () => {
    const result = ConfiguredApp({
      ...minProps,
      envFrom: { configMapRef: "my-config", secretRef: "my-secret" },
    });
    const spec = p(result.deployment).spec as any;
    const container = spec.template.spec.containers[0];
    expect(container.envFrom).toHaveLength(2);
    expect(container.envFrom[0].configMapRef.name).toBe("my-config");
    expect(container.envFrom[1].secretRef.name).toBe("my-secret");
  });

  test("initContainers supported", () => {
    const result = ConfiguredApp({
      ...minProps,
      initContainers: [{ name: "init", image: "init:1.0", command: ["sh"] }],
    });
    const spec = p(result.deployment).spec as any;
    expect(spec.template.spec.initContainers).toHaveLength(1);
  });

  test("namespace propagated", () => {
    const result = ConfiguredApp({ ...minProps, namespace: "prod" });
    expect((p(result.deployment).metadata as any).namespace).toBe("prod");
    expect((p(result.service).metadata as any).namespace).toBe("prod");
  });
});

// ── SidecarApp ──────────────────────────────────────────────────────

describe("SidecarApp", () => {
  const minProps = {
    name: "api",
    image: "api:1.0",
    sidecars: [{ name: "envoy", image: "envoy:v1.28" }],
  };

  test("returns deployment and service", () => {
    const result = SidecarApp(minProps);
    expect(result.deployment).toBeDefined();
    expect(result.service).toBeDefined();
  });

  test("has multiple containers", () => {
    const result = SidecarApp(minProps);
    const spec = p(result.deployment).spec as any;
    expect(spec.template.spec.containers).toHaveLength(2);
    expect(spec.template.spec.containers[0].name).toBe("api");
    expect(spec.template.spec.containers[1].name).toBe("envoy");
  });

  test("sidecar ports passed through", () => {
    const result = SidecarApp({
      ...minProps,
      sidecars: [{ name: "envoy", image: "envoy:v1.28", ports: [{ containerPort: 9901, name: "admin" }] }],
    });
    const spec = p(result.deployment).spec as any;
    expect(spec.template.spec.containers[1].ports[0].containerPort).toBe(9901);
  });

  test("initContainers supported", () => {
    const result = SidecarApp({
      ...minProps,
      initContainers: [{ name: "migrate", image: "m:1.0", command: ["./migrate.sh"] }],
    });
    const spec = p(result.deployment).spec as any;
    expect(spec.template.spec.initContainers).toHaveLength(1);
  });

  test("sharedVolumes creates volumes", () => {
    const result = SidecarApp({
      ...minProps,
      sharedVolumes: [{ name: "tmp" }, { name: "config", configMapName: "my-config" }],
    });
    const spec = p(result.deployment).spec as any;
    expect(spec.template.spec.volumes).toHaveLength(2);
    expect(spec.template.spec.volumes[0].emptyDir).toBeDefined();
    expect(spec.template.spec.volumes[1].configMap.name).toBe("my-config");
  });

  test("common labels on all resources", () => {
    const result = SidecarApp(minProps);
    expect((p(result.deployment).metadata as any).labels["app.kubernetes.io/managed-by"]).toBe("chant");
    expect((p(result.service).metadata as any).labels["app.kubernetes.io/managed-by"]).toBe("chant");
  });
});

// ── MonitoredService ────────────────────────────────────────────────

describe("MonitoredService", () => {
  const minProps = { name: "api", image: "api:1.0" };

  test("returns deployment, service, serviceMonitor", () => {
    const result = MonitoredService(minProps);
    expect(result.deployment).toBeDefined();
    expect(result.service).toBeDefined();
    expect(result.serviceMonitor).toBeDefined();
    expect(result.prometheusRule).toBeUndefined();
  });

  test("prometheusRule created when alertRules provided", () => {
    const result = MonitoredService({
      ...minProps,
      alertRules: [{ name: "HighError", expr: "rate(errors[5m]) > 0.1", severity: "critical" }],
    });
    expect(result.prometheusRule).toBeDefined();
    const spec = p(result.prometheusRule!).spec as any;
    expect(spec.groups[0].rules[0].alert).toBe("HighError");
    expect(spec.groups[0].rules[0].labels.severity).toBe("critical");
  });

  test("serviceMonitor has correct selector and endpoint", () => {
    const result = MonitoredService({ ...minProps, metricsPort: 9090, metricsPath: "/metrics", scrapeInterval: "15s" });
    const spec = p(result.serviceMonitor).spec as any;
    expect(spec.selector.matchLabels["app.kubernetes.io/name"]).toBe("api");
    expect(spec.endpoints[0].port).toBe("metrics");
    expect(spec.endpoints[0].path).toBe("/metrics");
    expect(spec.endpoints[0].interval).toBe("15s");
  });

  test("separate metrics port on container and service", () => {
    const result = MonitoredService({ ...minProps, port: 8080, metricsPort: 9090 });
    const spec = p(result.deployment).spec as any;
    const ports = spec.template.spec.containers[0].ports;
    expect(ports).toHaveLength(2);
    expect(ports[0].containerPort).toBe(8080);
    expect(ports[1].containerPort).toBe(9090);
  });

  test("component labels", () => {
    const result = MonitoredService({ ...minProps, alertRules: [{ name: "A", expr: "1" }] });
    expect((p(result.serviceMonitor).metadata as any).labels["app.kubernetes.io/component"]).toBe("monitoring");
    expect((p(result.prometheusRule!).metadata as any).labels["app.kubernetes.io/component"]).toBe("monitoring");
  });
});

// ── NetworkIsolatedApp ──────────────────────────────────────────────

describe("NetworkIsolatedApp", () => {
  const minProps = { name: "api", image: "api:1.0" };

  test("returns deployment, service, networkPolicy", () => {
    const result = NetworkIsolatedApp(minProps);
    expect(result.deployment).toBeDefined();
    expect(result.service).toBeDefined();
    expect(result.networkPolicy).toBeDefined();
  });

  test("networkPolicy podSelector matches app", () => {
    const result = NetworkIsolatedApp(minProps);
    const spec = p(result.networkPolicy).spec as any;
    expect(spec.podSelector.matchLabels["app.kubernetes.io/name"]).toBe("api");
  });

  test("ingress rules created", () => {
    const result = NetworkIsolatedApp({
      ...minProps,
      allowIngressFrom: [{ podSelector: { "app.kubernetes.io/name": "frontend" } }],
    });
    const spec = p(result.networkPolicy).spec as any;
    expect(spec.policyTypes).toContain("Ingress");
    expect(spec.ingress[0].from[0].podSelector.matchLabels["app.kubernetes.io/name"]).toBe("frontend");
  });

  test("egress rules with ports", () => {
    const result = NetworkIsolatedApp({
      ...minProps,
      allowEgressTo: [{ podSelector: { "app.kubernetes.io/name": "db" }, ports: [{ port: 5432 }] }],
    });
    const spec = p(result.networkPolicy).spec as any;
    expect(spec.policyTypes).toContain("Egress");
    expect(spec.egress[0].ports[0].port).toBe(5432);
  });

  test("namespace propagated", () => {
    const result = NetworkIsolatedApp({ ...minProps, namespace: "prod" });
    expect((p(result.networkPolicy).metadata as any).namespace).toBe("prod");
  });

  test("component label on networkPolicy", () => {
    const result = NetworkIsolatedApp(minProps);
    expect((p(result.networkPolicy).metadata as any).labels["app.kubernetes.io/component"]).toBe("network-policy");
  });
});

// ── IrsaServiceAccount ──────────────────────────────────────────────

describe("IrsaServiceAccount", () => {
  const minProps = { name: "app-sa", iamRoleArn: "arn:aws:iam::123456789012:role/app-role" };

  test("returns serviceAccount with IRSA annotation", () => {
    const result = IrsaServiceAccount(minProps);
    expect(result.serviceAccount).toBeDefined();
    const meta = p(result.serviceAccount).metadata as any;
    expect(meta.annotations["eks.amazonaws.com/role-arn"]).toBe("arn:aws:iam::123456789012:role/app-role");
  });

  test("no RBAC by default", () => {
    const result = IrsaServiceAccount(minProps);
    expect(result.role).toBeUndefined();
    expect(result.roleBinding).toBeUndefined();
  });

  test("RBAC created when rules provided", () => {
    const result = IrsaServiceAccount({
      ...minProps,
      rbacRules: [{ apiGroups: [""], resources: ["secrets"], verbs: ["get"] }],
    });
    expect(result.role).toBeDefined();
    expect(result.roleBinding).toBeDefined();
    const role = p(result.role) as any;
    expect(role.rules[0].resources).toEqual(["secrets"]);
  });

  test("namespace propagated", () => {
    const result = IrsaServiceAccount({ ...minProps, namespace: "prod" });
    expect((p(result.serviceAccount).metadata as any).namespace).toBe("prod");
  });

  test("component labels", () => {
    const result = IrsaServiceAccount(minProps);
    expect((p(result.serviceAccount).metadata as any).labels["app.kubernetes.io/component"]).toBe("service-account");
  });
});

// ── AlbIngress ──────────────────────────────────────────────────────

describe("AlbIngress", () => {
  const minProps = {
    name: "api-ingress",
    hosts: [{ hostname: "api.example.com", paths: [{ path: "/", serviceName: "api", servicePort: 80 }] }],
  };

  test("returns ingress with ALB annotations", () => {
    const result = AlbIngress(minProps);
    expect(result.ingress).toBeDefined();
    const meta = p(result.ingress).metadata as any;
    expect(meta.annotations["alb.ingress.kubernetes.io/scheme"]).toBe("internet-facing");
    expect(meta.annotations["alb.ingress.kubernetes.io/target-type"]).toBe("ip");
  });

  test("ingressClassName is alb", () => {
    const result = AlbIngress(minProps);
    const spec = p(result.ingress).spec as any;
    expect(spec.ingressClassName).toBe("alb");
  });

  test("certificate ARN sets TLS annotations", () => {
    const result = AlbIngress({ ...minProps, certificateArn: "arn:aws:acm:us-east-1:123:cert/abc" });
    const meta = p(result.ingress).metadata as any;
    expect(meta.annotations["alb.ingress.kubernetes.io/certificate-arn"]).toBe("arn:aws:acm:us-east-1:123:cert/abc");
    expect(meta.annotations["alb.ingress.kubernetes.io/ssl-redirect"]).toBe("443");
  });

  test("groupName annotation set", () => {
    const result = AlbIngress({ ...minProps, groupName: "shared-alb" });
    const meta = p(result.ingress).metadata as any;
    expect(meta.annotations["alb.ingress.kubernetes.io/group.name"]).toBe("shared-alb");
  });

  test("WAF ACL annotation set", () => {
    const result = AlbIngress({ ...minProps, wafAclArn: "arn:aws:wafv2:us-east-1:123:regional/webacl/abc" });
    const meta = p(result.ingress).metadata as any;
    expect(meta.annotations["alb.ingress.kubernetes.io/wafv2-acl-arn"]).toBe("arn:aws:wafv2:us-east-1:123:regional/webacl/abc");
  });

  test("internal scheme", () => {
    const result = AlbIngress({ ...minProps, scheme: "internal" });
    const meta = p(result.ingress).metadata as any;
    expect(meta.annotations["alb.ingress.kubernetes.io/scheme"]).toBe("internal");
  });

  test("empty-string certificateArn does NOT set ssl-redirect", () => {
    const result = AlbIngress({ ...minProps, certificateArn: "" });
    const meta = p(result.ingress).metadata as any;
    expect(meta.annotations["alb.ingress.kubernetes.io/ssl-redirect"]).toBeUndefined();
    expect(meta.annotations["alb.ingress.kubernetes.io/certificate-arn"]).toBeUndefined();
  });

  test("explicit sslRedirect: true overrides empty certificateArn", () => {
    const result = AlbIngress({ ...minProps, certificateArn: "", sslRedirect: true });
    const meta = p(result.ingress).metadata as any;
    expect(meta.annotations["alb.ingress.kubernetes.io/ssl-redirect"]).toBe("443");
  });

  test("explicit sslRedirect: false suppresses redirect even with cert", () => {
    const result = AlbIngress({ ...minProps, certificateArn: "arn:aws:acm:us-east-1:123:cert/abc", sslRedirect: false });
    const meta = p(result.ingress).metadata as any;
    expect(meta.annotations["alb.ingress.kubernetes.io/ssl-redirect"]).toBeUndefined();
  });
});

// ── GceIngress ──────────────────────────────────────────────────────

describe("GceIngress", () => {
  const minProps = {
    name: "api-ingress",
    hosts: [{ hostname: "api.example.com", paths: [{ path: "/", serviceName: "api", servicePort: 80 }] }],
  };

  test("returns ingress with GCE annotations", () => {
    const result = GceIngress(minProps);
    expect(result.ingress).toBeDefined();
    const meta = p(result.ingress).metadata as any;
    expect(meta.annotations["kubernetes.io/ingress.class"]).toBe("gce");
  });

  test("static IP annotation set", () => {
    const result = GceIngress({ ...minProps, staticIpName: "microservice-ip" });
    const meta = p(result.ingress).metadata as any;
    expect(meta.annotations["kubernetes.io/ingress.global-static-ip-name"]).toBe("microservice-ip");
  });

  test("managed certificate annotation set", () => {
    const result = GceIngress({ ...minProps, managedCertificate: "api-cert" });
    const meta = p(result.ingress).metadata as any;
    expect(meta.annotations["networking.gke.io/managed-certificates"]).toBe("api-cert");
  });

  test("frontendConfig annotation set", () => {
    const result = GceIngress({ ...minProps, frontendConfig: "my-frontend" });
    const meta = p(result.ingress).metadata as any;
    expect(meta.annotations["networking.gke.io/v1beta1.FrontendConfig"]).toBe("my-frontend");
  });

  test("managedCertificate sets default FrontendConfig for ssl redirect", () => {
    const result = GceIngress({ ...minProps, managedCertificate: "api-cert" });
    const meta = p(result.ingress).metadata as any;
    expect(meta.annotations["networking.gke.io/v1beta1.FrontendConfig"]).toBe("api-ingress-frontend-config");
  });

  test("explicit sslRedirect: false suppresses FrontendConfig even with cert", () => {
    const result = GceIngress({ ...minProps, managedCertificate: "api-cert", sslRedirect: false });
    const meta = p(result.ingress).metadata as any;
    expect(meta.annotations["networking.gke.io/v1beta1.FrontendConfig"]).toBeUndefined();
  });

  test("explicit sslRedirect: true sets default FrontendConfig without cert", () => {
    const result = GceIngress({ ...minProps, sslRedirect: true });
    const meta = p(result.ingress).metadata as any;
    expect(meta.annotations["networking.gke.io/v1beta1.FrontendConfig"]).toBe("api-ingress-frontend-config");
  });

  test("namespace is set when provided", () => {
    const result = GceIngress({ ...minProps, namespace: "production" });
    const meta = p(result.ingress).metadata as any;
    expect(meta.namespace).toBe("production");
  });

  test("host rules are mapped correctly", () => {
    const result = GceIngress(minProps);
    const spec = p(result.ingress).spec as any;
    expect(spec.rules).toHaveLength(1);
    expect(spec.rules[0].host).toBe("api.example.com");
    expect(spec.rules[0].http.paths[0].backend.service.name).toBe("api");
  });

  test("labels include component: ingress", () => {
    const result = GceIngress(minProps);
    const meta = p(result.ingress).metadata as any;
    expect(meta.labels["app.kubernetes.io/component"]).toBe("ingress");
    expect(meta.labels["app.kubernetes.io/managed-by"]).toBe("chant");
  });
});

// ── EbsStorageClass ─────────────────────────────────────────────────

describe("EbsStorageClass", () => {
  test("returns storageClass with EBS provisioner", () => {
    const result = EbsStorageClass({ name: "gp3" });
    expect(result.storageClass).toBeDefined();
    expect((p(result.storageClass) as any).provisioner).toBe("ebs.csi.aws.com");
  });

  test("default type is gp3", () => {
    const result = EbsStorageClass({ name: "default" });
    expect((p(result.storageClass) as any).parameters.type).toBe("gp3");
  });

  test("encryption enabled by default", () => {
    const result = EbsStorageClass({ name: "enc" });
    expect((p(result.storageClass) as any).parameters.encrypted).toBe("true");
  });

  test("custom parameters", () => {
    const result = EbsStorageClass({ name: "custom", type: "io2", iops: "5000", throughput: "250" });
    const params = (p(result.storageClass) as any).parameters;
    expect(params.type).toBe("io2");
    expect(params.iops).toBe("5000");
    expect(params.throughput).toBe("250");
  });

  test("allowVolumeExpansion default true", () => {
    const result = EbsStorageClass({ name: "exp" });
    expect((p(result.storageClass) as any).allowVolumeExpansion).toBe(true);
  });

  test("storageClass is cluster-scoped (no namespace)", () => {
    const result = EbsStorageClass({ name: "sc" });
    expect((p(result.storageClass).metadata as any).namespace).toBeUndefined();
  });

  test("numeric iops and throughput coerced to strings", () => {
    const result = EbsStorageClass({ name: "perf", iops: 5000, throughput: 250 });
    const params = (p(result.storageClass) as any).parameters;
    expect(params.iops).toBe("5000");
    expect(params.throughput).toBe("250");
  });

  test("string iops and throughput passed through", () => {
    const result = EbsStorageClass({ name: "perf", iops: "3000", throughput: "125" });
    const params = (p(result.storageClass) as any).parameters;
    expect(params.iops).toBe("3000");
    expect(params.throughput).toBe("125");
  });
});

// ── EfsStorageClass ─────────────────────────────────────────────────

describe("EfsStorageClass", () => {
  test("returns storageClass with EFS provisioner", () => {
    const result = EfsStorageClass({ name: "efs", fileSystemId: "fs-123" });
    expect((p(result.storageClass) as any).provisioner).toBe("efs.csi.aws.com");
  });

  test("fileSystemId in parameters", () => {
    const result = EfsStorageClass({ name: "efs", fileSystemId: "fs-abc" });
    expect((p(result.storageClass) as any).parameters.fileSystemId).toBe("fs-abc");
  });

  test("default provisioningMode is efs-ap", () => {
    const result = EfsStorageClass({ name: "efs", fileSystemId: "fs-123" });
    expect((p(result.storageClass) as any).parameters.provisioningMode).toBe("efs-ap");
  });
});

// ── FluentBitAgent ──────────────────────────────────────────────────

describe("FluentBitAgent", () => {
  const minProps = { logGroup: "/aws/eks/cluster/containers", region: "us-east-1", clusterName: "cluster" };

  test("returns all 5 resources", () => {
    const result = FluentBitAgent(minProps);
    expect(result.daemonSet).toBeDefined();
    expect(result.serviceAccount).toBeDefined();
    expect(result.clusterRole).toBeDefined();
    expect(result.clusterRoleBinding).toBeDefined();
    expect(result.configMap).toBeDefined();
  });

  test("default namespace is amazon-cloudwatch", () => {
    const result = FluentBitAgent(minProps);
    expect((p(result.daemonSet).metadata as any).namespace).toBe("amazon-cloudwatch");
  });

  test("configMap contains fluent-bit config with region", () => {
    const result = FluentBitAgent(minProps);
    const data = (p(result.configMap) as any).data;
    expect(data["fluent-bit.conf"]).toContain("us-east-1");
    expect(data["fluent-bit.conf"]).toContain("/aws/eks/cluster/containers");
  });

  test("tolerations for all nodes", () => {
    const result = FluentBitAgent(minProps);
    const spec = p(result.daemonSet).spec as any;
    expect(spec.template.spec.tolerations).toEqual([{ operator: "Exists" }]);
  });

  test("clusterRole is cluster-scoped", () => {
    const result = FluentBitAgent(minProps);
    expect((p(result.clusterRole).metadata as any).namespace).toBeUndefined();
  });

  test("IRSA annotation when iamRoleArn set", () => {
    const result = FluentBitAgent({ ...minProps, iamRoleArn: "arn:aws:iam::123456789012:role/fb-role" });
    const meta = p(result.serviceAccount).metadata as any;
    expect(meta.annotations["eks.amazonaws.com/role-arn"]).toBe("arn:aws:iam::123456789012:role/fb-role");
  });

  test("no annotation when iamRoleArn omitted", () => {
    const result = FluentBitAgent(minProps);
    const meta = p(result.serviceAccount).metadata as any;
    expect(meta.annotations).toBeUndefined();
  });
});

// ── ExternalDnsAgent ────────────────────────────────────────────────

describe("ExternalDnsAgent", () => {
  const minProps = {
    iamRoleArn: "arn:aws:iam::123456789012:role/external-dns",
    domainFilters: ["example.com"],
  };

  test("returns deployment, serviceAccount, clusterRole, clusterRoleBinding", () => {
    const result = ExternalDnsAgent(minProps);
    expect(result.deployment).toBeDefined();
    expect(result.serviceAccount).toBeDefined();
    expect(result.clusterRole).toBeDefined();
    expect(result.clusterRoleBinding).toBeDefined();
  });

  test("IRSA annotation on serviceAccount", () => {
    const result = ExternalDnsAgent(minProps);
    const meta = p(result.serviceAccount).metadata as any;
    expect(meta.annotations["eks.amazonaws.com/role-arn"]).toBe("arn:aws:iam::123456789012:role/external-dns");
  });

  test("domain filter in args", () => {
    const result = ExternalDnsAgent(minProps);
    const spec = p(result.deployment).spec as any;
    const args = spec.template.spec.containers[0].args;
    expect(args).toContain("--domain-filter=example.com");
  });

  test("txtOwnerId in args when set", () => {
    const result = ExternalDnsAgent({ ...minProps, txtOwnerId: "my-cluster" });
    const spec = p(result.deployment).spec as any;
    const args = spec.template.spec.containers[0].args;
    expect(args).toContain("--txt-owner-id=my-cluster");
  });

  test("default namespace is kube-system", () => {
    const result = ExternalDnsAgent(minProps);
    expect((p(result.deployment).metadata as any).namespace).toBe("kube-system");
  });

  test("replicas is 1", () => {
    const result = ExternalDnsAgent(minProps);
    const spec = p(result.deployment).spec as any;
    expect(spec.replicas).toBe(1);
  });
});

// ── AdotCollector ───────────────────────────────────────────────────

describe("AdotCollector", () => {
  const minProps = { region: "us-east-1", clusterName: "cluster" };

  test("returns all 5 resources", () => {
    const result = AdotCollector(minProps);
    expect(result.daemonSet).toBeDefined();
    expect(result.serviceAccount).toBeDefined();
    expect(result.clusterRole).toBeDefined();
    expect(result.clusterRoleBinding).toBeDefined();
    expect(result.configMap).toBeDefined();
  });

  test("default namespace is amazon-metrics", () => {
    const result = AdotCollector(minProps);
    expect((p(result.daemonSet).metadata as any).namespace).toBe("amazon-metrics");
  });

  test("configMap contains ADOT config with region", () => {
    const result = AdotCollector(minProps);
    const data = (p(result.configMap) as any).data;
    expect(data["config.yaml"]).toContain("us-east-1");
    expect(data["config.yaml"]).toContain("cluster");
  });

  test("OTLP ports on container", () => {
    const result = AdotCollector(minProps);
    const spec = p(result.daemonSet).spec as any;
    const ports = spec.template.spec.containers[0].ports;
    expect(ports).toHaveLength(2);
    expect(ports[0].containerPort).toBe(4317);
    expect(ports[1].containerPort).toBe(4318);
  });

  test("tolerations for all nodes", () => {
    const result = AdotCollector(minProps);
    const spec = p(result.daemonSet).spec as any;
    expect(spec.template.spec.tolerations).toEqual([{ operator: "Exists" }]);
  });

  test("custom exporters", () => {
    const result = AdotCollector({ ...minProps, exporters: ["prometheus"] });
    const data = (p(result.configMap) as any).data;
    expect(data["config.yaml"]).toContain("prometheusremotewrite");
  });

  test("IRSA annotation when iamRoleArn set", () => {
    const result = AdotCollector({ ...minProps, iamRoleArn: "arn:aws:iam::123456789012:role/adot-role" });
    const meta = p(result.serviceAccount).metadata as any;
    expect(meta.annotations["eks.amazonaws.com/role-arn"]).toBe("arn:aws:iam::123456789012:role/adot-role");
  });

  test("no annotation when iamRoleArn omitted", () => {
    const result = AdotCollector(minProps);
    const meta = p(result.serviceAccount).metadata as any;
    expect(meta.annotations).toBeUndefined();
  });
});

// ── MetricsServer ──────────────────────────────────────────────────

describe("MetricsServer", () => {
  test("returns all 8 resources", () => {
    const result = MetricsServer({});
    expect(result.deployment).toBeDefined();
    expect(result.service).toBeDefined();
    expect(result.serviceAccount).toBeDefined();
    expect(result.clusterRole).toBeDefined();
    expect(result.clusterRoleBinding).toBeDefined();
    expect(result.aggregatedClusterRole).toBeDefined();
    expect(result.authDelegatorBinding).toBeDefined();
    expect(result.apiService).toBeDefined();
  });

  test("default namespace is kube-system", () => {
    const result = MetricsServer({});
    expect((p(result.deployment).metadata as any).namespace).toBe("kube-system");
    expect((p(result.service).metadata as any).namespace).toBe("kube-system");
    expect((p(result.serviceAccount).metadata as any).namespace).toBe("kube-system");
  });

  test("service targets port 10250", () => {
    const result = MetricsServer({});
    const spec = p(result.service).spec as any;
    expect(spec.ports[0].port).toBe(443);
    expect(spec.ports[0].targetPort).toBe(10250);
  });

  test("deployment container has correct image and args", () => {
    const result = MetricsServer({});
    const spec = p(result.deployment).spec as any;
    const container = spec.template.spec.containers[0];
    expect(container.image).toBe("registry.k8s.io/metrics-server/metrics-server:v0.7.2");
    expect(container.args).toContain("--secure-port=10250");
    expect(container.args).toContain("--kubelet-use-node-status-port");
    expect(container.args).toContain("--metric-resolution=15s");
  });

  test("clusterRole has nodes/metrics access", () => {
    const result = MetricsServer({});
    const rules = p(result.clusterRole).rules as any[];
    const nodeMetricsRule = rules.find((r: any) => r.resources?.includes("nodes/metrics"));
    expect(nodeMetricsRule).toBeDefined();
  });

  test("apiService references correct service", () => {
    const result = MetricsServer({});
    const spec = (p(result.apiService) as any).spec;
    expect(spec.service.name).toBe("metrics-server");
    expect(spec.service.namespace).toBe("kube-system");
    expect(spec.group).toBe("metrics.k8s.io");
    expect(spec.version).toBe("v1beta1");
  });

  test("aggregated clusterRole has aggregate labels", () => {
    const result = MetricsServer({});
    const labels = (p(result.aggregatedClusterRole).metadata as any).labels;
    expect(labels["rbac.authorization.k8s.io/aggregate-to-admin"]).toBe("true");
    expect(labels["rbac.authorization.k8s.io/aggregate-to-view"]).toBe("true");
  });

  test("custom image and replicas", () => {
    const result = MetricsServer({ image: "custom:v1", replicas: 2 });
    const spec = p(result.deployment).spec as any;
    expect(spec.replicas).toBe(2);
    expect(spec.template.spec.containers[0].image).toBe("custom:v1");
  });
});

// ── PSS restricted securityContext passthrough tests ─────────────

const pssSecurityContext = {
  runAsNonRoot: true,
  readOnlyRootFilesystem: true,
  allowPrivilegeEscalation: false,
  capabilities: { drop: ["ALL"] },
  seccompProfile: { type: "RuntimeDefault" },
};

describe("BatchJob securityContext", () => {
  test("securityContext passed through to container", () => {
    const result = BatchJob({
      name: "migrate",
      image: "migrate:1.0",
      securityContext: pssSecurityContext,
    });
    const spec = p(result.job).spec as any;
    const sc = spec.template.spec.containers[0].securityContext;
    expect(sc.runAsNonRoot).toBe(true);
    expect(sc.allowPrivilegeEscalation).toBe(false);
    expect(sc.capabilities).toEqual({ drop: ["ALL"] });
    expect(sc.seccompProfile).toEqual({ type: "RuntimeDefault" });
  });
});

describe("CronWorkload securityContext", () => {
  test("securityContext passed through to container", () => {
    const result = CronWorkload({
      name: "backup",
      image: "backup:1.0",
      schedule: "0 2 * * *",
      securityContext: pssSecurityContext,
    });
    const spec = p(result.cronJob).spec as any;
    const sc = spec.jobTemplate.spec.template.spec.containers[0].securityContext;
    expect(sc.runAsNonRoot).toBe(true);
    expect(sc.allowPrivilegeEscalation).toBe(false);
    expect(sc.capabilities).toEqual({ drop: ["ALL"] });
    expect(sc.seccompProfile).toEqual({ type: "RuntimeDefault" });
  });
});

describe("NodeAgent securityContext", () => {
  test("securityContext passed through to container", () => {
    const result = NodeAgent({
      name: "agent",
      image: "agent:1.0",
      rbacRules: [{ apiGroups: [""], resources: ["pods"], verbs: ["get"] }],
      securityContext: pssSecurityContext,
    });
    const spec = p(result.daemonSet).spec as any;
    const sc = spec.template.spec.containers[0].securityContext;
    expect(sc.runAsNonRoot).toBe(true);
    expect(sc.allowPrivilegeEscalation).toBe(false);
    expect(sc.capabilities).toEqual({ drop: ["ALL"] });
  });
});

describe("ConfiguredApp securityContext", () => {
  test("securityContext passed through to container", () => {
    const result = ConfiguredApp({
      name: "api",
      image: "api:1.0",
      securityContext: pssSecurityContext,
    });
    const spec = p(result.deployment).spec as any;
    const sc = spec.template.spec.containers[0].securityContext;
    expect(sc.runAsNonRoot).toBe(true);
    expect(sc.allowPrivilegeEscalation).toBe(false);
    expect(sc.capabilities).toEqual({ drop: ["ALL"] });
    expect(sc.seccompProfile).toEqual({ type: "RuntimeDefault" });
  });
});

describe("SidecarApp securityContext", () => {
  test("securityContext passed through to primary container", () => {
    const result = SidecarApp({
      name: "api",
      image: "api:1.0",
      sidecars: [{ name: "envoy", image: "envoy:1.0" }],
      securityContext: pssSecurityContext,
    });
    const spec = p(result.deployment).spec as any;
    const sc = spec.template.spec.containers[0].securityContext;
    expect(sc.runAsNonRoot).toBe(true);
    expect(sc.allowPrivilegeEscalation).toBe(false);
    expect(sc.capabilities).toEqual({ drop: ["ALL"] });
    expect(sc.seccompProfile).toEqual({ type: "RuntimeDefault" });
  });
});

describe("NetworkIsolatedApp securityContext", () => {
  test("securityContext passed through to container", () => {
    const result = NetworkIsolatedApp({
      name: "api",
      image: "api:1.0",
      securityContext: pssSecurityContext,
    });
    const spec = p(result.deployment).spec as any;
    const sc = spec.template.spec.containers[0].securityContext;
    expect(sc.runAsNonRoot).toBe(true);
    expect(sc.allowPrivilegeEscalation).toBe(false);
    expect(sc.capabilities).toEqual({ drop: ["ALL"] });
    expect(sc.seccompProfile).toEqual({ type: "RuntimeDefault" });
  });
});

describe("MonitoredService securityContext", () => {
  test("securityContext passed through to container", () => {
    const result = MonitoredService({
      name: "api",
      image: "api:1.0",
      securityContext: pssSecurityContext,
    });
    const spec = p(result.deployment).spec as any;
    const sc = spec.template.spec.containers[0].securityContext;
    expect(sc.runAsNonRoot).toBe(true);
    expect(sc.allowPrivilegeEscalation).toBe(false);
    expect(sc.capabilities).toEqual({ drop: ["ALL"] });
    expect(sc.seccompProfile).toEqual({ type: "RuntimeDefault" });
  });
});

// ── Infrastructure composites: hardcoded security defaults ──────

describe("ExternalDnsAgent security defaults", () => {
  test("container has hardcoded PSS-safe securityContext", () => {
    const result = ExternalDnsAgent({
      iamRoleArn: "arn:aws:iam::123456789012:role/test",
      domainFilters: ["example.com"],
    });
    const spec = p(result.deployment).spec as any;
    const sc = spec.template.spec.containers[0].securityContext;
    expect(sc.runAsNonRoot).toBe(true);
    expect(sc.readOnlyRootFilesystem).toBe(true);
    expect(sc.allowPrivilegeEscalation).toBe(false);
  });
});

describe("FluentBitAgent security defaults", () => {
  test("container runs as root (needs host log access) with other PSS hardening", () => {
    const result = FluentBitAgent({
      logGroup: "/aws/eks/test/containers",
      region: "us-east-1",
      clusterName: "test",
    });
    const spec = p(result.daemonSet).spec as any;
    const sc = spec.template.spec.containers[0].securityContext;
    expect(sc.runAsUser).toBe(0);
    expect(sc.runAsNonRoot).toBeUndefined();
    expect(sc.readOnlyRootFilesystem).toBe(true);
    expect(sc.allowPrivilegeEscalation).toBe(false);
  });
});

describe("AdotCollector security defaults", () => {
  test("container runs as non-root with explicit UID (ADOT 'aoc' user)", () => {
    const result = AdotCollector({
      region: "us-east-1",
      clusterName: "test",
    });
    const spec = p(result.daemonSet).spec as any;
    const sc = spec.template.spec.containers[0].securityContext;
    expect(sc.runAsNonRoot).toBe(true);
    expect(sc.runAsUser).toBe(10001);
    expect(sc.readOnlyRootFilesystem).toBe(true);
    expect(sc.allowPrivilegeEscalation).toBe(false);
  });
});

// ── Phase 3B: Composite serialization smoke tests ───────────────

describe("Composite YAML serialization smoke tests", () => {
  function serializeCompositeProps(composite: Record<string, unknown>): string {
    return Object.values(composite)
      .filter((v) => v != null && typeof v === "object" && p(v as any) != null)
      .map((v) => emitYAML(p(v as any), 0))
      .join("\n---\n");
  }

  test("ExternalDnsAgent serializes to valid YAML", () => {
    const result = ExternalDnsAgent({
      iamRoleArn: "arn:aws:iam::123456789012:role/test",
      domainFilters: ["example.com"],
    });
    const yaml = serializeCompositeProps(result as any);
    expect(yaml).toContain("external-dns");
    expect(yaml).not.toContain("[object Object]");
  });

  test("FluentBitAgent serializes multiline config correctly", () => {
    const result = FluentBitAgent({
      logGroup: "/aws/eks/test/containers",
      region: "us-east-1",
      clusterName: "test",
    });
    const yaml = serializeCompositeProps(result as any);
    // Multiline config should use | block scalar, not flatten
    expect(yaml).toContain("|");
    expect(yaml).toContain("[SERVICE]");
    expect(yaml).toContain("[INPUT]");
    expect(yaml).not.toContain("\\n");
  });

  test("AdotCollector serializes multiline config correctly", () => {
    const result = AdotCollector({
      region: "us-east-1",
      clusterName: "test",
    });
    const yaml = serializeCompositeProps(result as any);
    expect(yaml).toContain("|");
    expect(yaml).toContain("receivers:");
    expect(yaml).toContain("exporters:");
    expect(yaml).not.toContain("\\n");
  });

  test("MetricsServer serializes to valid YAML", () => {
    const result = MetricsServer({});
    const yaml = serializeCompositeProps(result as any);
    expect(yaml).toContain("metrics-server");
    expect(yaml).not.toContain("[object Object]");
  });
});

// ── Phase 4A: MetricsServer RBAC completeness ──────────────────

describe("MetricsServer RBAC completeness", () => {
  test("clusterRole includes configmaps resource", () => {
    const result = MetricsServer({});
    const rules = p(result.clusterRole).rules as any[];
    const hasConfigmaps = rules.some((r: any) => r.resources?.includes("configmaps"));
    expect(hasConfigmaps).toBe(true);
  });
});

// ── Phase 4B: AdotCollector command vs args ─────────────────────

describe("AdotCollector command vs args", () => {
  test("container uses args (not command) for config flag", () => {
    const result = AdotCollector({
      region: "us-east-1",
      clusterName: "test",
    });
    const spec = p(result.daemonSet).spec as any;
    const container = spec.template.spec.containers[0];
    // Config flag should be in args, not command
    expect(container.args).toContain("--config=/etc/adot/config.yaml");
    expect(container.command).toBeUndefined();
  });
});

// ── Phase 4C: AdotCollector pipeline exporter separation ────────

describe("AdotCollector pipeline exporter separation", () => {
  test("metrics pipeline does NOT include awsxray", () => {
    const result = AdotCollector({
      region: "us-east-1",
      clusterName: "test",
      exporters: ["cloudwatch", "xray"],
    });
    const config = (p(result.configMap) as any).data["config.yaml"] as string;
    // Extract metrics pipeline exporters line
    const metricsMatch = config.match(/metrics:\s*\n\s*receivers:.*\n\s*processors:.*\n\s*exporters:\s*\[([^\]]+)\]/);
    expect(metricsMatch).toBeDefined();
    const metricsExporters = metricsMatch![1];
    expect(metricsExporters).not.toContain("awsxray");
    expect(metricsExporters).toContain("awsemf");
  });

  test("traces pipeline does NOT include awsemf", () => {
    const result = AdotCollector({
      region: "us-east-1",
      clusterName: "test",
      exporters: ["cloudwatch", "xray"],
    });
    const config = (p(result.configMap) as any).data["config.yaml"] as string;
    // Extract traces pipeline exporters line
    const tracesMatch = config.match(/traces:\s*\n\s*receivers:.*\n\s*processors:.*\n\s*exporters:\s*\[([^\]]+)\]/);
    expect(tracesMatch).toBeDefined();
    const tracesExporters = tracesMatch![1];
    expect(tracesExporters).not.toContain("awsemf");
    expect(tracesExporters).toContain("awsxray");
  });

  test("cloudwatch-only: traces pipeline falls back to valid default", () => {
    const result = AdotCollector({
      region: "us-east-1",
      clusterName: "test",
      exporters: ["cloudwatch"],
    });
    const config = (p(result.configMap) as any).data["config.yaml"] as string;
    // Traces pipeline should still have an exporter (fallback to awsxray)
    const tracesMatch = config.match(/traces:\s*\n\s*receivers:.*\n\s*processors:.*\n\s*exporters:\s*\[([^\]]+)\]/);
    expect(tracesMatch).toBeDefined();
    const tracesExporters = tracesMatch![1].trim();
    expect(tracesExporters.length).toBeGreaterThan(0);
  });
});

// ── Phase 4D: AdotCollector config parseable as YAML ────────────

describe("AdotCollector config structure", () => {
  test("generated config has required top-level sections", () => {
    const result = AdotCollector({
      region: "us-east-1",
      clusterName: "test",
    });
    const config = (p(result.configMap) as any).data["config.yaml"] as string;
    expect(config).toContain("receivers:");
    expect(config).toContain("exporters:");
    expect(config).toContain("processors:");
    expect(config).toContain("service:");
    expect(config).toContain("pipelines:");
    expect(config).toContain("metrics:");
    expect(config).toContain("traces:");
  });
});

// ── WorkloadIdentityServiceAccount ──────────────────────────────────

describe("WorkloadIdentityServiceAccount", () => {
  const minProps = { name: "app-sa", gcpServiceAccountEmail: "sa@my-project.iam.gserviceaccount.com" };

  test("returns serviceAccount with Workload Identity annotation", () => {
    const result = WorkloadIdentityServiceAccount(minProps);
    expect(result.serviceAccount).toBeDefined();
    const meta = p(result.serviceAccount).metadata as any;
    expect(meta.annotations["iam.gke.io/gcp-service-account"]).toBe("sa@my-project.iam.gserviceaccount.com");
  });

  test("no RBAC by default", () => {
    const result = WorkloadIdentityServiceAccount(minProps);
    expect(result.role).toBeUndefined();
    expect(result.roleBinding).toBeUndefined();
  });

  test("RBAC created when rules provided", () => {
    const result = WorkloadIdentityServiceAccount({
      ...minProps,
      rbacRules: [{ apiGroups: [""], resources: ["secrets"], verbs: ["get"] }],
    });
    expect(result.role).toBeDefined();
    expect(result.roleBinding).toBeDefined();
    const role = p(result.role) as any;
    expect(role.rules[0].resources).toEqual(["secrets"]);
  });

  test("namespace propagated", () => {
    const result = WorkloadIdentityServiceAccount({ ...minProps, namespace: "prod" });
    expect((p(result.serviceAccount).metadata as any).namespace).toBe("prod");
  });

  test("component labels", () => {
    const result = WorkloadIdentityServiceAccount(minProps);
    expect((p(result.serviceAccount).metadata as any).labels["app.kubernetes.io/component"]).toBe("service-account");
  });
});

// ── GcePdStorageClass ───────────────────────────────────────────────

describe("GcePdStorageClass", () => {
  test("returns storageClass with GCE PD provisioner", () => {
    const result = GcePdStorageClass({ name: "pd-balanced" });
    expect(result.storageClass).toBeDefined();
    expect((p(result.storageClass) as any).provisioner).toBe("pd.csi.storage.gke.io");
  });

  test("default type is pd-balanced", () => {
    const result = GcePdStorageClass({ name: "default" });
    expect((p(result.storageClass) as any).parameters.type).toBe("pd-balanced");
  });

  test("custom type", () => {
    const result = GcePdStorageClass({ name: "ssd", type: "pd-ssd" });
    expect((p(result.storageClass) as any).parameters.type).toBe("pd-ssd");
  });

  test("regional-pd replication type", () => {
    const result = GcePdStorageClass({ name: "regional", replicationType: "regional-pd" });
    expect((p(result.storageClass) as any).parameters["replication-type"]).toBe("regional-pd");
  });

  test("no replication-type param when none", () => {
    const result = GcePdStorageClass({ name: "default" });
    expect((p(result.storageClass) as any).parameters["replication-type"]).toBeUndefined();
  });

  test("allowVolumeExpansion default true", () => {
    const result = GcePdStorageClass({ name: "exp" });
    expect((p(result.storageClass) as any).allowVolumeExpansion).toBe(true);
  });

  test("storageClass is cluster-scoped (no namespace)", () => {
    const result = GcePdStorageClass({ name: "sc" });
    expect((p(result.storageClass).metadata as any).namespace).toBeUndefined();
  });
});

// ── FilestoreStorageClass ───────────────────────────────────────────

describe("FilestoreStorageClass", () => {
  test("returns storageClass with Filestore provisioner", () => {
    const result = FilestoreStorageClass({ name: "filestore" });
    expect((p(result.storageClass) as any).provisioner).toBe("filestore.csi.storage.gke.io");
  });

  test("default tier is standard", () => {
    const result = FilestoreStorageClass({ name: "fs" });
    expect((p(result.storageClass) as any).parameters.tier).toBe("standard");
  });

  test("custom tier", () => {
    const result = FilestoreStorageClass({ name: "premium-fs", tier: "premium" });
    expect((p(result.storageClass) as any).parameters.tier).toBe("premium");
  });

  test("network parameter set when provided", () => {
    const result = FilestoreStorageClass({ name: "fs", network: "my-vpc" });
    expect((p(result.storageClass) as any).parameters.network).toBe("my-vpc");
  });

  test("no network parameter by default", () => {
    const result = FilestoreStorageClass({ name: "fs" });
    expect((p(result.storageClass) as any).parameters.network).toBeUndefined();
  });
});

// ── GkeGateway ──────────────────────────────────────────────────────

describe("GkeGateway", () => {
  const minProps = {
    name: "api-gateway",
    hosts: [{ hostname: "api.example.com", paths: [{ path: "/", serviceName: "api", servicePort: 80 }] }],
  };

  test("returns gateway and httpRoute", () => {
    const result = GkeGateway(minProps);
    expect(result.gateway).toBeDefined();
    expect(result.httpRoute).toBeDefined();
  });

  test("default gatewayClassName", () => {
    const result = GkeGateway(minProps);
    const spec = p(result.gateway).spec as any;
    expect(spec.gatewayClassName).toBe("gke-l7-global-external-managed");
  });

  test("custom gatewayClassName", () => {
    const result = GkeGateway({ ...minProps, gatewayClassName: "gke-l7-rilb" });
    const spec = p(result.gateway).spec as any;
    expect(spec.gatewayClassName).toBe("gke-l7-rilb");
  });

  test("HTTP listener when no certificate", () => {
    const result = GkeGateway(minProps);
    const spec = p(result.gateway).spec as any;
    expect(spec.listeners[0].protocol).toBe("HTTP");
    expect(spec.listeners[0].port).toBe(80);
  });

  test("HTTPS listener with certificate", () => {
    const result = GkeGateway({ ...minProps, certificateName: "api-cert" });
    const spec = p(result.gateway).spec as any;
    expect(spec.listeners[0].protocol).toBe("HTTPS");
    expect(spec.listeners[0].port).toBe(443);
    expect(spec.listeners[0].tls.certificateRefs[0].name).toBe("api-cert");
  });

  test("httpRoute references parent gateway", () => {
    const result = GkeGateway(minProps);
    const spec = p(result.httpRoute).spec as any;
    expect(spec.parentRefs[0].name).toBe("api-gateway");
  });

  test("httpRoute has hostnames", () => {
    const result = GkeGateway(minProps);
    const spec = p(result.httpRoute).spec as any;
    expect(spec.hostnames).toEqual(["api.example.com"]);
  });

  test("httpRoute rules map to backend services", () => {
    const result = GkeGateway(minProps);
    const spec = p(result.httpRoute).spec as any;
    expect(spec.rules[0].backendRefs[0].name).toBe("api");
    expect(spec.rules[0].backendRefs[0].port).toBe(80);
  });

  test("namespace propagated to both resources", () => {
    const result = GkeGateway({ ...minProps, namespace: "prod" });
    expect((p(result.gateway).metadata as any).namespace).toBe("prod");
    expect((p(result.httpRoute).metadata as any).namespace).toBe("prod");
  });
});

// ── ConfigConnectorContext ───────────────────────────────────────────

describe("ConfigConnectorContext", () => {
  const minProps = { googleServiceAccountEmail: "cnrm@my-project.iam.gserviceaccount.com" };

  test("returns context with apiVersion and kind", () => {
    const result = ConfigConnectorContext(minProps);
    expect(result.context).toBeDefined();
    expect((p(result.context) as any).apiVersion).toBe("core.cnrm.cloud.google.com/v1beta1");
    expect((p(result.context) as any).kind).toBe("ConfigConnectorContext");
  });

  test("googleServiceAccount in spec", () => {
    const result = ConfigConnectorContext(minProps);
    const spec = (p(result.context) as any).spec;
    expect(spec.googleServiceAccount).toBe("cnrm@my-project.iam.gserviceaccount.com");
  });

  test("default stateIntoSpec is Absent", () => {
    const result = ConfigConnectorContext(minProps);
    expect((p(result.context) as any).spec.stateIntoSpec).toBe("Absent");
  });

  test("custom stateIntoSpec", () => {
    const result = ConfigConnectorContext({ ...minProps, stateIntoSpec: "Merge" });
    expect((p(result.context) as any).spec.stateIntoSpec).toBe("Merge");
  });

  test("default namespace is default", () => {
    const result = ConfigConnectorContext(minProps);
    expect((p(result.context) as any).metadata.namespace).toBe("default");
  });

  test("custom namespace", () => {
    const result = ConfigConnectorContext({ ...minProps, namespace: "config-connector" });
    expect((p(result.context) as any).metadata.namespace).toBe("config-connector");
  });
});

// ── GkeFluentBitAgent ────────────────────────────────────────────────

describe("GkeFluentBitAgent", () => {
  const { GkeFluentBitAgent } = require("./gke-fluent-bit-agent");

  const minProps = {
    clusterName: "test-cluster",
    projectId: "test-project",
    gcpServiceAccountEmail: "fluent-bit@test-project.iam.gserviceaccount.com",
  };

  test("returns all expected resources", () => {
    const result = GkeFluentBitAgent(minProps);
    expect(result.daemonSet).toBeDefined();
    expect(result.serviceAccount).toBeDefined();
    expect(result.clusterRole).toBeDefined();
    expect(result.clusterRoleBinding).toBeDefined();
    expect(result.configMap).toBeDefined();
  });

  test("SA has GKE Workload Identity annotation", () => {
    const result = GkeFluentBitAgent(minProps);
    const meta = p(result.serviceAccount).metadata as any;
    expect(meta.annotations["iam.gke.io/gcp-service-account"]).toBe(
      "fluent-bit@test-project.iam.gserviceaccount.com",
    );
  });

  test("SA has no annotation when gcpServiceAccountEmail omitted", () => {
    const result = GkeFluentBitAgent({
      clusterName: "test-cluster",
      projectId: "test-project",
    });
    const meta = p(result.serviceAccount).metadata as any;
    expect(meta.annotations).toBeUndefined();
  });

  test("configMap uses stackdriver output", () => {
    const result = GkeFluentBitAgent(minProps);
    const data = p(result.configMap).data as any;
    expect(data["fluent-bit.conf"]).toContain("stackdriver");
    expect(data["fluent-bit.conf"]).toContain("test-cluster");
  });

  test("default namespace is gke-logging", () => {
    const result = GkeFluentBitAgent(minProps);
    expect((p(result.daemonSet).metadata as any).namespace).toBe("gke-logging");
    expect((p(result.serviceAccount).metadata as any).namespace).toBe("gke-logging");
  });

  test("common labels on all resources", () => {
    const result = GkeFluentBitAgent(minProps);
    for (const resource of [result.daemonSet, result.serviceAccount, result.clusterRole, result.clusterRoleBinding, result.configMap]) {
      expect((p(resource).metadata as any).labels["app.kubernetes.io/managed-by"]).toBe("chant");
    }
  });

  test("DaemonSet mounts host log directory", () => {
    const result = GkeFluentBitAgent(minProps);
    const spec = (p(result.daemonSet) as any).spec.template.spec;
    const varlog = spec.volumes.find((v: any) => v.name === "varlog");
    expect(varlog.hostPath.path).toBe("/var/log");
  });

  test("container runs as root for log access", () => {
    const result = GkeFluentBitAgent(minProps);
    const container = (p(result.daemonSet) as any).spec.template.spec.containers[0];
    expect(container.securityContext.runAsUser).toBe(0);
    expect(container.securityContext.readOnlyRootFilesystem).toBe(true);
  });
});

// ── GkeOtelCollector ─────────────────────────────────────────────────

describe("GkeOtelCollector", () => {
  const { GkeOtelCollector } = require("./gke-otel-collector");

  const minProps = {
    clusterName: "test-cluster",
    projectId: "test-project",
    gcpServiceAccountEmail: "otel@test-project.iam.gserviceaccount.com",
  };

  test("returns all expected resources", () => {
    const result = GkeOtelCollector(minProps);
    expect(result.daemonSet).toBeDefined();
    expect(result.serviceAccount).toBeDefined();
    expect(result.clusterRole).toBeDefined();
    expect(result.clusterRoleBinding).toBeDefined();
    expect(result.configMap).toBeDefined();
  });

  test("SA has GKE Workload Identity annotation", () => {
    const result = GkeOtelCollector(minProps);
    const meta = p(result.serviceAccount).metadata as any;
    expect(meta.annotations["iam.gke.io/gcp-service-account"]).toBe(
      "otel@test-project.iam.gserviceaccount.com",
    );
  });

  test("SA has no annotation when gcpServiceAccountEmail omitted", () => {
    const result = GkeOtelCollector({
      clusterName: "test-cluster",
      projectId: "test-project",
    });
    const meta = p(result.serviceAccount).metadata as any;
    expect(meta.annotations).toBeUndefined();
  });

  test("configMap uses googlecloud exporter", () => {
    const result = GkeOtelCollector(minProps);
    const data = p(result.configMap).data as any;
    expect(data["config.yaml"]).toContain("googlecloud");
    expect(data["config.yaml"]).toContain("test-project");
  });

  test("default namespace is gke-monitoring", () => {
    const result = GkeOtelCollector(minProps);
    expect((p(result.daemonSet).metadata as any).namespace).toBe("gke-monitoring");
  });

  test("container exposes OTLP ports", () => {
    const result = GkeOtelCollector(minProps);
    const container = (p(result.daemonSet) as any).spec.template.spec.containers[0];
    const ports = container.ports.map((p: any) => p.containerPort);
    expect(ports).toContain(4317);
    expect(ports).toContain(4318);
  });

  test("container runs as non-root", () => {
    const result = GkeOtelCollector(minProps);
    const container = (p(result.daemonSet) as any).spec.template.spec.containers[0];
    expect(container.securityContext.runAsNonRoot).toBe(true);
    expect(container.securityContext.runAsUser).toBe(10001);
  });

  test("common labels on all resources", () => {
    const result = GkeOtelCollector(minProps);
    for (const resource of [result.daemonSet, result.serviceAccount, result.clusterRole, result.clusterRoleBinding, result.configMap]) {
      expect((p(resource).metadata as any).labels["app.kubernetes.io/managed-by"]).toBe("chant");
    }
  });
});

// ── GkeExternalDnsAgent ──────────────────────────────────────────────

describe("GkeExternalDnsAgent", () => {
  const { GkeExternalDnsAgent } = require("./gke-external-dns-agent");

  const minProps = {
    gcpServiceAccountEmail: "external-dns@test-project.iam.gserviceaccount.com",
    gcpProjectId: "test-project",
    domainFilters: ["example.com"],
  };

  test("returns all expected resources", () => {
    const result = GkeExternalDnsAgent(minProps);
    expect(result.deployment).toBeDefined();
    expect(result.serviceAccount).toBeDefined();
    expect(result.clusterRole).toBeDefined();
    expect(result.clusterRoleBinding).toBeDefined();
  });

  test("SA has GKE Workload Identity annotation", () => {
    const result = GkeExternalDnsAgent(minProps);
    const meta = p(result.serviceAccount).metadata as any;
    expect(meta.annotations["iam.gke.io/gcp-service-account"]).toBe(
      "external-dns@test-project.iam.gserviceaccount.com",
    );
  });

  test("uses google provider", () => {
    const result = GkeExternalDnsAgent(minProps);
    const container = (p(result.deployment) as any).spec.template.spec.containers[0];
    expect(container.args).toContain("--provider=google");
  });

  test("passes google-project arg", () => {
    const result = GkeExternalDnsAgent(minProps);
    const container = (p(result.deployment) as any).spec.template.spec.containers[0];
    expect(container.args).toContain("--google-project=test-project");
  });

  test("domain filters are applied", () => {
    const result = GkeExternalDnsAgent(minProps);
    const container = (p(result.deployment) as any).spec.template.spec.containers[0];
    expect(container.args).toContain("--domain-filter=example.com");
  });

  test("txtOwnerId is applied when set", () => {
    const result = GkeExternalDnsAgent({ ...minProps, txtOwnerId: "my-cluster" });
    const container = (p(result.deployment) as any).spec.template.spec.containers[0];
    expect(container.args).toContain("--txt-owner-id=my-cluster");
  });

  test("default namespace is kube-system", () => {
    const result = GkeExternalDnsAgent(minProps);
    expect((p(result.deployment).metadata as any).namespace).toBe("kube-system");
  });

  test("container runs as non-root", () => {
    const result = GkeExternalDnsAgent(minProps);
    const container = (p(result.deployment) as any).spec.template.spec.containers[0];
    expect(container.securityContext.runAsNonRoot).toBe(true);
    expect(container.securityContext.runAsUser).toBe(65534);
  });
});

// ── AksExternalDnsAgent ──────────────────────────────────────────────

describe("AksExternalDnsAgent", () => {
  const { AksExternalDnsAgent } = require("./aks-external-dns-agent");

  const minProps = {
    clientId: "00000000-0000-0000-0000-000000000000",
    resourceGroup: "test-rg",
    subscriptionId: "11111111-1111-1111-1111-111111111111",
    tenantId: "22222222-2222-2222-2222-222222222222",
    domainFilters: ["example.com"],
  };

  test("returns all expected resources", () => {
    const result = AksExternalDnsAgent(minProps);
    expect(result.deployment).toBeDefined();
    expect(result.serviceAccount).toBeDefined();
    expect(result.clusterRole).toBeDefined();
    expect(result.clusterRoleBinding).toBeDefined();
  });

  test("SA has AKS Workload Identity annotation and label", () => {
    const result = AksExternalDnsAgent(minProps);
    const meta = p(result.serviceAccount).metadata as any;
    expect(meta.annotations["azure.workload.identity/client-id"]).toBe(
      "00000000-0000-0000-0000-000000000000",
    );
    expect(meta.labels["azure.workload.identity/use"]).toBe("true");
  });

  test("uses azure provider", () => {
    const result = AksExternalDnsAgent(minProps);
    const container = (p(result.deployment) as any).spec.template.spec.containers[0];
    expect(container.args).toContain("--provider=azure");
  });

  test("passes azure resource group and subscription", () => {
    const result = AksExternalDnsAgent(minProps);
    const container = (p(result.deployment) as any).spec.template.spec.containers[0];
    expect(container.args).toContain("--azure-resource-group=test-rg");
    expect(container.args).toContain("--azure-subscription-id=11111111-1111-1111-1111-111111111111");
  });

  test("container has Azure env vars", () => {
    const result = AksExternalDnsAgent(minProps);
    const container = (p(result.deployment) as any).spec.template.spec.containers[0];
    const envMap = Object.fromEntries(container.env.map((e: any) => [e.name, e.value]));
    expect(envMap.AZURE_TENANT_ID).toBe("22222222-2222-2222-2222-222222222222");
    expect(envMap.AZURE_SUBSCRIPTION_ID).toBe("11111111-1111-1111-1111-111111111111");
    expect(envMap.AZURE_RESOURCE_GROUP).toBe("test-rg");
  });

  test("pod labels include workload identity use label", () => {
    const result = AksExternalDnsAgent(minProps);
    const podLabels = (p(result.deployment) as any).spec.template.metadata.labels;
    expect(podLabels["azure.workload.identity/use"]).toBe("true");
  });

  test("domain filters are applied", () => {
    const result = AksExternalDnsAgent(minProps);
    const container = (p(result.deployment) as any).spec.template.spec.containers[0];
    expect(container.args).toContain("--domain-filter=example.com");
  });

  test("default namespace is kube-system", () => {
    const result = AksExternalDnsAgent(minProps);
    expect((p(result.deployment).metadata as any).namespace).toBe("kube-system");
  });

  test("container runs as non-root", () => {
    const result = AksExternalDnsAgent(minProps);
    const container = (p(result.deployment) as any).spec.template.spec.containers[0];
    expect(container.securityContext.runAsNonRoot).toBe(true);
    expect(container.securityContext.runAsUser).toBe(65534);
  });
});

// ── CockroachDbCluster ──────────────────────────────────────────────

describe("CockroachDbCluster", () => {
  const { CockroachDbCluster } = require("./cockroachdb-cluster");

  const minProps = { name: "cockroachdb" };

  test("returns all expected resources", () => {
    const result = CockroachDbCluster(minProps);
    expect(result.serviceAccount).toBeDefined();
    expect(result.role).toBeDefined();
    expect(result.roleBinding).toBeDefined();
    expect(result.clusterRole).toBeDefined();
    expect(result.clusterRoleBinding).toBeDefined();
    expect(result.publicService).toBeDefined();
    expect(result.headlessService).toBeDefined();
    expect(result.pdb).toBeDefined();
    expect(result.statefulSet).toBeDefined();
    expect(result.initJob).toBeDefined();
    expect(result.certGenJob).toBeDefined();
  });

  test("default replicas is 3", () => {
    const result = CockroachDbCluster(minProps);
    const spec = p(result.statefulSet).spec as any;
    expect(spec.replicas).toBe(3);
  });

  test("default image is cockroachdb/cockroach:v24.3.0", () => {
    const result = CockroachDbCluster(minProps);
    const container = (p(result.statefulSet).spec as any).template.spec.containers[0];
    expect(container.image).toBe("cockroachdb/cockroach:v24.3.0");
  });

  test("StatefulSet has correct ports (26257+8080)", () => {
    const result = CockroachDbCluster(minProps);
    const container = (p(result.statefulSet).spec as any).template.spec.containers[0];
    const ports = container.ports.map((p: any) => p.containerPort);
    expect(ports).toContain(26257);
    expect(ports).toContain(8080);
  });

  test("StatefulSet has PVC with default 100Gi storage", () => {
    const result = CockroachDbCluster(minProps);
    const vct = (p(result.statefulSet).spec as any).volumeClaimTemplates[0];
    expect(vct.spec.resources.requests.storage).toBe("100Gi");
    expect(vct.spec.accessModes).toEqual(["ReadWriteOnce"]);
  });

  test("headless service has clusterIP None and publishNotReadyAddresses", () => {
    const result = CockroachDbCluster(minProps);
    const spec = p(result.headlessService).spec as any;
    expect(spec.clusterIP).toBe("None");
    expect(spec.publishNotReadyAddresses).toBe(true);
  });

  test("public service has ClusterIP type with both ports", () => {
    const result = CockroachDbCluster(minProps);
    const spec = p(result.publicService).spec as any;
    expect(spec.type).toBe("ClusterIP");
    const ports = spec.ports.map((pt: any) => pt.port);
    expect(ports).toContain(26257);
    expect(ports).toContain(8080);
  });

  test("PDB has maxUnavailable 1", () => {
    const result = CockroachDbCluster(minProps);
    const spec = p(result.pdb).spec as any;
    expect(spec.maxUnavailable).toBe(1);
  });

  test("StatefulSet has pod anti-affinity", () => {
    const result = CockroachDbCluster(minProps);
    const affinity = (p(result.statefulSet).spec as any).template.spec.affinity;
    expect(affinity.podAntiAffinity).toBeDefined();
  });

  test("props flow through (replicas, image, storage)", () => {
    const result = CockroachDbCluster({
      name: "crdb",
      replicas: 5,
      image: "cockroachdb/cockroach:v23.2.0",
      storageSize: "200Gi",
    });
    const spec = p(result.statefulSet).spec as any;
    expect(spec.replicas).toBe(5);
    expect(spec.template.spec.containers[0].image).toBe("cockroachdb/cockroach:v23.2.0");
    expect(spec.volumeClaimTemplates[0].spec.resources.requests.storage).toBe("200Gi");
  });

  test("joinAddresses appear in container args", () => {
    const joins = ["crdb-0.crdb.ns.svc.cluster.local", "crdb-1.crdb.ns.svc.cluster.local"];
    const result = CockroachDbCluster({ name: "crdb", joinAddresses: joins });
    const cmd = (p(result.statefulSet).spec as any).template.spec.containers[0].args[0] as string;
    expect(cmd).toContain("--join=");
    expect(cmd).toContain("crdb-0.crdb.ns.svc.cluster.local");
    expect(cmd).toContain("crdb-1.crdb.ns.svc.cluster.local");
  });

  test("locality appears in container args when set", () => {
    const result = CockroachDbCluster({ name: "crdb", locality: "cloud=aws,region=us-east-1" });
    const cmd = (p(result.statefulSet).spec as any).template.spec.containers[0].args[0] as string;
    expect(cmd).toContain("--locality=cloud=aws,region=us-east-1");
  });

  test("namespace is set on all namespaced resources", () => {
    const result = CockroachDbCluster({ name: "crdb", namespace: "crdb-eks" });
    for (const key of ["serviceAccount", "role", "roleBinding", "publicService", "headlessService", "pdb", "statefulSet", "initJob", "certGenJob"] as const) {
      expect((p(result[key]).metadata as any).namespace).toBe("crdb-eks");
    }
  });

  test("cluster-scoped resources do not have namespace", () => {
    const result = CockroachDbCluster({ name: "crdb", namespace: "crdb-eks" });
    expect((p(result.clusterRole).metadata as any).namespace).toBeUndefined();
    expect((p(result.clusterRoleBinding).metadata as any).namespace).toBeUndefined();
  });

  test("includes common labels", () => {
    const result = CockroachDbCluster(minProps);
    const meta = p(result.statefulSet).metadata as any;
    expect(meta.labels["app.kubernetes.io/name"]).toBe("cockroachdb");
    expect(meta.labels["app.kubernetes.io/managed-by"]).toBe("chant");
  });

  test("secure mode mounts certs volume", () => {
    const result = CockroachDbCluster({ name: "crdb", secure: true });
    const spec = (p(result.statefulSet).spec as any).template.spec;
    expect(spec.volumes).toBeDefined();
    const certsVol = spec.volumes.find((v: any) => v.name === "certs");
    expect(certsVol).toBeDefined();
    expect(certsVol.secret.secretName).toBe("crdb-node-certs");
  });

  test("insecure mode omits certs volume", () => {
    const result = CockroachDbCluster({ name: "crdb", secure: false });
    const spec = (p(result.statefulSet).spec as any).template.spec;
    expect(spec.volumes).toBeUndefined();
    const cmd = spec.containers[0].args[0] as string;
    expect(cmd).toContain("--insecure");
  });

  test("storageClassName is set when provided", () => {
    const result = CockroachDbCluster({ name: "crdb", storageClassName: "gp3-encrypted" });
    const vct = (p(result.statefulSet).spec as any).volumeClaimTemplates[0];
    expect(vct.spec.storageClassName).toBe("gp3-encrypted");
  });

  test("init job references correct host", () => {
    const result = CockroachDbCluster({ name: "crdb" });
    const container = (p(result.initJob).spec as any).template.spec.containers[0];
    expect(container.args).toContain("--host=crdb-0.crdb");
  });

  test("StatefulSet uses Parallel podManagementPolicy", () => {
    const result = CockroachDbCluster(minProps);
    expect((p(result.statefulSet).spec as any).podManagementPolicy).toBe("Parallel");
  });

  test("cert-gen job uses same image as StatefulSet", () => {
    const result = CockroachDbCluster({ name: "crdb", image: "cockroachdb/cockroach:v23.2.0" });
    const container = (p(result.certGenJob).spec as any).template.spec.containers[0];
    expect(container.image).toBe("cockroachdb/cockroach:v23.2.0");
  });
});
