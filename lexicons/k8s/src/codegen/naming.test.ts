import { describe, test, expect } from "vitest";
import { k8sShortName, type K8sParseResult } from "../spec/parse";
import { NamingStrategy } from "./naming";

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
