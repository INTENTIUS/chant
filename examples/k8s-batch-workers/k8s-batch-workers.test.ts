import { describe, test, expect } from "bun:test";
import { lintCommand } from "../../packages/core/src/cli/commands/lint";
import { build } from "../../packages/core/src/build";
import { resolve } from "path";
import { k8sSerializer } from "../../lexicons/k8s/src/serializer";

const srcDir = resolve(import.meta.dir, "src");

/** Parse multi-doc YAML into an array of { kind, name, doc } objects. */
function parseK8sDocs(yaml: string) {
  return yaml
    .split("---")
    .filter((d) => d.trim())
    .map((doc) => {
      const kind = doc.match(/kind:\s+(\S+)/)?.[1] ?? "";
      const name = doc.match(/\s+name:\s+(\S+)/)?.[1] ?? "";
      return { kind, name, doc };
    });
}

describe("k8s-batch-workers example", () => {
  // ── Lint ────────────────────────────────────────────────────────

  test("passes strict lint", async () => {
    const result = await lintCommand({
      path: srcDir,
      format: "stylish",
      fix: true,
    });

    if (!result.success || result.errorCount > 0 || result.warningCount > 0) {
      console.log(result.output);
    }

    expect(result.success).toBe(true);
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(0);
  });

  // ── Build ───────────────────────────────────────────────────────

  test("build succeeds with k8s serializer", async () => {
    const result = await build(srcDir, [k8sSerializer]);

    expect(result.errors).toHaveLength(0);
    expect(result.outputs.has("k8s")).toBe(true);
  });

  // ── Resource inventory ──────────────────────────────────────────

  test("K8s output contains all 23 expected resources", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    expect(result.errors).toHaveLength(0);

    const docs = parseK8sDocs(result.outputs.get("k8s")!);
    expect(docs).toHaveLength(23);

    const kinds = docs.map((d) => d.kind);
    expect(kinds.filter((k) => k === "Deployment")).toHaveLength(2);
    expect(kinds.filter((k) => k === "Service")).toHaveLength(1);
    expect(kinds.filter((k) => k === "ServiceAccount")).toHaveLength(4);
    expect(kinds.filter((k) => k === "Role")).toHaveLength(3);
    expect(kinds.filter((k) => k === "RoleBinding")).toHaveLength(3);
    expect(kinds.filter((k) => k === "ClusterRole")).toHaveLength(1);
    expect(kinds.filter((k) => k === "ClusterRoleBinding")).toHaveLength(1);
    expect(kinds.filter((k) => k === "ConfigMap")).toHaveLength(3);
    expect(kinds.filter((k) => k === "CronJob")).toHaveLength(1);
    expect(kinds.filter((k) => k === "Job")).toHaveLength(1);
    expect(kinds.filter((k) => k === "DaemonSet")).toHaveLength(1);
    expect(kinds.filter((k) => k === "HorizontalPodAutoscaler")).toHaveLength(1);
    expect(kinds.filter((k) => k === "Namespace")).toHaveLength(1);
  });

  // ── WorkerPool: HPA ────────────────────────────────────────────

  test("Worker HPA targets CPU 75%, min 2 / max 10", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);

    const hpa = docs.find((d) => d.kind === "HorizontalPodAutoscaler");
    expect(hpa).toBeDefined();
    expect(hpa!.doc).toContain("name: queue-worker");
    expect(hpa!.doc).toContain("kind: Deployment");
    expect(hpa!.doc).toContain("minReplicas: 2");
    expect(hpa!.doc).toContain("maxReplicas: 10");
    expect(hpa!.doc).toContain("averageUtilization: 75");
  });

  // ── WorkerPool: ConfigMap ──────────────────────────────────────

  test("Worker ConfigMap has REDIS_URL", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);

    const cm = docs.find(
      (d) => d.kind === "ConfigMap" && d.name.includes("queue-worker"),
    );
    expect(cm).toBeDefined();
    expect(cm!.doc).toContain("REDIS_URL");
    expect(cm!.doc).toContain("redis://redis:6379");
  });

  // ── CronWorkload: schedule and history ─────────────────────────

  test("CronJob schedule 0 2 * * * with history limits", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);

    const cron = docs.find((d) => d.kind === "CronJob");
    expect(cron).toBeDefined();
    expect(cron!.doc).toContain("schedule: '0 2 * * *'");
    expect(cron!.doc).toContain("successfulJobsHistoryLimit: 3");
    expect(cron!.doc).toContain("failedJobsHistoryLimit: 2");
  });

  // ── BatchJob: backoff and TTL ──────────────────────────────────

  test("BatchJob has backoffLimit 3 and TTL", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);

    const job = docs.find((d) => d.kind === "Job");
    expect(job).toBeDefined();
    expect(job!.doc).toContain("backoffLimit: 3");
    expect(job!.doc).toContain("ttlSecondsAfterFinished: 3600");
  });

  // ── ConfiguredApp: config and secret mounts ────────────────────

  test("task-api has config mount at /etc/task-api and secret mount at /secrets", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);

    const deploy = docs.find(
      (d) => d.kind === "Deployment" && d.name === "task-api",
    );
    expect(deploy).toBeDefined();
    expect(deploy!.doc).toContain("/etc/task-api");
    expect(deploy!.doc).toContain("/secrets");
  });

  // ── NodeAgent: hostPath and tolerations ────────────────────────

  test("log-collector DaemonSet has /var/log hostPath and tolerate-all", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);

    const ds = docs.find((d) => d.kind === "DaemonSet");
    expect(ds).toBeDefined();
    expect(ds!.doc).toContain("/var/log");
    expect(ds!.doc).toContain("operator: Exists");
  });

  // ── Namespace propagation ──────────────────────────────────────

  test("all namespaced resources are in batch-workers namespace", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);

    const namespacedKinds = [
      "Deployment", "Service", "ServiceAccount", "Role", "RoleBinding",
      "ConfigMap", "CronJob", "Job", "DaemonSet", "HorizontalPodAutoscaler",
    ];
    const namespacedDocs = docs.filter((d) => namespacedKinds.includes(d.kind));
    for (const doc of namespacedDocs) {
      expect(doc.doc).toContain("namespace: batch-workers");
    }
  });

  // ── Label consistency ──────────────────────────────────────────

  test("all resources have managed-by: chant label", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);

    for (const doc of docs) {
      expect(doc.doc).toContain("app.kubernetes.io/managed-by: chant");
    }
  });
});
