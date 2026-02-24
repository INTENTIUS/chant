import { describe, test, expect, jest } from "bun:test";
import { WebApp } from "./web-app";
import { StatefulApp } from "./stateful-app";
import { CronWorkload } from "./cron-workload";
import { AutoscaledService } from "./autoscaled-service";
import { WorkerPool } from "./worker-pool";
import { NamespaceEnv } from "./namespace-env";
import { NodeAgent } from "./node-agent";

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
