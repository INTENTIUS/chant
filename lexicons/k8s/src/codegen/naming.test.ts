import { join } from "node:path";
import { describe, test, expect } from "vitest";
import { k8sShortName, type K8sParseResult } from "../spec/parse";
import { NamingStrategy, publishedNames } from "./naming";

/**
 * Chant's naming philosophy: 1:1 with the K8s spec.
 * Every priorityName must match the spec Kind exactly.
 *
 * This test guards against interpreted/abbreviated names creeping in
 * (e.g. "RBACSubject" instead of "Subject", "HPABehavior" instead of
 * "HorizontalPodAutoscalerBehavior").
 */

/** Build a minimal K8sParseResult for a given typeName. */
function stubResult(typeName: string): K8sParseResult {
  return {
    resource: {
      typeName,
      properties: [],
      attributes: [],
      apiVersion: "v1",
      kind: k8sShortName(typeName),
    },
    propertyTypes: [],
    enums: [],
  };
}

describe("naming spec fidelity", () => {
  const typeNames = [
    "K8s::Rbac::Subject",
    "K8s::Autoscaling::HorizontalPodAutoscalerBehavior",
    "K8s::Batch::Job",
    "K8s::Core::Pod",
    "K8s::Apps::Deployment",
    "K8s::Core::Container",
    "K8s::Networking::Ingress",
    "K8s::Rbac::PolicyRule",
    "K8s::Rbac::RoleRef",
  ];

  const results = typeNames.map(stubResult);
  const strategy = new NamingStrategy(results);

  test("all priority names match spec Kind (short name)", () => {
    for (const typeName of typeNames) {
      const resolved = strategy.resolve(typeName);
      const specKind = k8sShortName(typeName);
      expect(resolved).toBe(specKind);
    }
  });

  test("no priority name uses abbreviated prefixes", () => {
    const badPrefixes = ["K8s", "RBAC", "HPA"];

    for (const typeName of typeNames) {
      const resolved = strategy.resolve(typeName)!;
      for (const prefix of badPrefixes) {
        expect(resolved.startsWith(prefix)).toBe(false);
      }
    }
  });
});

describe("published names stay with the type that published them (#5551)", () => {
  const resolveAll = (types: string[], reserved?: Record<string, string>) => {
    const naming = new NamingStrategy(types.map(stubResult), reserved);
    return Object.fromEntries(types.map((t) => [t, naming.resolve(t)]));
  };

  test("with the committed snapshot, a new CRD sharing a published kind is prefixed and the published type keeps its name", () => {
    const reserved = publishedNames();
    expect(reserved["K8s::Argo::Application"]).toBe("Application");
    expect(reserved["K8s::CertManager::Certificate"]).toBe("Certificate");

    const types = [
      "K8s::Contoso::Application",
      "K8s::Argo::Application",
      "K8s::CertManager::Certificate",
      "K8s::Fabrikam::Certificate",
    ];
    const names = resolveAll(types, reserved);
    expect(names).toEqual({
      "K8s::Contoso::Application": "ContosoApplication",
      "K8s::Argo::Application": "Application",
      "K8s::CertManager::Certificate": "Certificate",
      "K8s::Fabrikam::Certificate": "FabrikamCertificate",
    });
    expect(resolveAll([...types].reverse(), reserved)).toEqual(names);
  });

  test("without published names, the same input renames the published type, as the rule alone did", () => {
    expect(resolveAll(["K8s::Argo::Application", "K8s::Contoso::Application"])["K8s::Argo::Application"]).toBe(
      "ArgoApplication",
    );
  });

  test("a new CRD whose kind only prefixed published types share is still prefixed", () => {
    const reserved = publishedNames();
    expect(resolveAll(["K8s::Flux::Bucket", "K8s::S3::Bucket", "K8s::Contoso::Bucket"], reserved)).toEqual({
      "K8s::Flux::Bucket": "FluxBucket",
      "K8s::S3::Bucket": "S3Bucket",
      "K8s::Contoso::Bucket": "ContosoBucket",
    });
  });

  test("a type the snapshot lists under its alias keeps its priority name and the alias", () => {
    const naming = new NamingStrategy([stubResult("K8s::Batch::Job")], publishedNames());
    expect(naming.resolve("K8s::Batch::Job")).toBe("Job");
    expect(naming.aliases("K8s::Batch::Job")).toEqual(["BatchJob"]);
  });

  test("a missing snapshot reserves nothing", () => {
    expect(publishedNames(join(import.meta.dirname, "no-such-dir", "surface.snapshot.json"))).toEqual({});
  });
});
