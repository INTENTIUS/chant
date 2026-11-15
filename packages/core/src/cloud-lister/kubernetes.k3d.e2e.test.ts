/**
 * chant#5116 on a real API server: what the lister returns for an
 * ExternalSecret and an Argo CD cluster Secret.
 *
 * On demand only. It needs Docker, k3d and kubectl, creates the scratch
 * cluster `chant-live-read-5116`, and leaves it running (delete it with
 * `k3d cluster delete chant-live-read-5116`, or set CHANT_K3D_DELETE=1 to
 * have the test delete it at the end). Run with:
 *
 *   CHANT_K3D_SCRATCH=1 npx vitest run packages/core/src/cloud-lister/kubernetes.k3d.e2e.test.ts
 *
 * The kubeconfig is written to a temp directory and the default kubeconfig
 * is never touched.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listCloud, kubeTargetFromKubeconfig } from "./index";
import { MASKED, maskKubernetesObject } from "./mask";

const CLUSTER = "chant-live-read-5116";
const enabled = process.env.CHANT_K3D_SCRATCH === "1";

const b64 = (s: string) => Buffer.from(s).toString("base64");

describe.skipIf(!enabled)("live read of an ExternalSecret and a cluster Secret (scratch k3d)", () => {
  it("shows secretStoreRef, masks the Secret payloads, and the cluster identity follows the switch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-5116-"));
    const kubeconfig = join(dir, "kubeconfig");
    const run = (cmd: string, args: string[], input?: string) =>
      execFileSync(cmd, args, { encoding: "utf8", input, env: { ...process.env, KUBECONFIG: kubeconfig } });

    const existing = run("k3d", ["cluster", "list", "--no-headers"]);
    if (!existing.split("\n").some((l) => l.startsWith(`${CLUSTER} `))) {
      run("k3d", ["cluster", "create", CLUSTER, "--kubeconfig-update-default=false", "--kubeconfig-switch-context=false", "--wait", "--timeout", "180s"]);
    }
    writeFileSync(kubeconfig, run("k3d", ["kubeconfig", "get", CLUSTER]));

    const crd = {
      apiVersion: "apiextensions.k8s.io/v1",
      kind: "CustomResourceDefinition",
      metadata: { name: "externalsecrets.external-secrets.io" },
      spec: {
        group: "external-secrets.io",
        scope: "Namespaced",
        names: { kind: "ExternalSecret", plural: "externalsecrets", singular: "externalsecret" },
        versions: [{ name: "v1beta1", served: true, storage: true, schema: { openAPIV3Schema: { type: "object", "x-kubernetes-preserve-unknown-fields": true } } }],
      },
    };
    run("kubectl", ["apply", "-f", "-"], JSON.stringify(crd));
    run("kubectl", ["wait", "--for=condition=Established", "crd/externalsecrets.external-secrets.io", "--timeout=60s"]);
    run("kubectl", ["apply", "-f", "-"], JSON.stringify({ apiVersion: "v1", kind: "Namespace", metadata: { name: "argocd" } }));
    run(
      "kubectl",
      ["apply", "-f", "-"],
      JSON.stringify({
        apiVersion: "external-secrets.io/v1beta1",
        kind: "ExternalSecret",
        metadata: { name: "db", namespace: "argocd" },
        spec: {
          secretStoreRef: { name: "vault", kind: "ClusterSecretStore" },
          target: { name: "db-credentials" },
          data: [{ secretKey: "password", remoteRef: { key: "prod/db", property: "password" } }],
        },
      }),
    );
    run(
      "kubectl",
      ["apply", "-f", "-"],
      JSON.stringify({
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: "cluster-prod", namespace: "argocd", labels: { "argocd.argoproj.io/secret-type": "cluster" } },
        type: "Opaque",
        stringData: { name: "prod", server: "https://prod.example.com", config: '{"bearerToken":"s3cr3t-token"}' },
      }),
    );

    const result = await listCloud(
      { substrate: "kubernetes", scopeId: CLUSTER, types: ["external-secrets.io/v1beta1/ExternalSecret", "v1/Secret"], locations: ["argocd"] },
      { substrate: "kubernetes", kubernetes: kubeTargetFromKubeconfig(readFileSync(kubeconfig, "utf8")) },
    );

    const es = result.resources.find((r) => r.listedType === "external-secrets.io/v1beta1/ExternalSecret")!;
    expect((es.properties.spec as Record<string, unknown>).secretStoreRef).toEqual({ name: "vault", kind: "ClusterSecretStore" });

    const secret = result.resources.find((r) => r.nativeId === "argocd/cluster-prod")!;
    expect(secret.properties.data).toEqual({ name: MASKED, server: MASKED, config: MASKED });
    expect(secret.properties.argoCluster).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("s3cr3t-token");
    expect(JSON.stringify(result)).not.toContain(b64("s3cr3t-token"));

    // The same object as the API server serves it, masked with the switch on.
    const raw = JSON.parse(run("kubectl", ["get", "secret", "cluster-prod", "-n", "argocd", "-o", "json"])) as Record<string, unknown>;
    const exposed = maskKubernetesObject(raw, { exposeArgoClusterIdentity: true });
    expect(exposed.argoCluster).toEqual({ name: "prod", server: "https://prod.example.com" });
    expect(exposed.data).toEqual({ name: MASKED, server: MASKED, config: MASKED });
    expect(JSON.stringify(exposed)).not.toContain("s3cr3t-token");

    if (process.env.CHANT_K3D_DELETE === "1") run("k3d", ["cluster", "delete", CLUSTER]);
  }, 400_000);
});
