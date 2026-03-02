import { describe, test, expect } from "bun:test";
import { createResource } from "@intentius/chant/runtime";
import type { Declarable } from "@intentius/chant/declarable";
import type { SerializerResult } from "@intentius/chant/serializer";
import { helmSerializer } from "../../src/serializer";
import { Chart, Values } from "../../src/resources";

const Deployment = createResource("K8s::Apps::Deployment", "k8s", {});
const Service = createResource("K8s::Core::Service", "k8s", {});
const ServiceAccount = createResource("K8s::Core::ServiceAccount", "k8s", {});
const Ingress = createResource("K8s::Networking::Ingress", "k8s", {});
const HPA = createResource("K8s::Autoscaling::HorizontalPodAutoscaler", "k8s", {});

import { chart, values, deployment, service, ingress, hpa, serviceAccount } from "./src/infra";

function makeEntities(...pairs: [string, Record<string, unknown>][]): Map<string, Declarable> {
  const m = new Map<string, Declarable>();
  for (const [name, entity] of pairs) m.set(name, entity as unknown as Declarable);
  return m;
}

describe("helm web-app-with-ingress", () => {
  test("serializes to valid Helm chart with ingress", () => {
    const entities = makeEntities(
      ["chart", new Chart(chart)],
      ["values", new Values(values)],
      ["deployment", new Deployment(deployment)],
      ["service", new Service(service)],
    );
    if (ingress) entities.set("ingress", new Ingress(ingress) as unknown as Declarable);
    if (hpa) entities.set("hpa", new HPA(hpa) as unknown as Declarable);
    if (serviceAccount) entities.set("serviceAccount", new ServiceAccount(serviceAccount) as unknown as Declarable);

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
      ["chart", new Chart(chart)],
      ["values", new Values(values)],
      ["deployment", new Deployment(deployment)],
      ["service", new Service(service)],
    );

    const result = helmSerializer.serialize(entities) as SerializerResult;
    expect(result.files!["values.yaml"]).toContain("runAsNonRoot: true");
    expect(result.files!["values.yaml"]).toContain("readOnlyRootFilesystem: true");
  });
});
