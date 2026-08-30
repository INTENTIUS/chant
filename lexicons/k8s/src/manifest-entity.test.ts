import { describe, test, expect } from "vitest";
import { k8sManifest, manifestEntity, isRenderedManifestEntity } from "./manifest-entity";
import { k8sSerializer } from "./serializer";
import type { Declarable } from "@intentius/chant/declarable";

/**
 * The verbatim manifest escape hatch, and the round trip `chant carve emit`
 * depends on (chant #999): a `kubernetes_manifest` body adopted out of
 * Terraform state has to serialize back to the same object, kind included, or
 * the carve loses configuration on the way out of Terraform.
 */
describe("k8sManifest", () => {
  test("types itself from apiVersion + kind through the shared group rule", () => {
    expect(k8sManifest({ apiVersion: "v1", kind: "ConfigMap", metadata: { name: "app-config" } }).entityType).toBe(
      "K8s::Core::ConfigMap",
    );
    expect(k8sManifest({ apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "web" } }).entityType).toBe(
      "K8s::Apps::Deployment",
    );
    expect(k8sManifest({ apiVersion: "cert-manager.io/v1", kind: "Certificate", metadata: { name: "tls" } }).entityType).toBe(
      "K8s::CertManager::Certificate",
    );
    // The overrides apply too — this is the one group→namespace rule, not a copy.
    expect(k8sManifest({ apiVersion: "argoproj.io/v1alpha1", kind: "Application", metadata: { name: "app" } }).entityType).toBe(
      "K8s::Argo::Application",
    );
  });

  test("refuses a document that is not a Kubernetes object", () => {
    expect(() => k8sManifest({ metadata: { name: "x" } })).toThrow(/apiVersion/);
    expect(manifestEntity({ metadata: { name: "x" } })).toBeNull();
  });

  test("serializes verbatim, including a kind the lexicon ships no class for", () => {
    const entities = new Map<string, Declarable>();
    entities.set(
      "webCert",
      k8sManifest({
        apiVersion: "cert-manager.io/v1",
        kind: "Certificate",
        metadata: { name: "web-tls", namespace: "web" },
        spec: { secretName: "web-tls", dnsNames: ["web.example.com"] },
      }),
    );

    const yaml = k8sSerializer.serialize(entities);
    expect(yaml).toContain("apiVersion: cert-manager.io/v1");
    expect(yaml).toContain("kind: Certificate");
    expect(yaml).toContain("name: web-tls");
    expect(yaml).toContain("- web.example.com");
  });

  test("a top-level field that is not spec stays at the top level", () => {
    // The spec-inference heuristics are for typed declarables; a finished
    // manifest must not have its `rules` re-nested under a synthetic spec.
    const entities = new Map<string, Declarable>();
    entities.set(
      "viewer",
      k8sManifest({
        apiVersion: "rbac.authorization.k8s.io/v1",
        kind: "ClusterRole",
        metadata: { name: "viewer" },
        rules: [{ apiGroups: [""], resources: ["pods"], verbs: ["get", "list"] }],
      }),
    );

    const yaml = k8sSerializer.serialize(entities);
    expect(yaml).toMatch(/^rules:/m);
    expect(yaml).not.toMatch(/^spec:\s*\n\s+rules:/m);
  });

  test("is the same verbatim entity a rendered kustomize document is", () => {
    const entity = k8sManifest({ apiVersion: "v1", kind: "Namespace", metadata: { name: "web" } });
    expect(isRenderedManifestEntity(entity)).toBe(true);
    expect(entity.lexicon).toBe("k8s");
    expect(entity.kind).toBe("resource");
  });
});
