/**
 * `kubectlApply` over the typed API client (chant #1074).
 *
 * The activity contract is what Temporal workers register, so the shape of the
 * arguments and the `Promise<void>` return are asserted alongside the new
 * behavior. Nothing here spawns a process or reads an ambient kubeconfig,
 * which is the acceptance criterion: a worker image needs no `kubectl` binary.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kubectlApply, readManifestDocuments } from "./kubectl";
import { fakeCluster } from "../../api/fake-cluster";
import { statusBody } from "@intentius/chant-k8s-client/testing";

let dir: string;

const deploymentYaml = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: prod
spec:
  replicas: 3
---
apiVersion: v1
kind: Service
metadata:
  name: web-svc
  namespace: prod
spec:
  ports:
    - port: 80
`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chant-k8s-apply-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readManifestDocuments", () => {
  test("splits a multi-document file, dropping empty documents", () => {
    const file = join(dir, "k8s.yaml");
    writeFileSync(file, `${deploymentYaml}---\n---\n`);
    const docs = readManifestDocuments(file);
    expect(docs.map((d) => d.kind)).toEqual(["Deployment", "Service"]);
  });

  test("a directory is read in sorted file order, as `kubectl apply -f <dir>` does", () => {
    writeFileSync(join(dir, "20-service.yaml"), "apiVersion: v1\nkind: Service\nmetadata:\n  name: b\n");
    writeFileSync(join(dir, "10-deployment.yaml"), "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: a\n");
    writeFileSync(join(dir, "notes.txt"), "ignored");
    const docs = readManifestDocuments(dir);
    expect(docs.map((d) => d.kind)).toEqual(["Deployment", "Service"]);
  });

  test("JSON manifests are read too", () => {
    const file = join(dir, "k8s.json");
    writeFileSync(file, JSON.stringify({ apiVersion: "v1", kind: "ConfigMap", metadata: { name: "c" } }));
    expect(readManifestDocuments(file).map((d) => d.kind)).toEqual(["ConfigMap"]);
  });
});

describe("kubectlApply", () => {
  test("server-side applies every document, in file order, as the chant field manager", async () => {
    const file = join(dir, "k8s.yaml");
    writeFileSync(file, deploymentYaml);
    const cluster = fakeCluster({
      respond: (req) => (req.method === "PATCH" ? { body: JSON.parse(String(req.body)) } : undefined),
    });

    await kubectlApply({ manifest: file }, undefined, cluster.connector);

    const patches = cluster.layer.requests.filter((r) => r.method === "PATCH");
    expect(patches.map((p) => p.path)).toEqual([
      "/apis/apps/v1/namespaces/prod/deployments/web",
      "/api/v1/namespaces/prod/services/web-svc",
    ]);
    for (const patch of patches) {
      expect(patch.headers["Content-Type"]).toBe("application/apply-patch+yaml");
      expect(patch.query).toMatchObject({ fieldManager: "chant", force: "false" });
    }
  });

  test("an explicit context is honored and skips the environment lookup entirely", async () => {
    const file = join(dir, "k8s.yaml");
    writeFileSync(file, deploymentYaml);
    const cluster = fakeCluster({
      respond: (req) => (req.method === "PATCH" ? { body: JSON.parse(String(req.body)) } : undefined),
    });

    await kubectlApply({ manifest: file, context: "test-context" }, undefined, cluster.connector);

    expect(cluster.connects[0]).toMatchObject({ context: "test-context" });
    expect(cluster.connects[0].environment).toBeUndefined();
  });

  test("an environment is passed through so the cluster binding applies to the write path too", async () => {
    const file = join(dir, "k8s.yaml");
    writeFileSync(file, deploymentYaml);
    const cluster = fakeCluster({
      respond: (req) => (req.method === "PATCH" ? { body: JSON.parse(String(req.body)) } : undefined),
    });

    await kubectlApply({ manifest: file, environment: "prod" }, undefined, cluster.connector);
    expect(cluster.connects[0]).toMatchObject({ environment: "prod" });
  });

  test("force is forwarded, for the caller that means to take ownership (chant #1075)", async () => {
    const file = join(dir, "k8s.yaml");
    writeFileSync(file, deploymentYaml);
    const cluster = fakeCluster({
      respond: (req) => (req.method === "PATCH" ? { body: JSON.parse(String(req.body)) } : undefined),
    });

    await kubectlApply({ manifest: file, force: true, fieldManager: "chant-op" }, undefined, cluster.connector);
    const patch = cluster.layer.requests.find((r) => r.method === "PATCH")!;
    expect(patch.query).toMatchObject({ force: "true", fieldManager: "chant-op" });
  });

  test("a field-ownership conflict surfaces as a typed error rather than parsed stderr", async () => {
    const file = join(dir, "k8s.yaml");
    writeFileSync(file, deploymentYaml);
    const cluster = fakeCluster({
      respond: (req) =>
        req.method === "PATCH"
          ? { status: 409, body: statusBody(409, "Conflict", 'Apply failed with 1 conflict: conflict with "kubectl"') }
          : undefined,
    });

    const err = await kubectlApply({ manifest: file }, undefined, cluster.connector).catch((e: unknown) => e);
    expect((err as { name?: string }).name).toBe("K8sApiError");
    expect((err as { statusCode?: number }).statusCode).toBe(409);
  });

  test("resolves to undefined, keeping the activity's Promise<void> contract", async () => {
    const file = join(dir, "k8s.yaml");
    writeFileSync(file, "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: c\n  namespace: prod\n");
    const cluster = fakeCluster({
      respond: (req) => (req.method === "PATCH" ? { body: JSON.parse(String(req.body)) } : undefined),
    });
    await expect(kubectlApply({ manifest: file }, undefined, cluster.connector)).resolves.toBeUndefined();
  });
});
