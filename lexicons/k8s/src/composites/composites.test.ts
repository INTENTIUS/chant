import { describe, test, expect } from "bun:test";
import { WebApp } from "./web-app";
import { StatefulApp } from "./stateful-app";
import { CronWorkload } from "./cron-workload";

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
});
