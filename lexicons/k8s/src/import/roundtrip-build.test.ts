/**
 * Import a manifest, build the generated source, and compare the documents.
 * Each case is a manifest from the Kubernetes documentation examples that did
 * not come back.
 */
import { describe, expect, test } from "vitest";
import { loadAll } from "js-yaml";
import { build } from "@intentius/chant/build";
import type { SerializerResult } from "@intentius/chant/serializer";
import { k8sSerializer } from "../serializer";
import { importManifest, removeDir } from "./testdata/embedded/fixtures";

function primary(out: string | SerializerResult | undefined): string {
  if (out === undefined) return "";
  return typeof out === "string" ? out : out.primary;
}

async function roundTrip(yaml: string): Promise<unknown[]> {
  const imported = await importManifest(yaml);
  try {
    expect(imported.result.error).toBeUndefined();
    const result = await build(imported.srcDir, [k8sSerializer]);
    expect(result.errors).toEqual([]);
    return (loadAll(primary(result.outputs.get("k8s"))) as unknown[]).filter((d) => d);
  } finally {
    removeDir(imported.dir);
  }
}

describe("k8s import round trip", () => {
  test("a NetworkPolicy's egress: [{}] comes back as one empty rule", async () => {
    const yaml = [
      "apiVersion: networking.k8s.io/v1",
      "kind: NetworkPolicy",
      "metadata:",
      "  name: allow-all-egress",
      "spec:",
      "  podSelector: {}",
      "  egress:",
      "  - {}",
      "  policyTypes:",
      "  - Egress",
    ].join("\n");
    expect(await roundTrip(yaml)).toEqual(loadAll(yaml));
  });

  test("RBAC objects named with a colon import to valid identifiers and keep their names", async () => {
    const yaml = [
      "apiVersion: rbac.authorization.k8s.io/v1",
      "kind: ClusterRole",
      "metadata:",
      "  name: system:metrics-server",
      "rules:",
      "- apiGroups: ['']",
      "  resources: [nodes]",
      "  verbs: [get]",
      "---",
      "apiVersion: rbac.authorization.k8s.io/v1",
      "kind: ClusterRoleBinding",
      "metadata:",
      "  name: system:metrics-server",
      "roleRef:",
      "  apiGroup: rbac.authorization.k8s.io",
      "  kind: ClusterRole",
      "  name: system:metrics-server",
      "subjects:",
      "- kind: ServiceAccount",
      "  name: metrics-server",
      "  namespace: kube-system",
    ].join("\n");
    // The serializer orders the documents; the names are what this checks.
    const byKind = (docs: unknown[]) => [...(docs as { kind: string }[])].sort((a, b) => a.kind.localeCompare(b.kind));
    expect(byKind(await roundTrip(yaml))).toEqual(byKind(loadAll(yaml) as unknown[]));
  });

  test("an autoscaling/v1 HorizontalPodAutoscaler keeps its apiVersion", async () => {
    const yaml = [
      "apiVersion: autoscaling/v1",
      "kind: HorizontalPodAutoscaler",
      "metadata:",
      "  name: frontend-scaler",
      "spec:",
      "  scaleTargetRef:",
      "    kind: ReplicaSet",
      "    name: frontend",
      "  minReplicas: 3",
      "  maxReplicas: 10",
      "  targetCPUUtilizationPercentage: 50",
    ].join("\n");
    expect(await roundTrip(yaml)).toEqual(loadAll(yaml));
  });

  test("an autoscaling/v2 HorizontalPodAutoscaler is generated without an apiVersion property", async () => {
    const yaml = [
      "apiVersion: autoscaling/v2",
      "kind: HorizontalPodAutoscaler",
      "metadata:",
      "  name: web",
      "spec:",
      "  scaleTargetRef:",
      "    apiVersion: apps/v1",
      "    kind: Deployment",
      "    name: web",
      "  minReplicas: 1",
      "  maxReplicas: 3",
    ].join("\n");
    const imported = await importManifest(yaml);
    try {
      const source = Object.values(imported.files).join("\n");
      expect(source).not.toContain('apiVersion: "autoscaling/v2"');
    } finally {
      removeDir(imported.dir);
    }
    expect(await roundTrip(yaml)).toEqual(loadAll(yaml));
  });

  test("import names an error-severity check the generated source will fail at build (#3605)", async () => {
    const yaml = [
      "apiVersion: apps/v1",
      "kind: StatefulSet",
      "metadata:",
      "  name: mysql",
      "spec:",
      "  selector:",
      "    matchLabels:",
      "      app: mysql",
      "  serviceName: mysql",
      "  template:",
      "    metadata:",
      "      labels:",
      "        app: mysql",
      "    spec:",
      "      containers:",
      "      - name: mysql",
      "        image: mysql:5.7",
      "        env:",
      "        - name: MYSQL_ALLOW_EMPTY_PASSWORD",
      '          value: "1"',
    ].join("\n");
    const imported = await importManifest(yaml);
    try {
      expect(imported.result.success).toBe(true);
      const named = imported.result.warnings.filter((w) => w.startsWith("WK8005:"));
      expect(named).toHaveLength(1);
      expect(named[0]).toContain('"MYSQL_ALLOW_EMPTY_PASSWORD"');
      expect(named[0]).toContain("chant build stops on this error");
    } finally {
      removeDir(imported.dir);
    }
  });

  test("import names no check for a manifest that builds cleanly", async () => {
    const imported = await importManifest(
      ["apiVersion: v1", "kind: ConfigMap", "metadata:", "  name: settings", "data:", "  mode: fast"].join("\n"),
    );
    try {
      expect(imported.result.warnings.filter((w) => /^[A-Z]+\d+: /.test(w))).toEqual([]);
    } finally {
      removeDir(imported.dir);
    }
  });

  test("a kind the lexicon has no class for is written untyped, builds, and comes back (#5070)", async () => {
    const yaml = [
      "apiVersion: external-secrets.io/v1",
      "kind: ExternalSecret",
      "metadata:",
      "  name: db",
      "  namespace: apps",
      "spec:",
      "  refreshInterval: 1h",
      "  secretStoreRef:",
      "    kind: ClusterSecretStore",
      "    name: vault",
      "  data:",
      "  - secretKey: password",
      "    remoteRef:",
      "      key: db/password",
      "---",
      "apiVersion: networking.gke.io/v1beta1",
      "kind: ManagedCertificate",
      "metadata:",
      "  name: cert",
      "spec:",
      "  domains:",
      "  - example.org",
      "---",
      "apiVersion: networking.gke.io/v1beta1",
      "kind: ManagedCertificate",
      "metadata:",
      "  name: cert-two",
      "spec:",
      "  domains:",
      "  - example.com",
    ].join("\n");
    const imported = await importManifest(yaml);
    try {
      expect(imported.result.error).toBeUndefined();
      const warned = imported.result.warnings.filter((w) => w.includes("k8s.crds"));
      expect(warned.length).toBe(2);
      expect(warned.join("\n")).toContain("chant generate");
      const result = await build(imported.srcDir, [k8sSerializer]);
      expect(result.errors).toEqual([]);
      const docs = (loadAll(primary(result.outputs.get("k8s"))) as unknown[]).filter((d) => d);
      expect(docs).toEqual(loadAll(yaml).filter((d) => d));
    } finally {
      removeDir(imported.dir);
    }
  });
});
