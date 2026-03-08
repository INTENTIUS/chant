import { describe, test, expect } from "bun:test";
import type { Declarable } from "@intentius/chant/declarable";
import type { SerializerResult } from "@intentius/chant/serializer";
import { helmSerializer } from "../../src/serializer";

import { chart, values, deployment, service, ingress, hpa, serviceAccount } from "./src/infra";

function makeEntities(...pairs: [string, Declarable][]): Map<string, Declarable> {
  const m = new Map<string, Declarable>();
  for (const [name, entity] of pairs) m.set(name, entity);
  return m;
}

describe("helm web-app-with-ingress", () => {
  test("serializes to valid Helm chart with ingress", () => {
    const entities = makeEntities(
      ["chart", chart],
      ["values", values],
      ["deployment", deployment],
      ["service", service],
    );
    if (ingress) entities.set("ingress", ingress as unknown as Declarable);
    if (hpa) entities.set("hpa", hpa as unknown as Declarable);
    if (serviceAccount) entities.set("serviceAccount", serviceAccount as unknown as Declarable);

    const result = helmSerializer.serialize(entities) as SerializerResult;
    expect(result.files!["Chart.yaml"]).toContain("name: frontend");
    expect(result.files!["Chart.yaml"]).toContain("appVersion: '2.1.0'");
    expect(result.files!["values.yaml"]).toContain("repository: my-registry.io/frontend");
    expect(result.files!["templates/deployment.yaml"]).toBeDefined();
    expect(result.files!["templates/service.yaml"]).toBeDefined();
    expect(result.files!["templates/ingress.yaml"]).toBeDefined();
    expect(result.files!["templates/hpa.yaml"]).toBeDefined();
  });

  test("values include security context", () => {
    const entities = makeEntities(
      ["chart", chart],
      ["values", values],
      ["deployment", deployment],
      ["service", service],
    );

    const result = helmSerializer.serialize(entities) as SerializerResult;
    expect(result.files!["values.yaml"]).toContain("runAsNonRoot: true");
    expect(result.files!["values.yaml"]).toContain("readOnlyRootFilesystem: true");
  });
});
