import { describe, test, expect } from "bun:test";
import type { Declarable } from "@intentius/chant/declarable";
import type { SerializerResult } from "@intentius/chant/serializer";
import { helmSerializer } from "../../src/serializer";

import { chart, values, deployment, service, serviceAccount, configMap, ingress, hpa, pdb } from "./src/infra";

function makeEntities(...pairs: [string, Declarable][]): Map<string, Declarable> {
  const m = new Map<string, Declarable>();
  for (const [name, entity] of pairs) m.set(name, entity);
  return m;
}

describe("helm microservice-chart", () => {
  test("serializes to valid Helm chart with all resources", () => {
    const entities = makeEntities(
      ["chart", chart],
      ["values", values],
      ["deployment", deployment],
      ["service", service],
      ["serviceAccount", serviceAccount],
    );
    if (configMap) entities.set("configMap", configMap as unknown as Declarable);
    if (ingress) entities.set("ingress", ingress as unknown as Declarable);
    if (hpa) entities.set("hpa", hpa as unknown as Declarable);
    if (pdb) entities.set("pdb", pdb as unknown as Declarable);

    const result = helmSerializer.serialize(entities) as SerializerResult;
    expect(result.files!["Chart.yaml"]).toContain("name: payment-api");
    expect(result.files!["Chart.yaml"]).toContain("appVersion: '1.4.2'");
    expect(result.files!["values.yaml"]).toContain("repository: my-registry.io/payment-api");
    expect(result.files!["templates/deployment.yaml"]).toBeDefined();
    expect(result.files!["templates/service.yaml"]).toBeDefined();
    expect(result.files!["templates/service-account.yaml"]).toBeDefined();
    expect(result.files!["templates/config-map.yaml"]).toBeDefined();
  });

  test("includes PDB and HPA", () => {
    const entities = makeEntities(
      ["chart", chart],
      ["values", values],
      ["deployment", deployment],
      ["service", service],
      ["serviceAccount", serviceAccount],
    );
    if (pdb) entities.set("pdb", pdb as unknown as Declarable);
    if (hpa) entities.set("hpa", hpa as unknown as Declarable);

    const result = helmSerializer.serialize(entities) as SerializerResult;
    expect(result.files!["templates/pdb.yaml"]).toBeDefined();
    expect(result.files!["templates/hpa.yaml"]).toBeDefined();
  });

  test("values contain resource limits", () => {
    const entities = makeEntities(
      ["chart", chart],
      ["values", values],
      ["deployment", deployment],
      ["service", service],
      ["serviceAccount", serviceAccount],
    );

    const result = helmSerializer.serialize(entities) as SerializerResult;
    const valuesYaml = result.files!["values.yaml"]!;
    expect(valuesYaml).toContain("cpu: '500m'");
    expect(valuesYaml).toContain("memory: '256Mi'");
  });
});
