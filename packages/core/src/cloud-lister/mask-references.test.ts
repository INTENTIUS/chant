/**
 * chant#5116: a reference field (`secretStoreRef`) names an object and is
 * readable; every value that could be a secret stays masked, on both passes
 * (the lister's and the deep observation's normalization).
 */
import { describe, expect, it } from "vitest";
import { MASKED, argoClusterView, maskKubernetesObject, maskValue } from "./mask";
import { isReferenceField } from "../sensitive-key";
import { normalizeDeepProperties } from "../deep-observation";

const externalSecret = {
  apiVersion: "external-secrets.io/v1beta1",
  kind: "ExternalSecret",
  metadata: { name: "db", namespace: "app" },
  spec: {
    secretStoreRef: { name: "vault", kind: "ClusterSecretStore" },
    target: { name: "db-credentials" },
    data: [{ secretKey: "password", remoteRef: { key: "prod/db", property: "password" } }],
  },
};

const b64 = (s: string) => Buffer.from(s).toString("base64");

function clusterSecret(extra: Record<string, unknown> = {}) {
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: "cluster-prod", namespace: "argocd", labels: { "argocd.argoproj.io/secret-type": "cluster" } },
    type: "Opaque",
    data: { name: b64("prod"), server: b64("https://prod.example.com"), config: b64('{"bearerToken":"s3cr3t-token"}') },
    ...extra,
  };
}

describe("reference fields", () => {
  it("leaves an ExternalSecret's secretStoreRef readable on the lister's pass", () => {
    const out = maskKubernetesObject(externalSecret) as typeof externalSecret;
    expect(out.spec.secretStoreRef).toEqual({ name: "vault", kind: "ClusterSecretStore" });
    expect(out.spec.target).toEqual({ name: "db-credentials" });
  });

  it("leaves it readable on the deep observation's pass too", () => {
    const out = normalizeDeepProperties(maskKubernetesObject(externalSecret), { entityType: "K8s::ExternalSecrets::ExternalSecret", side: "live" }) as { spec: Record<string, unknown> };
    expect(out.spec.secretStoreRef).toEqual({ name: "vault", kind: "ClusterSecretStore" });
  });

  it("keeps masking a key that only looks like a reference", () => {
    const out = maskValue({
      secretStoreRef: "hunter2",
      secretRef: { name: "s", key: "token-value" },
      imagePullSecrets: [{ name: "regcred" }, { name: "x", password: "p" }],
      secretKeyRef: { name: "db", key: "password" },
      secretName: "also-a-key-name",
      clientSecret: { name: "x" },
      nested: { secretStoreRef: { name: "v", extra: { deep: "value" } } },
    }) as Record<string, unknown>;
    expect(out.secretStoreRef).toBe(MASKED);
    expect(out.secretRef).toBe(MASKED);
    expect(out.imagePullSecrets).toBe(MASKED);
    expect(out.secretKeyRef).toBe(MASKED);
    expect(out.secretName).toBe(MASKED);
    expect(out.clientSecret).toBe(MASKED);
    expect((out.nested as Record<string, unknown>).secretStoreRef).toBe(MASKED);
  });

  it("allows a pointer, a list of pointers, and nothing else", () => {
    expect(isReferenceField("secretStoreRef", { name: "a", kind: "SecretStore" })).toBe(true);
    expect(isReferenceField("imagePullSecrets", [{ name: "a" }, { name: "b" }])).toBe(true);
    expect(isReferenceField("imagePullSecrets", [])).toBe(false);
    expect(isReferenceField("secretStoreRef", { name: 1 })).toBe(false);
    expect(isReferenceField("secretStoreRef", {})).toBe(true);
    expect(isReferenceField("secretStoreRef", null)).toBe(false);
    expect(isReferenceField("password", { name: "a" })).toBe(false);
  });

  it("still masks every Secret data key, and the Secret's annotation copy", () => {
    const out = maskKubernetesObject({
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "s", annotations: { "kubectl.kubernetes.io/last-applied-configuration": '{"data":{"secretRef":"x"}}' } },
      data: { secretStoreRef: b64("hunter2"), secretRef: b64("x"), other: b64("y") },
    });
    expect(out.data).toEqual({ secretStoreRef: MASKED, secretRef: MASKED, other: MASKED });
    expect(JSON.stringify(out)).not.toContain(b64("hunter2"));
  });
});

describe("an Argo CD cluster Secret on a live read", () => {
  it("by default (the #5116 ruling) shows name and server as argoCluster, and config stays masked", () => {
    const out = maskKubernetesObject(clusterSecret());
    expect(out.data).toEqual({ name: MASKED, server: MASKED, config: MASKED });
    expect(out.argoCluster).toEqual({ name: "prod", server: "https://prod.example.com" });
    expect(JSON.stringify(out)).not.toContain("s3cr3t-token");
  });

  it("with the switch off, is masked whole: no name, no server, no argoCluster view", () => {
    const out = maskKubernetesObject(clusterSecret(), { exposeArgoClusterIdentity: false });
    expect(out.data).toEqual({ name: MASKED, server: MASKED, config: MASKED });
    expect(out.argoCluster).toBeUndefined();
    const text = JSON.stringify(out);
    for (const leaked of [b64("prod"), b64("https://prod.example.com"), "s3cr3t-token", "prod.example.com"]) expect(text).not.toContain(leaked);
  });

  it("with the switch on, exposes name and server only, and config and every other key stay masked", () => {
    const out = maskKubernetesObject(clusterSecret({ data: { name: b64("prod"), server: b64("https://prod.example.com"), config: b64('{"bearerToken":"s3cr3t-token"}'), caData: b64("PEM") } }), { exposeArgoClusterIdentity: true });
    expect(out.argoCluster).toEqual({ name: "prod", server: "https://prod.example.com" });
    expect(out.data).toEqual({ name: MASKED, server: MASKED, config: MASKED, caData: MASKED });
    const text = JSON.stringify(out);
    expect(text).not.toContain("s3cr3t-token");
    expect(text).not.toContain(b64('{"bearerToken":"s3cr3t-token"}'));
    expect(text).not.toContain("PEM");
  });

  it("with the switch on, leaves a server with credentials in its URL out", () => {
    const out = maskKubernetesObject(clusterSecret({ data: { name: b64("prod"), server: b64("https://admin:hunter2@prod.example.com") } }), { exposeArgoClusterIdentity: true });
    expect(out.argoCluster).toEqual({ name: "prod" });
    expect(JSON.stringify(out)).not.toContain("hunter2");
  });

  it("with the switch on, is not applied to a Secret without the cluster label or to another kind", () => {
    const plain = clusterSecret({ metadata: { name: "x", labels: { app: "y" } } });
    expect(maskKubernetesObject(plain, { exposeArgoClusterIdentity: true }).argoCluster).toBeUndefined();
    expect(argoClusterView({ ...clusterSecret(), kind: "ConfigMap" })).toBeUndefined();
  });

  it("survives the deep observation's pass with config still masked", () => {
    const masked = maskKubernetesObject(clusterSecret(), { exposeArgoClusterIdentity: true });
    const out = normalizeDeepProperties(masked, { entityType: "K8s::Core::Secret", side: "live" }) as Record<string, unknown>;
    expect(out.argoCluster).toEqual({ name: "prod", server: "https://prod.example.com" });
    expect(JSON.stringify(out)).not.toContain("s3cr3t-token");
  });
});
