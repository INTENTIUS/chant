import { describe, test, expect } from "vitest";
import type { Declarable } from "@intentius/chant/declarable";
import type { SerializerResult } from "@intentius/chant/serializer";
import { helmSerializer } from "../../src/serializer";

function makeEntities(...pairs: [string, Declarable][]): Map<string, Declarable> {
  const m = new Map<string, Declarable>();
  for (const [name, entity] of pairs) m.set(name, entity);
  return m;
}

// Import composite results from source files
import { chart as webChart, values as webValues, deployment as webDeployment, service as webService, ingress as webIngress, hpa as webHpa, serviceAccount as webSa } from "./src/web-app";
import { chart as msChart, values as msValues, deployment as msDeployment, service as msService, serviceAccount as msSa, configMap as msConfigMap, ingress as msIngress, hpa as msHpa, pdb as msPdb } from "./src/microservice";
import { chart as ssChart, values as ssValues, statefulSet as ssStatefulSet, service as ssService } from "./src/stateful-service";
import { chart as cronChart, values as cronValues, cronJob } from "./src/cron-job";
import { chart as wkChart, values as wkValues, deployment as wkDeployment, serviceAccount as wkSa, hpa as wkHpa, pdb as wkPdb } from "./src/worker";

describe("helm composites-basic: web-app", () => {
  test("serializes to valid Helm chart", () => {
    const entities = makeEntities(
      ["chart", webChart],
      ["values", webValues],
      ["deployment", webDeployment],
      ["service", webService],
    );
    if (webIngress) entities.set("ingress", webIngress as unknown as Declarable);
    if (webHpa) entities.set("hpa", webHpa as unknown as Declarable);
    if (webSa) entities.set("serviceAccount", webSa as unknown as Declarable);

    const result = helmSerializer.serialize(entities) as SerializerResult;
    expect(result.files!["Chart.yaml"]).toContain("name: my-web-app");
    expect(result.files!["values.yaml"]).toBeDefined();
    expect(result.files!["templates/deployment.yaml"]).toBeDefined();
    expect(result.files!["templates/service.yaml"]).toBeDefined();
  });
});

describe("helm composites-basic: microservice", () => {
  test("serializes to valid Helm chart", () => {
    const entities = makeEntities(
      ["chart", msChart],
      ["values", msValues],
      ["deployment", msDeployment],
      ["service", msService],
      ["serviceAccount", msSa],
    );
    if (msConfigMap) entities.set("configMap", msConfigMap as unknown as Declarable);
    if (msIngress) entities.set("ingress", msIngress as unknown as Declarable);
    if (msHpa) entities.set("hpa", msHpa as unknown as Declarable);
    if (msPdb) entities.set("pdb", msPdb as unknown as Declarable);

    const result = helmSerializer.serialize(entities) as SerializerResult;
    expect(result.files!["Chart.yaml"]).toContain("name: order-api");
    expect(result.files!["templates/deployment.yaml"]).toBeDefined();
    expect(result.files!["templates/service.yaml"]).toBeDefined();
  });
});

describe("helm composites-basic: stateful-service", () => {
  test("serializes to valid Helm chart", () => {
    const entities = makeEntities(
      ["chart", ssChart],
      ["values", ssValues],
      ["statefulSet", ssStatefulSet],
      ["service", ssService],
    );

    const result = helmSerializer.serialize(entities) as SerializerResult;
    expect(result.files!["Chart.yaml"]).toContain("name: postgres");
    expect(result.files!["templates/stateful-set.yaml"]).toBeDefined();
    expect(result.files!["templates/service.yaml"]).toBeDefined();
  });
});

describe("helm composites-basic: cron-job", () => {
  test("serializes to valid Helm chart", () => {
    const entities = makeEntities(
      ["chart", cronChart],
      ["values", cronValues],
      ["cronJob", cronJob],
    );

    const result = helmSerializer.serialize(entities) as SerializerResult;
    expect(result.files!["Chart.yaml"]).toContain("name: nightly-cleanup");
    expect(result.files!["templates/cron-job.yaml"]).toBeDefined();
  });
});

describe("helm composites-basic: worker", () => {
  test("serializes to valid Helm chart with autoscaling", () => {
    const entities = makeEntities(
      ["chart", wkChart],
      ["values", wkValues],
      ["deployment", wkDeployment],
      ["serviceAccount", wkSa],
    );
    if (wkHpa) entities.set("hpa", wkHpa as unknown as Declarable);
    if (wkPdb) entities.set("pdb", wkPdb as unknown as Declarable);

    const result = helmSerializer.serialize(entities) as SerializerResult;
    expect(result.files!["Chart.yaml"]).toContain("name: queue-processor");
    expect(result.files!["templates/deployment.yaml"]).toBeDefined();
    expect(result.files!["templates/hpa.yaml"]).toBeDefined();
  });
});
