/**
 * The generated operation surface (chant #1074) — and the anti-skew gate that
 * is the whole reason it is generated rather than written.
 *
 * The issue's requirement is that the client's addressing and the declarable
 * types come out of the same codegen pass "so types and client cannot skew".
 * Generating them together is the mechanism; this file is the proof, and it is
 * what would fail if someone later added a resource to one artifact and not the
 * other.
 */

import { describe, test, expect } from "vitest";
import { createRequire } from "module";
import { addressableEntityTypes, deriveOperation, operationFor, operationTable, pluralizeKind } from "./operation-surface";

const require = createRequire(import.meta.url);

interface RegistryEntry {
  resourceType: string;
  kind: "resource" | "property";
  apiVersion?: string;
  gvkKind?: string;
}

const registry = require("../generated/lexicon-k8s.json") as Record<string, RegistryEntry>;

describe("operation surface ↔ declarable registry (the anti-skew gate)", () => {
  test("every registry resource with a GVK has an operation entry saying the same thing", () => {
    const table = operationTable();
    const missing: string[] = [];
    const disagreeing: string[] = [];

    for (const entry of Object.values(registry)) {
      if (entry.kind !== "resource" || !entry.apiVersion || !entry.gvkKind) continue;
      const operation = table[entry.resourceType];
      if (!operation) {
        missing.push(entry.resourceType);
        continue;
      }
      if (operation.apiVersion !== entry.apiVersion || operation.kind !== entry.gvkKind) {
        disagreeing.push(
          `${entry.resourceType}: registry ${entry.apiVersion}/${entry.gvkKind} vs operations ${operation.apiVersion}/${operation.kind}`,
        );
      }
    }

    expect(missing, "resources the serializer can emit but the client cannot address").toEqual([]);
    expect(disagreeing, "resources the serializer and the client disagree about").toEqual([]);
  });

  test("no operation entry names a type the registry does not carry", () => {
    const known = new Set(Object.values(registry).map((e) => e.resourceType));
    const orphans = addressableEntityTypes().filter((t) => !known.has(t));
    expect(orphans, "operation entries with no declarable type behind them").toEqual([]);
  });

  test("coverage is an order of magnitude past the twenty-entry map it replaces", () => {
    // The retired KUBECTL_RESOURCE had 20 entries and every CRD fell off it.
    expect(addressableEntityTypes().length).toBeGreaterThan(150);
  });
});

describe("addressing", () => {
  test.each([
    ["K8s::Apps::Deployment", "apps/v1", "Deployment", "deployments", "Namespaced"],
    ["K8s::Core::Pod", "v1", "Pod", "pods", "Namespaced"],
    ["K8s::Core::Namespace", "v1", "Namespace", "namespaces", "Cluster"],
    ["K8s::Rbac::ClusterRole", "rbac.authorization.k8s.io/v1", "ClusterRole", "clusterroles", "Cluster"],
    ["K8s::Networking::Ingress", "networking.k8s.io/v1", "Ingress", "ingresses", "Namespaced"],
    ["K8s::Batch::CronJob", "batch/v1", "CronJob", "cronjobs", "Namespaced"],
  ])("%s → %s %s /%s (%s)", (entityType, apiVersion, kind, plural, scope) => {
    expect(operationFor(entityType)).toMatchObject({ apiVersion, kind, plural, scope });
  });

  // Every one of these was `unsupported-kind` before #1074.
  test.each([
    ["K8s::Ray::RayCluster", "ray.io/v1", "RayCluster", "rayclusters"],
    ["K8s::Argo::Application", "argoproj.io/v1alpha1", "Application", "applications"],
    ["K8s::CertManager::Certificate", "cert-manager.io/v1", "Certificate", "certificates"],
    ["K8s::Monitoring::ServiceMonitor", "monitoring.coreos.com/v1", "ServiceMonitor", "servicemonitors"],
  ])("CRD %s → %s %s /%s", (entityType, apiVersion, kind, plural) => {
    expect(operationFor(entityType)).toMatchObject({ apiVersion, kind, plural });
  });

  test("the plural and scope come from the schema, not from a guess", () => {
    // `ingresses`, not `ingresss`; `namespaces` cluster-scoped, not namespaced.
    const ingress = operationFor("K8s::Networking::Ingress")!;
    expect(ingress.plural).toBe("ingresses");
    expect(operationFor("K8s::Core::Namespace")!.scope).toBe("Cluster");
    // And verbs are documented rather than assumed.
    expect(ingress.verbs).toContain("get");
  });

  test("an entity type in no known API group is not guessed at", () => {
    expect(operationFor("K8s::NotAGroupChantKnows::Thing")).toBeUndefined();
    expect(operationFor("AWS::S3::Bucket")).toBeUndefined();
    expect(operationFor("nonsense")).toBeUndefined();
  });

  test("derivation covers a checkout with no generated artifacts", () => {
    expect(deriveOperation("K8s::Apps::Deployment")).toMatchObject({ apiVersion: "apps/v1", kind: "Deployment" });
    expect(deriveOperation("K8s::Ray::RayCluster")).toBeUndefined();
  });
});

describe("pluralizeKind", () => {
  test.each([
    ["Deployment", "deployments"],
    ["Ingress", "ingresses"],
    ["NetworkPolicy", "networkpolicies"],
    ["Endpoints", "endpointses"],
    ["Gateway", "gateways"],
  ])("%s → %s", (kind, plural) => {
    expect(pluralizeKind(kind)).toBe(plural);
  });
});
