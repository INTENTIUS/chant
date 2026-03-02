import { describe, test, expect } from "bun:test";
import { createResource } from "@intentius/chant/runtime";
import type { Declarable } from "@intentius/chant/declarable";
import type { SerializerResult } from "@intentius/chant/serializer";
import { helmSerializer } from "../../src/serializer";
import { Chart, Values } from "../../src/resources";

const Deployment = createResource("K8s::Apps::Deployment", "k8s", {});
const Service = createResource("K8s::Core::Service", "k8s", {});
const ServiceAccount = createResource("K8s::Core::ServiceAccount", "k8s", {});
const ConfigMap = createResource("K8s::Core::ConfigMap", "k8s", {});
const Ingress = createResource("K8s::Networking::Ingress", "k8s", {});
const HPA = createResource("K8s::Autoscaling::HorizontalPodAutoscaler", "k8s", {});
const PDB = createResource("K8s::Policy::PodDisruptionBudget", "k8s", {});

import { chart, values, deployment, service, serviceAccount, configMap, ingress, hpa, pdb } from "./src/infra";

function makeEntities(...pairs: [string, Record<string, unknown>][]): Map<string, Declarable> {
  const m = new Map<string, Declarable>();
  for (const [name, entity] of pairs) m.set(name, entity as unknown as Declarable);
  return m;
}

describe("helm microservice-chart", () => {
  test("serializes to valid Helm chart with all resources", () => {
    const entities = makeEntities(
      ["chart", new Chart(chart)],
      ["values", new Values(values)],
      ["deployment", new Deployment(deployment)],
      ["service", new Service(service)],
      ["serviceAccount", new ServiceAccount(serviceAccount)],
    );
    if (configMap) entities.set("configMap", new ConfigMap(configMap) as unknown as Declarable);
    if (ingress) entities.set("ingress", new Ingress(ingress) as unknown as Declarable);
    if (hpa) entities.set("hpa", new HPA(hpa) as unknown as Declarable);
    if (pdb) entities.set("pdb", new PDB(pdb) as unknown as Declarable);

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
      ["chart", new Chart(chart)],
      ["values", new Values(values)],
      ["deployment", new Deployment(deployment)],
      ["service", new Service(service)],
      ["serviceAccount", new ServiceAccount(serviceAccount)],
    );
    if (pdb) entities.set("pdb", new PDB(pdb) as unknown as Declarable);
    if (hpa) entities.set("hpa", new HPA(hpa) as unknown as Declarable);

    const result = helmSerializer.serialize(entities) as SerializerResult;
    expect(result.files!["templates/pdb.yaml"]).toBeDefined();
    expect(result.files!["templates/hpa.yaml"]).toBeDefined();
  });

  test("values contain resource limits", () => {
    const entities = makeEntities(
      ["chart", new Chart(chart)],
      ["values", new Values(values)],
      ["deployment", new Deployment(deployment)],
      ["service", new Service(service)],
      ["serviceAccount", new ServiceAccount(serviceAccount)],
    );

    const result = helmSerializer.serialize(entities) as SerializerResult;
    const valuesYaml = result.files!["values.yaml"]!;
    expect(valuesYaml).toContain("cpu: '500m'");
    expect(valuesYaml).toContain("memory: '256Mi'");
  });
});
