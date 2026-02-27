import { describe, test, expect, jest } from "bun:test";
import { emitYAML } from "@intentius/chant/yaml";
import { WebApp } from "./web-app";
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
    const spec = result.ingress!.spec as any;
    expect(spec.rules[0].host).toBe("app.example.com");
  });

  test("ingress includes TLS when ingressTlsSecret is set", () => {
    const result = WebApp({
      name: "app",
      image: "app:1.0",
      ingressHost: "app.example.com",
      ingressTlsSecret: "tls-secret",
    });
    const spec = result.ingress!.spec as any;
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
    const spec = result.deployment.spec as any;
    expect(spec.replicas).toBe(5);
    const container = spec.template.spec.containers[0];
    expect(container.image).toBe("web:2.0");
    expect(container.ports[0].containerPort).toBe(3000);
  });

  test("default port is 80", () => {
    const result = WebApp({ name: "app", image: "app:1.0" });
    const spec = result.deployment.spec as any;
    const container = spec.template.spec.containers[0];
    expect(container.ports[0].containerPort).toBe(80);
  });

  test("default replicas is 2", () => {
    const result = WebApp({ name: "app", image: "app:1.0" });
    const spec = result.deployment.spec as any;
    expect(spec.replicas).toBe(2);
  });

  test("service type is ClusterIP", () => {
    const result = WebApp({ name: "app", image: "app:1.0" });
    const spec = result.service.spec as any;
    expect(spec.type).toBe("ClusterIP");
  });

  test("includes common labels", () => {
    const result = WebApp({ name: "app", image: "app:1.0" });
    const meta = result.deployment.metadata as any;
    expect(meta.labels["app.kubernetes.io/name"]).toBe("app");
    expect(meta.labels["app.kubernetes.io/managed-by"]).toBe("chant");
  });

  test("namespace is set when provided", () => {
    const result = WebApp({
      name: "app",
      image: "app:1.0",
      namespace: "prod",
    });
    const meta = result.deployment.metadata as any;
    expect(meta.namespace).toBe("prod");
  });

  test("env vars passed to container", () => {
    const result = WebApp({
      name: "app",
      image: "app:1.0",
      env: [{ name: "FOO", value: "bar" }],
    });
    const spec = result.deployment.spec as any;
    const container = spec.template.spec.containers[0];
    expect(container.env).toEqual([{ name: "FOO", value: "bar" }]);
  });

  test("component labels on each resource", () => {
    const result = WebApp({
      name: "app",
      image: "app:1.0",
      ingressHost: "app.example.com",
    });
    expect((result.deployment.metadata as any).labels["app.kubernetes.io/component"]).toBe("server");
    expect((result.service.metadata as any).labels["app.kubernetes.io/component"]).toBe("server");
    expect((result.ingress!.metadata as any).labels["app.kubernetes.io/component"]).toBe("ingress");
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
    const spec = result.service.spec as any;
    expect(spec.clusterIP).toBe("None");
  });

  test("includes volumeClaimTemplates", () => {
    const result = StatefulApp({
      name: "db",
      image: "postgres:16",
      storageSize: "20Gi",
    });
    const spec = result.statefulSet.spec as any;
    expect(spec.volumeClaimTemplates).toBeDefined();
    expect(spec.volumeClaimTemplates[0].spec.resources.requests.storage).toBe(
      "20Gi",
    );
  });

  test("default port is 5432", () => {
    const result = StatefulApp({ name: "db", image: "postgres:16" });
    const spec = result.statefulSet.spec as any;
    const container = spec.template.spec.containers[0];
    expect(container.ports[0].containerPort).toBe(5432);
  });

  test("default replicas is 1", () => {
    const result = StatefulApp({ name: "db", image: "postgres:16" });
    const spec = result.statefulSet.spec as any;
    expect(spec.replicas).toBe(1);
  });

  test("serviceName matches name", () => {
    const result = StatefulApp({ name: "db", image: "postgres:16" });
    const spec = result.statefulSet.spec as any;
    expect(spec.serviceName).toBe("db");
  });

  test("storageClassName set when provided", () => {
    const result = StatefulApp({
      name: "db",
      image: "postgres:16",
      storageClassName: "ssd",
    });
    const spec = result.statefulSet.spec as any;
    expect(spec.volumeClaimTemplates[0].spec.storageClassName).toBe("ssd");
  });

  test("component labels on each resource", () => {
    const result = StatefulApp({ name: "db", image: "postgres:16" });
    expect((result.statefulSet.metadata as any).labels["app.kubernetes.io/component"]).toBe("database");
    expect((result.service.metadata as any).labels["app.kubernetes.io/component"]).toBe("database");
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
    const spec = result.cronJob.spec as any;
    expect(spec.schedule).toBe("0 2 * * *");
  });

  test("RBAC references correct ServiceAccount", () => {
    const result = CronWorkload({
      name: "backup",
      image: "backup:1.0",
      schedule: "0 2 * * *",
    });
    const binding = result.roleBinding as any;
    expect(binding.subjects[0].name).toBe("backup-sa");
    expect(binding.roleRef.name).toBe("backup-role");
  });

  test("serviceAccount name follows naming convention", () => {
    const result = CronWorkload({
      name: "cleanup",
      image: "cleanup:1.0",
      schedule: "*/5 * * * *",
    });
    const meta = result.serviceAccount.metadata as any;
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
    const role = result.role as any;
    expect(role.rules[0].resources).toEqual(["secrets"]);
    expect(role.rules[0].verbs).toEqual(["get"]);
  });

  test("default RBAC rules when none provided", () => {
    const result = CronWorkload({
      name: "backup",
      image: "backup:1.0",
      schedule: "0 2 * * *",
    });
    const role = result.role as any;
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
    const spec = result.cronJob.spec as any;
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
    const spec = result.cronJob.spec as any;
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
      const meta = resource.metadata as any;
      expect(meta.labels["app.kubernetes.io/name"]).toBe("backup");
    }
  });

  test("component labels on each resource", () => {
    const result = CronWorkload({
      name: "backup",
      image: "backup:1.0",
      schedule: "0 2 * * *",
    });
    expect((result.cronJob.metadata as any).labels["app.kubernetes.io/component"]).toBe("worker");
    expect((result.serviceAccount.metadata as any).labels["app.kubernetes.io/component"]).toBe("worker");
    expect((result.role.metadata as any).labels["app.kubernetes.io/component"]).toBe("rbac");
    expect((result.roleBinding.metadata as any).labels["app.kubernetes.io/component"]).toBe("rbac");
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
    const spec = result.deployment.spec as any;
    const container = spec.template.spec.containers[0];
    expect(container.ports[0].containerPort).toBe(80);
  });

  test("default minReplicas is 2", () => {
    const result = AutoscaledService(minProps);
    const spec = result.deployment.spec as any;
    expect(spec.replicas).toBe(2);
    const hpaSpec = result.hpa.spec as any;
    expect(hpaSpec.minReplicas).toBe(2);
  });

  test("HPA scaleTargetRef references the deployment", () => {
    const result = AutoscaledService(minProps);
    const hpaSpec = result.hpa.spec as any;
    expect(hpaSpec.scaleTargetRef.kind).toBe("Deployment");
    expect(hpaSpec.scaleTargetRef.name).toBe("api");
  });

  test("HPA has CPU metric with default 70%", () => {
    const result = AutoscaledService(minProps);
    const hpaSpec = result.hpa.spec as any;
    expect(hpaSpec.metrics[0].resource.name).toBe("cpu");
    expect(hpaSpec.metrics[0].resource.target.averageUtilization).toBe(70);
  });

  test("HPA includes memory metric when targetMemoryPercent set", () => {
    const result = AutoscaledService({ ...minProps, targetMemoryPercent: 80 });
    const hpaSpec = result.hpa.spec as any;
    expect(hpaSpec.metrics).toHaveLength(2);
    expect(hpaSpec.metrics[1].resource.name).toBe("memory");
    expect(hpaSpec.metrics[1].resource.target.averageUtilization).toBe(80);
  });

  test("no memory metric by default", () => {
    const result = AutoscaledService(minProps);
    const hpaSpec = result.hpa.spec as any;
    expect(hpaSpec.metrics).toHaveLength(1);
  });

  test("PDB selector matches deployment pod labels", () => {
    const result = AutoscaledService(minProps);
    const pdbSpec = result.pdb.spec as any;
    expect(pdbSpec.selector.matchLabels["app.kubernetes.io/name"]).toBe("api");
    expect(pdbSpec.minAvailable).toBe(1);
  });

  test("resource requests are always set", () => {
    const result = AutoscaledService(minProps);
    const spec = result.deployment.spec as any;
    const container = spec.template.spec.containers[0];
    expect(container.resources.requests.cpu).toBe("100m");
    expect(container.resources.requests.memory).toBe("128Mi");
  });

  test("resource limits only set when provided", () => {
    const result = AutoscaledService(minProps);
    const spec = result.deployment.spec as any;
    const container = spec.template.spec.containers[0];
    expect(container.resources.limits).toBeUndefined();

    const withLimits = AutoscaledService({ ...minProps, cpuLimit: "1", memoryLimit: "512Mi" });
    const spec2 = withLimits.deployment.spec as any;
    const container2 = spec2.template.spec.containers[0];
    expect(container2.resources.limits.cpu).toBe("1");
    expect(container2.resources.limits.memory).toBe("512Mi");
  });

  test("includes health probes", () => {
    const result = AutoscaledService(minProps);
    const spec = result.deployment.spec as any;
    const container = spec.template.spec.containers[0];
    expect(container.livenessProbe).toBeDefined();
    expect(container.readinessProbe).toBeDefined();
  });

  test("service type is ClusterIP", () => {
    const result = AutoscaledService(minProps);
    const spec = result.service.spec as any;
    expect(spec.type).toBe("ClusterIP");
  });

  test("includes common labels on all resources", () => {
    const result = AutoscaledService(minProps);
    for (const resource of [result.deployment, result.service, result.hpa, result.pdb]) {
      const meta = resource.metadata as any;
      expect(meta.labels["app.kubernetes.io/name"]).toBe("api");
      expect(meta.labels["app.kubernetes.io/managed-by"]).toBe("chant");
    }
  });

  test("namespace propagated to all resources", () => {
    const result = AutoscaledService({ ...minProps, namespace: "prod" });
    for (const resource of [result.deployment, result.service, result.hpa, result.pdb]) {
      const meta = resource.metadata as any;
      expect(meta.namespace).toBe("prod");
    }
  });

  test("env vars passed to container", () => {
    const result = AutoscaledService({
      ...minProps,
      env: [{ name: "LOG_LEVEL", value: "debug" }],
    });
    const spec = result.deployment.spec as any;
    const container = spec.template.spec.containers[0];
    expect(container.env).toEqual([{ name: "LOG_LEVEL", value: "debug" }]);
  });

  test("component labels on each resource", () => {
    const result = AutoscaledService(minProps);
    expect((result.deployment.metadata as any).labels["app.kubernetes.io/component"]).toBe("server");
    expect((result.service.metadata as any).labels["app.kubernetes.io/component"]).toBe("server");
    expect((result.hpa.metadata as any).labels["app.kubernetes.io/component"]).toBe("autoscaler");
    expect((result.pdb.metadata as any).labels["app.kubernetes.io/component"]).toBe("disruption-budget");
  });

  test("default probe paths are /healthz and /readyz", () => {
    const result = AutoscaledService(minProps);
    const spec = result.deployment.spec as any;
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
    const spec = result.deployment.spec as any;
    const container = spec.template.spec.containers[0];
    expect(container.livenessProbe.httpGet.path).toBe("/alive");
    expect(container.readinessProbe.httpGet.path).toBe("/ready");
  });

  test("probe targets container port", () => {
    const result = AutoscaledService({ ...minProps, port: 8080 });
    const spec = result.deployment.spec as any;
    const container = spec.template.spec.containers[0];
    expect(container.livenessProbe.httpGet.port).toBe(8080);
    expect(container.readinessProbe.httpGet.port).toBe(8080);
  });

  test("topologySpread not present by default", () => {
    const result = AutoscaledService(minProps);
    const spec = result.deployment.spec as any;
    expect(spec.template.spec.topologySpreadConstraints).toBeUndefined();
  });

  test("topologySpread: true adds zone constraint", () => {
    const result = AutoscaledService({ ...minProps, topologySpread: true });
    const spec = result.deployment.spec as any;
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
    const spec = result.deployment.spec as any;
    const tsc = spec.template.spec.topologySpreadConstraints;
    expect(tsc[0].maxSkew).toBe(2);
    expect(tsc[0].topologyKey).toBe("kubernetes.io/hostname");
  });

  test("minAvailable as string percentage", () => {
    const result = AutoscaledService({ ...minProps, minAvailable: "50%" });
    const pdbSpec = result.pdb.spec as any;
    expect(pdbSpec.minAvailable).toBe("50%");
  });

  test("custom targetCPUPercent", () => {
    const result = AutoscaledService({ ...minProps, targetCPUPercent: 85 });
    const hpaSpec = result.hpa.spec as any;
    expect(hpaSpec.metrics[0].resource.target.averageUtilization).toBe(85);
  });

  test("pod template labels include extra labels", () => {
    const result = AutoscaledService({ ...minProps, labels: { team: "platform" } });
    const spec = result.deployment.spec as any;
    const podLabels = spec.template.metadata.labels;
    expect(podLabels.team).toBe("platform");
    expect(podLabels["app.kubernetes.io/name"]).toBe("api");
  });

  test("serviceAccountName wired into pod spec", () => {
    const result = AutoscaledService({ ...minProps, serviceAccountName: "my-sa" });
    const spec = result.deployment.spec as any;
    expect(spec.template.spec.serviceAccountName).toBe("my-sa");
  });

  test("no serviceAccountName by default", () => {
    const result = AutoscaledService(minProps);
    const spec = result.deployment.spec as any;
    expect(spec.template.spec.serviceAccountName).toBeUndefined();
  });

  test("volumes and volumeMounts wired into pod spec", () => {
    const result = AutoscaledService({
      ...minProps,
      volumes: [{ name: "data", emptyDir: {} }],
      volumeMounts: [{ name: "data", mountPath: "/data" }],
    });
    const spec = result.deployment.spec as any;
    expect(spec.template.spec.volumes).toEqual([{ name: "data", emptyDir: {} }]);
    expect(spec.template.spec.containers[0].volumeMounts).toEqual([{ name: "data", mountPath: "/data" }]);
  });

  test("tmpDirs generates emptyDir volumes and mounts", () => {
    const result = AutoscaledService({
      ...minProps,
      tmpDirs: ["/tmp", "/var/cache/nginx"],
    });
    const spec = result.deployment.spec as any;
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
    const spec = result.deployment.spec as any;
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
    const spec = result.deployment.spec as any;
    expect(spec.replicas).toBe(1);
  });

  test("RBAC naming convention", () => {
    const result = WorkerPool(minProps);
    const saMeta = result.serviceAccount!.metadata as any;
    const roleMeta = result.role!.metadata as any;
    const bindingMeta = result.roleBinding!.metadata as any;
    expect(saMeta.name).toBe("worker-sa");
    expect(roleMeta.name).toBe("worker-role");
    expect(bindingMeta.name).toBe("worker-binding");
  });

  test("default RBAC rules for secrets and configmaps", () => {
    const result = WorkerPool(minProps);
    const role = result.role! as any;
    expect(role.rules[0].resources).toEqual(["secrets", "configmaps"]);
    expect(role.rules[0].verbs).toEqual(["get"]);
  });

  test("custom RBAC rules are used", () => {
    const result = WorkerPool({
      ...minProps,
      rbacRules: [{ apiGroups: ["batch"], resources: ["jobs"], verbs: ["create"] }],
    });
    const role = result.role! as any;
    expect(role.rules[0].resources).toEqual(["jobs"]);
  });

  test("command and args passed through", () => {
    const result = WorkerPool({
      ...minProps,
      command: ["bundle", "exec", "sidekiq"],
      args: ["-c", "5"],
    });
    const spec = result.deployment.spec as any;
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
    const data = (result.configMap as any).data;
    expect(data.REDIS_URL).toBe("redis://redis:6379");

    const spec = result.deployment.spec as any;
    const container = spec.template.spec.containers[0];
    expect(container.envFrom[0].configMapRef.name).toBe("worker-config");
  });

  test("autoscaling creates HPA and overrides replicas", () => {
    const result = WorkerPool({
      ...minProps,
      autoscaling: { minReplicas: 2, maxReplicas: 8, targetCPUPercent: 60 },
    });
    expect(result.hpa).toBeDefined();
    const hpaSpec = (result.hpa as any).spec;
    expect(hpaSpec.minReplicas).toBe(2);
    expect(hpaSpec.maxReplicas).toBe(8);
    expect(hpaSpec.scaleTargetRef.name).toBe("worker");

    const spec = result.deployment.spec as any;
    expect(spec.replicas).toBe(2);
  });

  test("default resource limits", () => {
    const result = WorkerPool(minProps);
    const spec = result.deployment.spec as any;
    const container = spec.template.spec.containers[0];
    expect(container.resources.requests.cpu).toBe("100m");
    expect(container.resources.requests.memory).toBe("128Mi");
    expect(container.resources.limits.cpu).toBe("500m");
    expect(container.resources.limits.memory).toBe("256Mi");
  });

  test("serviceAccountName on pod spec", () => {
    const result = WorkerPool(minProps);
    const spec = result.deployment.spec as any;
    expect(spec.template.spec.serviceAccountName).toBe("worker-sa");
  });

  test("includes common labels on all resources", () => {
    const result = WorkerPool(minProps);
    for (const resource of [result.deployment, result.serviceAccount!, result.role!, result.roleBinding!]) {
      const meta = resource.metadata as any;
      expect(meta.labels["app.kubernetes.io/name"]).toBe("worker");
      expect(meta.labels["app.kubernetes.io/managed-by"]).toBe("chant");
    }
  });

  test("namespace propagated", () => {
    const result = WorkerPool({ ...minProps, namespace: "jobs" });
    for (const resource of [result.deployment, result.serviceAccount!, result.role!, result.roleBinding!]) {
      const meta = resource.metadata as any;
      expect(meta.namespace).toBe("jobs");
    }
  });

  test("rbacRules: [] produces no RBAC resources", () => {
    const result = WorkerPool({ ...minProps, rbacRules: [] });
    expect(result.serviceAccount).toBeUndefined();
    expect(result.role).toBeUndefined();
    expect(result.roleBinding).toBeUndefined();
    const spec = result.deployment.spec as any;
    expect(spec.template.spec.serviceAccountName).toBeUndefined();
  });

  test("rbacRules undefined produces default RBAC", () => {
    const result = WorkerPool(minProps);
    expect(result.serviceAccount).toBeDefined();
    expect(result.role).toBeDefined();
    expect(result.roleBinding).toBeDefined();
    const role = result.role as any;
    expect(role.rules[0].resources).toEqual(["secrets", "configmaps"]);
  });

  test("env vars on container", () => {
    const result = WorkerPool({
      ...minProps,
      env: [{ name: "LOG_LEVEL", value: "debug" }],
    });
    const spec = result.deployment.spec as any;
    const container = spec.template.spec.containers[0];
    expect(container.env).toEqual([{ name: "LOG_LEVEL", value: "debug" }]);
  });

  test("ConfigMap carries namespace and labels", () => {
    const result = WorkerPool({
      ...minProps,
      config: { KEY: "val" },
      namespace: "jobs",
    });
    const meta = (result.configMap as any).metadata;
    expect(meta.namespace).toBe("jobs");
    expect(meta.labels["app.kubernetes.io/name"]).toBe("worker");
  });

  test("HPA carries namespace", () => {
    const result = WorkerPool({
      ...minProps,
      autoscaling: { minReplicas: 1, maxReplicas: 5 },
      namespace: "jobs",
    });
    const meta = (result.hpa as any).metadata;
    expect(meta.namespace).toBe("jobs");
  });

  test("autoscaling default targetCPUPercent is 70", () => {
    const result = WorkerPool({
      ...minProps,
      autoscaling: { minReplicas: 1, maxReplicas: 5 },
    });
    const hpaSpec = (result.hpa as any).spec;
    expect(hpaSpec.metrics[0].resource.target.averageUtilization).toBe(70);
  });

  test("component labels on each resource", () => {
    const result = WorkerPool({
      ...minProps,
      config: { K: "V" },
      autoscaling: { minReplicas: 1, maxReplicas: 5 },
    });
    expect((result.deployment.metadata as any).labels["app.kubernetes.io/component"]).toBe("worker");
    expect((result.serviceAccount!.metadata as any).labels["app.kubernetes.io/component"]).toBe("worker");
    expect((result.role!.metadata as any).labels["app.kubernetes.io/component"]).toBe("rbac");
    expect((result.roleBinding!.metadata as any).labels["app.kubernetes.io/component"]).toBe("rbac");
    expect((result.configMap!.metadata as any).labels["app.kubernetes.io/component"]).toBe("config");
    expect((result.hpa!.metadata as any).labels["app.kubernetes.io/component"]).toBe("autoscaler");
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
    const spec = result.networkPolicy!.spec as any;
    expect(spec.policyTypes).toEqual(["Ingress"]);
    expect(spec.podSelector).toEqual({});
  });

  test("egress deny when enabled", () => {
    const result = NamespaceEnv({
      name: "team-alpha",
      defaultDenyEgress: true,
    });
    const spec = result.networkPolicy!.spec as any;
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
    const spec = result.resourceQuota!.spec as any;
    expect(spec.hard["limits.cpu"]).toBe("8");
    expect(spec.hard["limits.memory"]).toBe("16Gi");
    expect(spec.hard.pods).toBe("50");
  });

  test("ResourceQuota in correct namespace", () => {
    const result = NamespaceEnv({ name: "team-alpha", cpuQuota: "4" });
    const meta = result.resourceQuota!.metadata as any;
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
    const spec = result.limitRange!.spec as any;
    const limit = spec.limits[0];
    expect(limit.type).toBe("Container");
    expect(limit.default.cpu).toBe("500m");
    expect(limit.default.memory).toBe("512Mi");
    expect(limit.defaultRequest.cpu).toBe("100m");
    expect(limit.defaultRequest.memory).toBe("128Mi");
  });

  test("LimitRange in correct namespace", () => {
    const result = NamespaceEnv({ name: "team-alpha", defaultCpuLimit: "1" });
    const meta = result.limitRange!.metadata as any;
    expect(meta.namespace).toBe("team-alpha");
    expect(meta.name).toBe("team-alpha-limits");
  });

  test("includes common labels", () => {
    const result = NamespaceEnv({ name: "team-alpha" });
    const meta = result.namespace.metadata as any;
    expect(meta.labels["app.kubernetes.io/name"]).toBe("team-alpha");
    expect(meta.labels["app.kubernetes.io/managed-by"]).toBe("chant");
  });

  test("namespace resource has no namespace field (cluster-scoped)", () => {
    const result = NamespaceEnv({ name: "team-alpha" });
    const meta = result.namespace.metadata as any;
    expect(meta.namespace).toBeUndefined();
  });

  test("warns when quota set without limits", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    NamespaceEnv({ name: "warn-test", cpuQuota: "4", defaultDenyIngress: false });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("ResourceQuota set but no LimitRange defaults"),
    );
    warnSpy.mockRestore();
  });

  test("no warning when both quota and limits set", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
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
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
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
    const spec = result.networkPolicy!.spec as any;
    expect(spec.policyTypes).toEqual(["Egress"]);
  });

  test("NetworkPolicy namespace is the namespace name", () => {
    const result = NamespaceEnv({ name: "team-beta", defaultDenyIngress: true });
    const meta = result.networkPolicy!.metadata as any;
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
      const meta = resource.metadata as any;
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
    expect((result.namespace.metadata as any).labels["app.kubernetes.io/component"]).toBe("namespace");
    expect((result.resourceQuota!.metadata as any).labels["app.kubernetes.io/component"]).toBe("quota");
    expect((result.limitRange!.metadata as any).labels["app.kubernetes.io/component"]).toBe("limits");
    expect((result.networkPolicy!.metadata as any).labels["app.kubernetes.io/component"]).toBe("network-policy");
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
    const binding = result.clusterRoleBinding as any;
    expect(binding.roleRef.kind).toBe("ClusterRole");
    expect(binding.roleRef.apiGroup).toBe("rbac.authorization.k8s.io");
  });

  test("ClusterRole/ClusterRoleBinding are cluster-scoped (no namespace)", () => {
    const result = NodeAgent({ ...minProps, namespace: "monitoring" });
    const crMeta = result.clusterRole.metadata as any;
    const crbMeta = result.clusterRoleBinding.metadata as any;
    expect(crMeta.namespace).toBeUndefined();
    expect(crbMeta.namespace).toBeUndefined();
  });

  test("namespaced resources get namespace", () => {
    const result = NodeAgent({ ...minProps, namespace: "monitoring" });
    const dsMeta = result.daemonSet.metadata as any;
    const saMeta = result.serviceAccount.metadata as any;
    expect(dsMeta.namespace).toBe("monitoring");
    expect(saMeta.namespace).toBe("monitoring");
  });

  test("tolerateAllTaints adds Exists toleration by default", () => {
    const result = NodeAgent(minProps);
    const spec = result.daemonSet.spec as any;
    const tolerations = spec.template.spec.tolerations;
    expect(tolerations).toEqual([{ operator: "Exists" }]);
  });

  test("tolerateAllTaints can be disabled", () => {
    const result = NodeAgent({ ...minProps, tolerateAllTaints: false });
    const spec = result.daemonSet.spec as any;
    expect(spec.template.spec.tolerations).toBeUndefined();
  });

  test("hostPaths mounted with readOnly true by default", () => {
    const result = NodeAgent({
      ...minProps,
      hostPaths: [{ name: "varlog", hostPath: "/var/log", mountPath: "/var/log" }],
    });
    const spec = result.daemonSet.spec as any;
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
    const spec = result.daemonSet.spec as any;
    const mounts = spec.template.spec.containers[0].volumeMounts;
    expect(mounts[0].readOnly).toBe(false);
  });

  test("config creates ConfigMap mounted at /etc/{name}/", () => {
    const result = NodeAgent({
      ...minProps,
      config: { "fluent.conf": "some config" },
    });
    expect(result.configMap).toBeDefined();
    const data = (result.configMap as any).data;
    expect(data["fluent.conf"]).toBe("some config");

    const spec = result.daemonSet.spec as any;
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
    const spec = result.daemonSet.spec as any;
    const container = spec.template.spec.containers[0];
    expect(container.ports[0].containerPort).toBe(9100);
    expect(container.ports[0].name).toBe("metrics");
  });

  test("RBAC naming convention", () => {
    const result = NodeAgent(minProps);
    const saMeta = result.serviceAccount.metadata as any;
    const crMeta = result.clusterRole.metadata as any;
    const crbMeta = result.clusterRoleBinding.metadata as any;
    expect(saMeta.name).toBe("log-agent-sa");
    expect(crMeta.name).toBe("log-agent-role");
    expect(crbMeta.name).toBe("log-agent-binding");
  });

  test("RBAC rules passed through to ClusterRole", () => {
    const result = NodeAgent(minProps);
    const cr = result.clusterRole as any;
    expect(cr.rules[0].resources).toEqual(["pods", "namespaces"]);
  });

  test("includes common labels on all resources", () => {
    const result = NodeAgent(minProps);
    for (const resource of [result.daemonSet, result.serviceAccount, result.clusterRole, result.clusterRoleBinding]) {
      const meta = resource.metadata as any;
      expect(meta.labels["app.kubernetes.io/name"]).toBe("log-agent");
      expect(meta.labels["app.kubernetes.io/managed-by"]).toBe("chant");
    }
  });

  test("env vars passed to container", () => {
    const result = NodeAgent({
      ...minProps,
      env: [{ name: "LOG_LEVEL", value: "info" }],
    });
    const spec = result.daemonSet.spec as any;
    const container = spec.template.spec.containers[0];
    expect(container.env).toEqual([{ name: "LOG_LEVEL", value: "info" }]);
  });

  test("serviceAccountName on pod spec", () => {
    const result = NodeAgent(minProps);
    const spec = result.daemonSet.spec as any;
    expect(spec.template.spec.serviceAccountName).toBe("log-agent-sa");
  });

  test("default resource requests and limits on container", () => {
    const result = NodeAgent(minProps);
    const spec = result.daemonSet.spec as any;
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
    const spec = result.daemonSet.spec as any;
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
    const spec = result.daemonSet.spec as any;
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
    const meta = (result.configMap as any).metadata;
    expect(meta.namespace).toBe("monitoring");
  });

  test("component labels on each resource", () => {
    const result = NodeAgent({
      ...minProps,
      config: { key: "val" },
    });
    expect((result.daemonSet.metadata as any).labels["app.kubernetes.io/component"]).toBe("agent");
    expect((result.serviceAccount.metadata as any).labels["app.kubernetes.io/component"]).toBe("agent");
    expect((result.clusterRole.metadata as any).labels["app.kubernetes.io/component"]).toBe("rbac");
    expect((result.clusterRoleBinding.metadata as any).labels["app.kubernetes.io/component"]).toBe("rbac");
    expect((result.configMap!.metadata as any).labels["app.kubernetes.io/component"]).toBe("config");
  });
});

// ── Hardening Additions ─────────────────────────────────────────────

describe("WebApp hardening", () => {
  test("PDB created when minAvailable set", () => {
    const result = WebApp({ name: "app", image: "app:1.0", minAvailable: 1 });
    expect(result.pdb).toBeDefined();
    const spec = result.pdb!.spec as any;
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
    const spec = result.deployment.spec as any;
    expect(spec.template.spec.initContainers).toHaveLength(1);
    expect(spec.template.spec.initContainers[0].name).toBe("migrate");
  });

  test("securityContext passed through", () => {
    const result = WebApp({
      name: "app",
      image: "app:1.0",
      securityContext: { runAsNonRoot: true, readOnlyRootFilesystem: true },
    });
    const spec = result.deployment.spec as any;
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
    const spec = result.deployment.spec as any;
    const sc = spec.template.spec.containers[0].securityContext;
    expect(sc.allowPrivilegeEscalation).toBe(false);
    expect(sc.capabilities).toEqual({ drop: ["ALL"] });
    expect(sc.seccompProfile).toEqual({ type: "RuntimeDefault" });
  });

  test("terminationGracePeriodSeconds set", () => {
    const result = WebApp({ name: "app", image: "app:1.0", terminationGracePeriodSeconds: 60 });
    const spec = result.deployment.spec as any;
    expect(spec.template.spec.terminationGracePeriodSeconds).toBe(60);
  });

  test("priorityClassName set", () => {
    const result = WebApp({ name: "app", image: "app:1.0", priorityClassName: "high-priority" });
    const spec = result.deployment.spec as any;
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
    const spec = result.ingress!.spec as any;
    expect(spec.rules[0].http.paths).toHaveLength(2);
    expect(spec.rules[0].http.paths[0].path).toBe("/api");
    expect(spec.rules[0].http.paths[1].backend.service.name).toBe("web");
  });
});

describe("StatefulApp hardening", () => {
  test("PDB created when minAvailable set", () => {
    const result = StatefulApp({ name: "db", image: "postgres:16", minAvailable: 1 });
    expect(result.pdb).toBeDefined();
    const spec = result.pdb!.spec as any;
    expect(spec.minAvailable).toBe(1);
  });

  test("initContainers passed through", () => {
    const result = StatefulApp({
      name: "db",
      image: "postgres:16",
      initContainers: [{ name: "init", image: "init:1.0" }],
    });
    const spec = result.statefulSet.spec as any;
    expect(spec.template.spec.initContainers).toHaveLength(1);
  });

  test("securityContext passed through", () => {
    const result = StatefulApp({
      name: "db",
      image: "postgres:16",
      securityContext: { runAsNonRoot: true },
    });
    const spec = result.statefulSet.spec as any;
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
    const spec = result.statefulSet.spec as any;
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
    const spec = result.pdb!.spec as any;
    expect(spec.minAvailable).toBe(1);
  });

  test("securityContext on container", () => {
    const result = WorkerPool({
      name: "w",
      image: "w:1.0",
      securityContext: { runAsNonRoot: true },
    });
    const spec = result.deployment.spec as any;
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
    const spec = result.deployment.spec as any;
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
    const spec = result.deployment.spec as any;
    expect(spec.template.spec.initContainers).toHaveLength(1);
  });

  test("securityContext on container", () => {
    const result = AutoscaledService({
      ...minProps,
      securityContext: { runAsNonRoot: true },
    });
    const spec = result.deployment.spec as any;
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
    const spec = result.deployment.spec as any;
    const sc = spec.template.spec.containers[0].securityContext;
    expect(sc.allowPrivilegeEscalation).toBe(false);
    expect(sc.capabilities).toEqual({ drop: ["ALL"] });
    expect(sc.seccompProfile).toEqual({ type: "RuntimeDefault" });
  });

  test("terminationGracePeriodSeconds set", () => {
    const result = AutoscaledService({ ...minProps, terminationGracePeriodSeconds: 30 });
    const spec = result.deployment.spec as any;
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
    const spec = result.job.spec as any;
    expect(spec.backoffLimit).toBe(6);
  });

  test("custom backoffLimit and ttl", () => {
    const result = BatchJob({ ...minProps, backoffLimit: 3, ttlSecondsAfterFinished: 3600 });
    const spec = result.job.spec as any;
    expect(spec.backoffLimit).toBe(3);
    expect(spec.ttlSecondsAfterFinished).toBe(3600);
  });

  test("parallelism and completions", () => {
    const result = BatchJob({ ...minProps, parallelism: 3, completions: 10 });
    const spec = result.job.spec as any;
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
    const spec = result.job.spec as any;
    const container = spec.template.spec.containers[0];
    expect(container.command).toEqual(["python"]);
    expect(container.args).toEqual(["migrate.py"]);
  });

  test("namespace propagated", () => {
    const result = BatchJob({ ...minProps, namespace: "jobs" });
    expect((result.job.metadata as any).namespace).toBe("jobs");
    expect((result.serviceAccount!.metadata as any).namespace).toBe("jobs");
  });

  test("component labels", () => {
    const result = BatchJob(minProps);
    expect((result.job.metadata as any).labels["app.kubernetes.io/component"]).toBe("batch");
    expect((result.role!.metadata as any).labels["app.kubernetes.io/component"]).toBe("rbac");
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
    const certSpec = result.certificate!.spec as any;
    expect(certSpec.issuerRef.name).toBe("letsencrypt-prod");
    expect(certSpec.dnsNames).toEqual(["app.example.com"]);
  });

  test("TLS on ingress when clusterIssuer set", () => {
    const result = SecureIngress({ ...minProps, clusterIssuer: "letsencrypt-prod" });
    const spec = result.ingress.spec as any;
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
    const spec = result.ingress.spec as any;
    expect(spec.rules).toHaveLength(2);
    const certSpec = result.certificate!.spec as any;
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
    const spec = result.ingress.spec as any;
    expect(spec.rules[0].http.paths).toHaveLength(2);
  });

  test("ingressClassName set", () => {
    const result = SecureIngress({ ...minProps, ingressClassName: "nginx" });
    const spec = result.ingress.spec as any;
    expect(spec.ingressClassName).toBe("nginx");
  });

  test("cert-manager annotation added", () => {
    const result = SecureIngress({ ...minProps, clusterIssuer: "letsencrypt-prod" });
    const meta = result.ingress.metadata as any;
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
    expect((result.configMap as any).data["app.conf"]).toBe("key=val");
  });

  test("configMap volume mounted", () => {
    const result = ConfiguredApp({ ...minProps, configData: { "k": "v" }, configMountPath: "/etc/app" });
    const spec = result.deployment.spec as any;
    const container = spec.template.spec.containers[0];
    expect(container.volumeMounts).toHaveLength(1);
    expect(container.volumeMounts[0].mountPath).toBe("/etc/app");
    expect(spec.template.spec.volumes[0].configMap.name).toBe("api-config");
  });

  test("secret volume mounted", () => {
    const result = ConfiguredApp({ ...minProps, secretName: "creds", secretMountPath: "/secrets" });
    const spec = result.deployment.spec as any;
    const container = spec.template.spec.containers[0];
    expect(container.volumeMounts[0].mountPath).toBe("/secrets");
    expect(spec.template.spec.volumes[0].secret.secretName).toBe("creds");
  });

  test("envFrom with configMapRef and secretRef", () => {
    const result = ConfiguredApp({
      ...minProps,
      envFrom: { configMapRef: "my-config", secretRef: "my-secret" },
    });
    const spec = result.deployment.spec as any;
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
    const spec = result.deployment.spec as any;
    expect(spec.template.spec.initContainers).toHaveLength(1);
  });

  test("namespace propagated", () => {
    const result = ConfiguredApp({ ...minProps, namespace: "prod" });
    expect((result.deployment.metadata as any).namespace).toBe("prod");
    expect((result.service.metadata as any).namespace).toBe("prod");
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
    const spec = result.deployment.spec as any;
    expect(spec.template.spec.containers).toHaveLength(2);
    expect(spec.template.spec.containers[0].name).toBe("api");
    expect(spec.template.spec.containers[1].name).toBe("envoy");
  });

  test("sidecar ports passed through", () => {
    const result = SidecarApp({
      ...minProps,
      sidecars: [{ name: "envoy", image: "envoy:v1.28", ports: [{ containerPort: 9901, name: "admin" }] }],
    });
    const spec = result.deployment.spec as any;
    expect(spec.template.spec.containers[1].ports[0].containerPort).toBe(9901);
  });

  test("initContainers supported", () => {
    const result = SidecarApp({
      ...minProps,
      initContainers: [{ name: "migrate", image: "m:1.0", command: ["./migrate.sh"] }],
    });
    const spec = result.deployment.spec as any;
    expect(spec.template.spec.initContainers).toHaveLength(1);
  });

  test("sharedVolumes creates volumes", () => {
    const result = SidecarApp({
      ...minProps,
      sharedVolumes: [{ name: "tmp" }, { name: "config", configMapName: "my-config" }],
    });
    const spec = result.deployment.spec as any;
    expect(spec.template.spec.volumes).toHaveLength(2);
    expect(spec.template.spec.volumes[0].emptyDir).toBeDefined();
    expect(spec.template.spec.volumes[1].configMap.name).toBe("my-config");
  });

  test("common labels on all resources", () => {
    const result = SidecarApp(minProps);
    expect((result.deployment.metadata as any).labels["app.kubernetes.io/managed-by"]).toBe("chant");
    expect((result.service.metadata as any).labels["app.kubernetes.io/managed-by"]).toBe("chant");
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
    const spec = result.prometheusRule!.spec as any;
    expect(spec.groups[0].rules[0].alert).toBe("HighError");
    expect(spec.groups[0].rules[0].labels.severity).toBe("critical");
  });

  test("serviceMonitor has correct selector and endpoint", () => {
    const result = MonitoredService({ ...minProps, metricsPort: 9090, metricsPath: "/metrics", scrapeInterval: "15s" });
    const spec = result.serviceMonitor.spec as any;
    expect(spec.selector.matchLabels["app.kubernetes.io/name"]).toBe("api");
    expect(spec.endpoints[0].port).toBe("metrics");
    expect(spec.endpoints[0].path).toBe("/metrics");
    expect(spec.endpoints[0].interval).toBe("15s");
  });

  test("separate metrics port on container and service", () => {
    const result = MonitoredService({ ...minProps, port: 8080, metricsPort: 9090 });
    const spec = result.deployment.spec as any;
    const ports = spec.template.spec.containers[0].ports;
    expect(ports).toHaveLength(2);
    expect(ports[0].containerPort).toBe(8080);
    expect(ports[1].containerPort).toBe(9090);
  });

  test("component labels", () => {
    const result = MonitoredService({ ...minProps, alertRules: [{ name: "A", expr: "1" }] });
    expect((result.serviceMonitor.metadata as any).labels["app.kubernetes.io/component"]).toBe("monitoring");
    expect((result.prometheusRule!.metadata as any).labels["app.kubernetes.io/component"]).toBe("monitoring");
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
    const spec = result.networkPolicy.spec as any;
    expect(spec.podSelector.matchLabels["app.kubernetes.io/name"]).toBe("api");
  });

  test("ingress rules created", () => {
    const result = NetworkIsolatedApp({
      ...minProps,
      allowIngressFrom: [{ podSelector: { "app.kubernetes.io/name": "frontend" } }],
    });
    const spec = result.networkPolicy.spec as any;
    expect(spec.policyTypes).toContain("Ingress");
    expect(spec.ingress[0].from[0].podSelector.matchLabels["app.kubernetes.io/name"]).toBe("frontend");
  });

  test("egress rules with ports", () => {
    const result = NetworkIsolatedApp({
      ...minProps,
      allowEgressTo: [{ podSelector: { "app.kubernetes.io/name": "db" }, ports: [{ port: 5432 }] }],
    });
    const spec = result.networkPolicy.spec as any;
    expect(spec.policyTypes).toContain("Egress");
    expect(spec.egress[0].ports[0].port).toBe(5432);
  });

  test("namespace propagated", () => {
    const result = NetworkIsolatedApp({ ...minProps, namespace: "prod" });
    expect((result.networkPolicy.metadata as any).namespace).toBe("prod");
  });

  test("component label on networkPolicy", () => {
    const result = NetworkIsolatedApp(minProps);
    expect((result.networkPolicy.metadata as any).labels["app.kubernetes.io/component"]).toBe("network-policy");
  });
});

// ── IrsaServiceAccount ──────────────────────────────────────────────

describe("IrsaServiceAccount", () => {
  const minProps = { name: "app-sa", iamRoleArn: "arn:aws:iam::123456789012:role/app-role" };

  test("returns serviceAccount with IRSA annotation", () => {
    const result = IrsaServiceAccount(minProps);
    expect(result.serviceAccount).toBeDefined();
    const meta = result.serviceAccount.metadata as any;
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
    const role = result.role as any;
    expect(role.rules[0].resources).toEqual(["secrets"]);
  });

  test("namespace propagated", () => {
    const result = IrsaServiceAccount({ ...minProps, namespace: "prod" });
    expect((result.serviceAccount.metadata as any).namespace).toBe("prod");
  });

  test("component labels", () => {
    const result = IrsaServiceAccount(minProps);
    expect((result.serviceAccount.metadata as any).labels["app.kubernetes.io/component"]).toBe("service-account");
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
    const meta = result.ingress.metadata as any;
    expect(meta.annotations["alb.ingress.kubernetes.io/scheme"]).toBe("internet-facing");
    expect(meta.annotations["alb.ingress.kubernetes.io/target-type"]).toBe("ip");
  });

  test("ingressClassName is alb", () => {
    const result = AlbIngress(minProps);
    const spec = result.ingress.spec as any;
    expect(spec.ingressClassName).toBe("alb");
  });

  test("certificate ARN sets TLS annotations", () => {
    const result = AlbIngress({ ...minProps, certificateArn: "arn:aws:acm:us-east-1:123:cert/abc" });
    const meta = result.ingress.metadata as any;
    expect(meta.annotations["alb.ingress.kubernetes.io/certificate-arn"]).toBe("arn:aws:acm:us-east-1:123:cert/abc");
    expect(meta.annotations["alb.ingress.kubernetes.io/ssl-redirect"]).toBe("443");
  });

  test("groupName annotation set", () => {
    const result = AlbIngress({ ...minProps, groupName: "shared-alb" });
    const meta = result.ingress.metadata as any;
    expect(meta.annotations["alb.ingress.kubernetes.io/group.name"]).toBe("shared-alb");
  });

  test("WAF ACL annotation set", () => {
    const result = AlbIngress({ ...minProps, wafAclArn: "arn:aws:wafv2:us-east-1:123:regional/webacl/abc" });
    const meta = result.ingress.metadata as any;
    expect(meta.annotations["alb.ingress.kubernetes.io/wafv2-acl-arn"]).toBe("arn:aws:wafv2:us-east-1:123:regional/webacl/abc");
  });

  test("internal scheme", () => {
    const result = AlbIngress({ ...minProps, scheme: "internal" });
    const meta = result.ingress.metadata as any;
    expect(meta.annotations["alb.ingress.kubernetes.io/scheme"]).toBe("internal");
  });

  test("empty-string certificateArn does NOT set ssl-redirect", () => {
    const result = AlbIngress({ ...minProps, certificateArn: "" });
    const meta = result.ingress.metadata as any;
    expect(meta.annotations["alb.ingress.kubernetes.io/ssl-redirect"]).toBeUndefined();
    expect(meta.annotations["alb.ingress.kubernetes.io/certificate-arn"]).toBeUndefined();
  });

  test("explicit sslRedirect: true overrides empty certificateArn", () => {
    const result = AlbIngress({ ...minProps, certificateArn: "", sslRedirect: true });
    const meta = result.ingress.metadata as any;
    expect(meta.annotations["alb.ingress.kubernetes.io/ssl-redirect"]).toBe("443");
  });

  test("explicit sslRedirect: false suppresses redirect even with cert", () => {
    const result = AlbIngress({ ...minProps, certificateArn: "arn:aws:acm:us-east-1:123:cert/abc", sslRedirect: false });
    const meta = result.ingress.metadata as any;
    expect(meta.annotations["alb.ingress.kubernetes.io/ssl-redirect"]).toBeUndefined();
  });
});

// ── EbsStorageClass ─────────────────────────────────────────────────

describe("EbsStorageClass", () => {
  test("returns storageClass with EBS provisioner", () => {
    const result = EbsStorageClass({ name: "gp3" });
    expect(result.storageClass).toBeDefined();
    expect((result.storageClass as any).provisioner).toBe("ebs.csi.aws.com");
  });

  test("default type is gp3", () => {
    const result = EbsStorageClass({ name: "default" });
    expect((result.storageClass as any).parameters.type).toBe("gp3");
  });

  test("encryption enabled by default", () => {
    const result = EbsStorageClass({ name: "enc" });
    expect((result.storageClass as any).parameters.encrypted).toBe("true");
  });

  test("custom parameters", () => {
    const result = EbsStorageClass({ name: "custom", type: "io2", iops: "5000", throughput: "250" });
    const params = (result.storageClass as any).parameters;
    expect(params.type).toBe("io2");
    expect(params.iops).toBe("5000");
    expect(params.throughput).toBe("250");
  });

  test("allowVolumeExpansion default true", () => {
    const result = EbsStorageClass({ name: "exp" });
    expect((result.storageClass as any).allowVolumeExpansion).toBe(true);
  });

  test("storageClass is cluster-scoped (no namespace)", () => {
    const result = EbsStorageClass({ name: "sc" });
    expect((result.storageClass.metadata as any).namespace).toBeUndefined();
  });

  test("numeric iops and throughput coerced to strings", () => {
    const result = EbsStorageClass({ name: "perf", iops: 5000, throughput: 250 });
    const params = (result.storageClass as any).parameters;
    expect(params.iops).toBe("5000");
    expect(params.throughput).toBe("250");
  });

  test("string iops and throughput passed through", () => {
    const result = EbsStorageClass({ name: "perf", iops: "3000", throughput: "125" });
    const params = (result.storageClass as any).parameters;
    expect(params.iops).toBe("3000");
    expect(params.throughput).toBe("125");
  });
});

// ── EfsStorageClass ─────────────────────────────────────────────────

describe("EfsStorageClass", () => {
  test("returns storageClass with EFS provisioner", () => {
    const result = EfsStorageClass({ name: "efs", fileSystemId: "fs-123" });
    expect((result.storageClass as any).provisioner).toBe("efs.csi.aws.com");
  });

  test("fileSystemId in parameters", () => {
    const result = EfsStorageClass({ name: "efs", fileSystemId: "fs-abc" });
    expect((result.storageClass as any).parameters.fileSystemId).toBe("fs-abc");
  });

  test("default provisioningMode is efs-ap", () => {
    const result = EfsStorageClass({ name: "efs", fileSystemId: "fs-123" });
    expect((result.storageClass as any).parameters.provisioningMode).toBe("efs-ap");
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
    expect((result.daemonSet.metadata as any).namespace).toBe("amazon-cloudwatch");
  });

  test("configMap contains fluent-bit config with region", () => {
    const result = FluentBitAgent(minProps);
    const data = (result.configMap as any).data;
    expect(data["fluent-bit.conf"]).toContain("us-east-1");
    expect(data["fluent-bit.conf"]).toContain("/aws/eks/cluster/containers");
  });

  test("tolerations for all nodes", () => {
    const result = FluentBitAgent(minProps);
    const spec = result.daemonSet.spec as any;
    expect(spec.template.spec.tolerations).toEqual([{ operator: "Exists" }]);
  });

  test("clusterRole is cluster-scoped", () => {
    const result = FluentBitAgent(minProps);
    expect((result.clusterRole.metadata as any).namespace).toBeUndefined();
  });

  test("IRSA annotation when iamRoleArn set", () => {
    const result = FluentBitAgent({ ...minProps, iamRoleArn: "arn:aws:iam::123456789012:role/fb-role" });
    const meta = result.serviceAccount.metadata as any;
    expect(meta.annotations["eks.amazonaws.com/role-arn"]).toBe("arn:aws:iam::123456789012:role/fb-role");
  });

  test("no annotation when iamRoleArn omitted", () => {
    const result = FluentBitAgent(minProps);
    const meta = result.serviceAccount.metadata as any;
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
    const meta = result.serviceAccount.metadata as any;
    expect(meta.annotations["eks.amazonaws.com/role-arn"]).toBe("arn:aws:iam::123456789012:role/external-dns");
  });

  test("domain filter in args", () => {
    const result = ExternalDnsAgent(minProps);
    const spec = result.deployment.spec as any;
    const args = spec.template.spec.containers[0].args;
    expect(args).toContain("--domain-filter=example.com");
  });

  test("txtOwnerId in args when set", () => {
    const result = ExternalDnsAgent({ ...minProps, txtOwnerId: "my-cluster" });
    const spec = result.deployment.spec as any;
    const args = spec.template.spec.containers[0].args;
    expect(args).toContain("--txt-owner-id=my-cluster");
  });

  test("default namespace is kube-system", () => {
    const result = ExternalDnsAgent(minProps);
    expect((result.deployment.metadata as any).namespace).toBe("kube-system");
  });

  test("replicas is 1", () => {
    const result = ExternalDnsAgent(minProps);
    const spec = result.deployment.spec as any;
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
    expect((result.daemonSet.metadata as any).namespace).toBe("amazon-metrics");
  });

  test("configMap contains ADOT config with region", () => {
    const result = AdotCollector(minProps);
    const data = (result.configMap as any).data;
    expect(data["config.yaml"]).toContain("us-east-1");
    expect(data["config.yaml"]).toContain("cluster");
  });

  test("OTLP ports on container", () => {
    const result = AdotCollector(minProps);
    const spec = result.daemonSet.spec as any;
    const ports = spec.template.spec.containers[0].ports;
    expect(ports).toHaveLength(2);
    expect(ports[0].containerPort).toBe(4317);
    expect(ports[1].containerPort).toBe(4318);
  });

  test("tolerations for all nodes", () => {
    const result = AdotCollector(minProps);
    const spec = result.daemonSet.spec as any;
    expect(spec.template.spec.tolerations).toEqual([{ operator: "Exists" }]);
  });

  test("custom exporters", () => {
    const result = AdotCollector({ ...minProps, exporters: ["prometheus"] });
    const data = (result.configMap as any).data;
    expect(data["config.yaml"]).toContain("prometheusremotewrite");
  });

  test("IRSA annotation when iamRoleArn set", () => {
    const result = AdotCollector({ ...minProps, iamRoleArn: "arn:aws:iam::123456789012:role/adot-role" });
    const meta = result.serviceAccount.metadata as any;
    expect(meta.annotations["eks.amazonaws.com/role-arn"]).toBe("arn:aws:iam::123456789012:role/adot-role");
  });

  test("no annotation when iamRoleArn omitted", () => {
    const result = AdotCollector(minProps);
    const meta = result.serviceAccount.metadata as any;
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
    expect((result.deployment.metadata as any).namespace).toBe("kube-system");
    expect((result.service.metadata as any).namespace).toBe("kube-system");
    expect((result.serviceAccount.metadata as any).namespace).toBe("kube-system");
  });

  test("service targets port 10250", () => {
    const result = MetricsServer({});
    const spec = result.service.spec as any;
    expect(spec.ports[0].port).toBe(443);
    expect(spec.ports[0].targetPort).toBe(10250);
  });

  test("deployment container has correct image and args", () => {
    const result = MetricsServer({});
    const spec = result.deployment.spec as any;
    const container = spec.template.spec.containers[0];
    expect(container.image).toBe("registry.k8s.io/metrics-server/metrics-server:v0.7.2");
    expect(container.args).toContain("--secure-port=10250");
    expect(container.args).toContain("--kubelet-use-node-status-port");
    expect(container.args).toContain("--metric-resolution=15s");
  });

  test("clusterRole has nodes/metrics access", () => {
    const result = MetricsServer({});
    const rules = result.clusterRole.rules as any[];
    const nodeMetricsRule = rules.find((r: any) => r.resources?.includes("nodes/metrics"));
    expect(nodeMetricsRule).toBeDefined();
  });

  test("apiService references correct service", () => {
    const result = MetricsServer({});
    const spec = (result.apiService as any).spec;
    expect(spec.service.name).toBe("metrics-server");
    expect(spec.service.namespace).toBe("kube-system");
    expect(spec.group).toBe("metrics.k8s.io");
    expect(spec.version).toBe("v1beta1");
  });

  test("aggregated clusterRole has aggregate labels", () => {
    const result = MetricsServer({});
    const labels = (result.aggregatedClusterRole.metadata as any).labels;
    expect(labels["rbac.authorization.k8s.io/aggregate-to-admin"]).toBe("true");
    expect(labels["rbac.authorization.k8s.io/aggregate-to-view"]).toBe("true");
  });

  test("custom image and replicas", () => {
    const result = MetricsServer({ image: "custom:v1", replicas: 2 });
    const spec = result.deployment.spec as any;
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
    const spec = result.job.spec as any;
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
    const spec = result.cronJob.spec as any;
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
    const spec = result.daemonSet.spec as any;
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
    const spec = result.deployment.spec as any;
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
    const spec = result.deployment.spec as any;
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
    const spec = result.deployment.spec as any;
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
    const spec = result.deployment.spec as any;
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
    const spec = result.deployment.spec as any;
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
    const spec = result.daemonSet.spec as any;
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
    const spec = result.daemonSet.spec as any;
    const sc = spec.template.spec.containers[0].securityContext;
    expect(sc.runAsNonRoot).toBe(true);
    expect(sc.runAsUser).toBe(10001);
    expect(sc.readOnlyRootFilesystem).toBe(true);
    expect(sc.allowPrivilegeEscalation).toBe(false);
  });
});

// ── Phase 3B: Composite serialization smoke tests ───────────────

describe("Composite YAML serialization smoke tests", () => {
  function serializeCompositeProps(props: Record<string, Record<string, unknown>>): string {
    return Object.values(props)
      .map((p) => emitYAML(p, 0))
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
    const rules = result.clusterRole.rules as any[];
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
    const spec = result.daemonSet.spec as any;
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
    const config = (result.configMap as any).data["config.yaml"] as string;
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
    const config = (result.configMap as any).data["config.yaml"] as string;
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
    const config = (result.configMap as any).data["config.yaml"] as string;
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
    const config = (result.configMap as any).data["config.yaml"] as string;
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
    const meta = result.serviceAccount.metadata as any;
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
    const role = result.role as any;
    expect(role.rules[0].resources).toEqual(["secrets"]);
  });

  test("namespace propagated", () => {
    const result = WorkloadIdentityServiceAccount({ ...minProps, namespace: "prod" });
    expect((result.serviceAccount.metadata as any).namespace).toBe("prod");
  });

  test("component labels", () => {
    const result = WorkloadIdentityServiceAccount(minProps);
    expect((result.serviceAccount.metadata as any).labels["app.kubernetes.io/component"]).toBe("service-account");
  });
});

// ── GcePdStorageClass ───────────────────────────────────────────────

describe("GcePdStorageClass", () => {
  test("returns storageClass with GCE PD provisioner", () => {
    const result = GcePdStorageClass({ name: "pd-balanced" });
    expect(result.storageClass).toBeDefined();
    expect((result.storageClass as any).provisioner).toBe("pd.csi.storage.gke.io");
  });

  test("default type is pd-balanced", () => {
    const result = GcePdStorageClass({ name: "default" });
    expect((result.storageClass as any).parameters.type).toBe("pd-balanced");
  });

  test("custom type", () => {
    const result = GcePdStorageClass({ name: "ssd", type: "pd-ssd" });
    expect((result.storageClass as any).parameters.type).toBe("pd-ssd");
  });

  test("regional-pd replication type", () => {
    const result = GcePdStorageClass({ name: "regional", replicationType: "regional-pd" });
    expect((result.storageClass as any).parameters["replication-type"]).toBe("regional-pd");
  });

  test("no replication-type param when none", () => {
    const result = GcePdStorageClass({ name: "default" });
    expect((result.storageClass as any).parameters["replication-type"]).toBeUndefined();
  });

  test("allowVolumeExpansion default true", () => {
    const result = GcePdStorageClass({ name: "exp" });
    expect((result.storageClass as any).allowVolumeExpansion).toBe(true);
  });

  test("storageClass is cluster-scoped (no namespace)", () => {
    const result = GcePdStorageClass({ name: "sc" });
    expect((result.storageClass.metadata as any).namespace).toBeUndefined();
  });
});

// ── FilestoreStorageClass ───────────────────────────────────────────

describe("FilestoreStorageClass", () => {
  test("returns storageClass with Filestore provisioner", () => {
    const result = FilestoreStorageClass({ name: "filestore" });
    expect((result.storageClass as any).provisioner).toBe("filestore.csi.storage.gke.io");
  });

  test("default tier is standard", () => {
    const result = FilestoreStorageClass({ name: "fs" });
    expect((result.storageClass as any).parameters.tier).toBe("standard");
  });

  test("custom tier", () => {
    const result = FilestoreStorageClass({ name: "premium-fs", tier: "premium" });
    expect((result.storageClass as any).parameters.tier).toBe("premium");
  });

  test("network parameter set when provided", () => {
    const result = FilestoreStorageClass({ name: "fs", network: "my-vpc" });
    expect((result.storageClass as any).parameters.network).toBe("my-vpc");
  });

  test("no network parameter by default", () => {
    const result = FilestoreStorageClass({ name: "fs" });
    expect((result.storageClass as any).parameters.network).toBeUndefined();
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
    const spec = result.gateway.spec as any;
    expect(spec.gatewayClassName).toBe("gke-l7-global-external-managed");
  });

  test("custom gatewayClassName", () => {
    const result = GkeGateway({ ...minProps, gatewayClassName: "gke-l7-rilb" });
    const spec = result.gateway.spec as any;
    expect(spec.gatewayClassName).toBe("gke-l7-rilb");
  });

  test("HTTP listener when no certificate", () => {
    const result = GkeGateway(minProps);
    const spec = result.gateway.spec as any;
    expect(spec.listeners[0].protocol).toBe("HTTP");
    expect(spec.listeners[0].port).toBe(80);
  });

  test("HTTPS listener with certificate", () => {
    const result = GkeGateway({ ...minProps, certificateName: "api-cert" });
    const spec = result.gateway.spec as any;
    expect(spec.listeners[0].protocol).toBe("HTTPS");
    expect(spec.listeners[0].port).toBe(443);
    expect(spec.listeners[0].tls.certificateRefs[0].name).toBe("api-cert");
  });

  test("httpRoute references parent gateway", () => {
    const result = GkeGateway(minProps);
    const spec = result.httpRoute.spec as any;
    expect(spec.parentRefs[0].name).toBe("api-gateway");
  });

  test("httpRoute has hostnames", () => {
    const result = GkeGateway(minProps);
    const spec = result.httpRoute.spec as any;
    expect(spec.hostnames).toEqual(["api.example.com"]);
  });

  test("httpRoute rules map to backend services", () => {
    const result = GkeGateway(minProps);
    const spec = result.httpRoute.spec as any;
    expect(spec.rules[0].backendRefs[0].name).toBe("api");
    expect(spec.rules[0].backendRefs[0].port).toBe(80);
  });

  test("namespace propagated to both resources", () => {
    const result = GkeGateway({ ...minProps, namespace: "prod" });
    expect((result.gateway.metadata as any).namespace).toBe("prod");
    expect((result.httpRoute.metadata as any).namespace).toBe("prod");
  });
});

// ── ConfigConnectorContext ───────────────────────────────────────────

describe("ConfigConnectorContext", () => {
  const minProps = { googleServiceAccountEmail: "cnrm@my-project.iam.gserviceaccount.com" };

  test("returns context with apiVersion and kind", () => {
    const result = ConfigConnectorContext(minProps);
    expect(result.context).toBeDefined();
    expect((result.context as any).apiVersion).toBe("core.cnrm.cloud.google.com/v1beta1");
    expect((result.context as any).kind).toBe("ConfigConnectorContext");
  });

  test("googleServiceAccount in spec", () => {
    const result = ConfigConnectorContext(minProps);
    const spec = (result.context as any).spec;
    expect(spec.googleServiceAccount).toBe("cnrm@my-project.iam.gserviceaccount.com");
  });

  test("default stateIntoSpec is absent", () => {
    const result = ConfigConnectorContext(minProps);
    expect((result.context as any).spec.stateIntoSpec).toBe("absent");
  });

  test("custom stateIntoSpec", () => {
    const result = ConfigConnectorContext({ ...minProps, stateIntoSpec: "merge" });
    expect((result.context as any).spec.stateIntoSpec).toBe("merge");
  });

  test("default namespace is default", () => {
    const result = ConfigConnectorContext(minProps);
    expect((result.context as any).metadata.namespace).toBe("default");
  });

  test("custom namespace", () => {
    const result = ConfigConnectorContext({ ...minProps, namespace: "config-connector" });
    expect((result.context as any).metadata.namespace).toBe("config-connector");
  });
});
