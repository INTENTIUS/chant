import { describe, test, expect } from "vitest";
import { verdictFor, declaredSubsetMatches } from "./verdict";
import type { K8sObject } from "@intentius/chant-k8s-client";
import type { DeclaredMatch } from "./project";
import { fakeDeclarable } from "./testing";

function match(props: Record<string, unknown>): DeclaredMatch {
  return { entityName: "web", entity: fakeDeclarable("K8s::Apps::Deployment", props), props };
}

describe("declaredSubsetMatches", () => {
  test("extra live fields (server defaults, status) are not drift", () => {
    expect(
      declaredSubsetMatches({ spec: { replicas: 2 } }, { spec: { replicas: 2, strategy: "RollingUpdate" }, status: { readyReplicas: 2 } }),
    ).toBe(true);
  });

  test("a declared field the live object disagrees on is drift", () => {
    expect(declaredSubsetMatches({ spec: { replicas: 2 } }, { spec: { replicas: 9 } })).toBe(false);
  });

  test("arrays must match length and every element", () => {
    expect(declaredSubsetMatches({ a: [1, 2] }, { a: [1, 2, 3] })).toBe(false);
    expect(declaredSubsetMatches({ a: [1, 2] }, { a: [1, 2] })).toBe(true);
  });
});

describe("verdictFor", () => {
  test("a matched entity with an agreeing live object is declared", () => {
    const live = { metadata: { name: "web" }, spec: { replicas: 2 } } as unknown as K8sObject;
    expect(verdictFor(live, match({ metadata: { name: "web" }, spec: { replicas: 2 } }))).toBe("declared");
  });

  test("a matched entity whose live spec disagrees is drifted", () => {
    const live = { metadata: { name: "web" }, spec: { replicas: 9 } } as unknown as K8sObject;
    expect(verdictFor(live, match({ metadata: { name: "web" }, spec: { replicas: 2 } }))).toBe("drifted");
  });

  test("no match + chant's marker label is owned", () => {
    const live = { metadata: { name: "x", labels: { "app.kubernetes.io/managed-by": "chant" } } } as unknown as K8sObject;
    expect(verdictFor(live, undefined)).toBe("owned");
  });

  test("no match + no marker is foreign-owned", () => {
    const live = { metadata: { name: "x" } } as unknown as K8sObject;
    expect(verdictFor(live, undefined)).toBe("foreign-owned");
  });
});
