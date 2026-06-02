import { describe, test, expect } from "vitest";
import { k8sSerializer } from "./serializer";
import { DECLARABLE_MARKER } from "@intentius/chant/declarable";

function mockResource(entityType: string, props: Record<string, unknown>): any {
  return { [DECLARABLE_MARKER]: true, lexicon: "k8s", entityType, kind: "resource", props };
}

describe("k8sSerializer ownership stamping (#119)", () => {
  test("stamps the ownership marker as labels when context.ownership is set", () => {
    const entities = new Map<string, any>([
      ["web", mockResource("K8s::Apps::Deployment", { metadata: { name: "web" }, spec: { replicas: 1 } })],
    ]);
    const yaml = k8sSerializer.serialize(entities, [], { ownership: { stack: "billing", env: "prod" } });
    expect(yaml).toContain("app.kubernetes.io/managed-by: chant");
    expect(yaml).toContain("chant.intentius.io/stack: billing");
    expect(yaml).toContain("chant.intentius.io/env: prod");
  });

  test("explicit resource labels still win over the stamped marker", () => {
    const entities = new Map<string, any>([
      [
        "web",
        mockResource("K8s::Apps::Deployment", {
          metadata: { name: "web", labels: { "app.kubernetes.io/managed-by": "argocd" } },
          spec: { replicas: 1 },
        }),
      ],
    ]);
    const yaml = k8sSerializer.serialize(entities, [], { ownership: { stack: "billing" } });
    expect(yaml).toContain("app.kubernetes.io/managed-by: argocd");
    // stack identity still stamped (no explicit override)
    expect(yaml).toContain("chant.intentius.io/stack: billing");
  });

  test("no ownership context → no chant labels", () => {
    const entities = new Map<string, any>([
      ["web", mockResource("K8s::Apps::Deployment", { metadata: { name: "web" }, spec: { replicas: 1 } })],
    ]);
    const yaml = k8sSerializer.serialize(entities, []);
    expect(yaml).not.toContain("app.kubernetes.io/managed-by: chant");
    expect(yaml).not.toContain("chant.intentius.io/stack");
  });
});
