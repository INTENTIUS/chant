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
});
