import { describe, test, expect } from "bun:test";
import { lintCommand } from "../../packages/core/src/cli/commands/lint";
import { build } from "../../packages/core/src/build";
import { resolve } from "path";
import { k8sSerializer } from "../../lexicons/k8s/src/serializer";
import { MonitoredService } from "../../lexicons/k8s/src/composites/monitored-service";
import { SecureIngress } from "../../lexicons/k8s/src/composites/secure-ingress";

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

describe("k8s-web-platform example", () => {
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

  test("K8s output contains all 11 expected resources", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    expect(result.errors).toHaveLength(0);

    const docs = parseK8sDocs(result.outputs.get("k8s")!);
    expect(docs).toHaveLength(11);

    const kinds = docs.map((d) => d.kind);
    expect(kinds.filter((k) => k === "Deployment")).toHaveLength(3);
    expect(kinds.filter((k) => k === "Service")).toHaveLength(3);
    expect(kinds.filter((k) => k === "PodDisruptionBudget")).toHaveLength(1);
    expect(kinds.filter((k) => k === "Ingress")).toHaveLength(1);
    expect(kinds.filter((k) => k === "NetworkPolicy")).toHaveLength(1);
    expect(kinds.filter((k) => k === "StorageClass")).toHaveLength(1);
    expect(kinds.filter((k) => k === "Namespace")).toHaveLength(1);
  });

  // ── WebApp: frontend ───────────────────────────────────────────

  test("Frontend deployment uses nginx:1.25-alpine with health probes", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);

    const deploy = docs.find(
      (d) => d.kind === "Deployment" && d.name === "frontend",
    );
    expect(deploy).toBeDefined();
    expect(deploy!.doc).toContain("nginx:1.25-alpine");
    expect(deploy!.doc).toContain("livenessProbe:");
    expect(deploy!.doc).toContain("readinessProbe:");
  });

  // ── SidecarApp: API with envoy ─────────────────────────────────

  test("API deployment has 2 containers (app + envoy) and shared volume", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);

    const deploy = docs.find(
      (d) => d.kind === "Deployment" && d.name === "api",
    );
    expect(deploy).toBeDefined();
    expect(deploy!.doc).toContain("hashicorp/http-echo:0.2.3");
    expect(deploy!.doc).toContain("envoyproxy/envoy:v1.28-latest");
    expect(deploy!.doc).toContain("envoy-config");
  });

  // ── SecureIngress: TLS and routing ─────────────────────────────

  test("Ingress has cert-manager annotation, TLS section, path routing", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);

    const ingress = docs.find((d) => d.kind === "Ingress");
    expect(ingress).toBeDefined();
    expect(ingress!.doc).toContain("cert-manager.io/cluster-issuer: letsencrypt-prod");
    expect(ingress!.doc).toContain("ingressClassName: nginx");
    expect(ingress!.doc).toContain("host: app.example.com");
    expect(ingress!.doc).toContain("path: /api");
    expect(ingress!.doc).toContain("secretName: web-platform-tls");
    expect(ingress!.doc).toContain("nginx.ingress.kubernetes.io/ssl-redirect: 'true'");
  });

  // ── NetworkIsolatedApp: network policy ─────────────────────────

  test("NetworkPolicy allows ingress from frontend only, egress to postgres:5432", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);

    const netpol = docs.find((d) => d.kind === "NetworkPolicy");
    expect(netpol).toBeDefined();
    expect(netpol!.doc).toContain("app.kubernetes.io/name: frontend");
    expect(netpol!.doc).toContain("port: 5432");
    expect(netpol!.doc).toContain("Ingress");
    expect(netpol!.doc).toContain("Egress");
  });

  // ── EfsStorageClass ────────────────────────────────────────────

  test("EFS StorageClass uses efs.csi.aws.com", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);

    const sc = docs.find((d) => d.kind === "StorageClass");
    expect(sc).toBeDefined();
    expect(sc!.doc).toContain("provisioner: efs.csi.aws.com");
    expect(sc!.doc).toContain("fs-0123456789abcdef0");
    expect(sc!.doc).toContain("directoryPerms: '755'");
  });

  // ── Namespace propagation ──────────────────────────────────────

  test("namespaced resources are in web-platform namespace", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);

    const namespacedKinds = ["Deployment", "Service", "PodDisruptionBudget", "Ingress", "NetworkPolicy"];
    const namespacedDocs = docs.filter((d) => namespacedKinds.includes(d.kind));
    for (const doc of namespacedDocs) {
      expect(doc.doc).toContain("namespace: web-platform");
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

  // ── Structural CRD tests ──────────────────────────────────────

  test("MonitoredService produces serviceMonitor with metrics port and prometheusRule with alert", () => {
    const result = MonitoredService({
      name: "api",
      image: "api:1.0",
      metricsPort: 9090,
      namespace: "web-platform",
      alertRules: [
        { name: "HighErrorRate", expr: 'rate(http_errors_total[5m]) > 0.1', for: "5m", severity: "critical" },
      ],
    });

    // ServiceMonitor
    const smSpec = result.serviceMonitor.spec as any;
    expect(smSpec.endpoints[0].port).toBe("metrics");
    expect(smSpec.endpoints[0].path).toBe("/metrics");
    expect(smSpec.selector.matchLabels["app.kubernetes.io/name"]).toBe("api");

    // PrometheusRule
    expect(result.prometheusRule).toBeDefined();
    const prSpec = result.prometheusRule!.spec as any;
    expect(prSpec.groups[0].rules[0].alert).toBe("HighErrorRate");
    expect(prSpec.groups[0].rules[0].labels.severity).toBe("critical");
  });

  test("SecureIngress produces certificate with issuerRef, dnsNames, secretName", () => {
    const result = SecureIngress({
      name: "web-platform",
      clusterIssuer: "letsencrypt-prod",
      namespace: "web-platform",
      hosts: [{
        hostname: "app.example.com",
        paths: [{ path: "/", serviceName: "frontend", servicePort: 80 }],
      }],
    });

    expect(result.certificate).toBeDefined();
    const certSpec = result.certificate!.spec as any;
    expect(certSpec.issuerRef.name).toBe("letsencrypt-prod");
    expect(certSpec.issuerRef.kind).toBe("ClusterIssuer");
    expect(certSpec.dnsNames).toEqual(["app.example.com"]);
    expect(certSpec.secretName).toBe("web-platform-tls");
  });
});
