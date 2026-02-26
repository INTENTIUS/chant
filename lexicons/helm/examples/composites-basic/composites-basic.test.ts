import { describe, test, expect } from "bun:test";
import { createResource } from "@intentius/chant/runtime";
import type { Declarable } from "@intentius/chant/declarable";
import type { SerializerResult } from "@intentius/chant/serializer";
import { helmSerializer } from "../../src/serializer";
import { Chart, Values } from "../../src/resources";

// K8s resource constructors (matching serializer.test.ts pattern)
const Deployment = createResource("K8s::Apps::Deployment", "k8s", {});
const StatefulSet = createResource("K8s::Apps::StatefulSet", "k8s", {});
const Service = createResource("K8s::Core::Service", "k8s", {});
const ServiceAccount = createResource("K8s::Core::ServiceAccount", "k8s", {});
const CronJob = createResource("K8s::Batch::CronJob", "k8s", {});
const HPA = createResource("K8s::Autoscaling::HorizontalPodAutoscaler", "k8s", {});
const PDB = createResource("K8s::Policy::PodDisruptionBudget", "k8s", {});
const ConfigMap = createResource("K8s::Core::ConfigMap", "k8s", {});
const Ingress = createResource("K8s::Networking::Ingress", "k8s", {});

function makeEntities(...pairs: [string, Record<string, unknown>][]): Map<string, Declarable> {
  const m = new Map<string, Declarable>();
  for (const [name, entity] of pairs) m.set(name, entity as unknown as Declarable);
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
      ["chart", new Chart(webChart)],
      ["values", new Values(webValues)],
      ["deployment", new Deployment(webDeployment)],
      ["service", new Service(webService)],
    );
    if (webIngress) entities.set("ingress", new Ingress(webIngress) as unknown as Declarable);
    if (webHpa) entities.set("hpa", new HPA(webHpa) as unknown as Declarable);
    if (webSa) entities.set("serviceAccount", new ServiceAccount(webSa) as unknown as Declarable);

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
      ["chart", new Chart(msChart)],
      ["values", new Values(msValues)],
      ["deployment", new Deployment(msDeployment)],
      ["service", new Service(msService)],
      ["serviceAccount", new ServiceAccount(msSa)],
    );
    if (msConfigMap) entities.set("configMap", new ConfigMap(msConfigMap) as unknown as Declarable);
    if (msIngress) entities.set("ingress", new Ingress(msIngress) as unknown as Declarable);
    if (msHpa) entities.set("hpa", new HPA(msHpa) as unknown as Declarable);
    if (msPdb) entities.set("pdb", new PDB(msPdb) as unknown as Declarable);

    const result = helmSerializer.serialize(entities) as SerializerResult;
    expect(result.files!["Chart.yaml"]).toContain("name: order-api");
    expect(result.files!["templates/deployment.yaml"]).toBeDefined();
    expect(result.files!["templates/service.yaml"]).toBeDefined();
  });
});

describe("helm composites-basic: stateful-service", () => {
  test("serializes to valid Helm chart", () => {
    const entities = makeEntities(
      ["chart", new Chart(ssChart)],
      ["values", new Values(ssValues)],
      ["statefulSet", new StatefulSet(ssStatefulSet)],
      ["service", new Service(ssService)],
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
      ["chart", new Chart(cronChart)],
      ["values", new Values(cronValues)],
      ["cronJob", new CronJob(cronJob)],
    );

    const result = helmSerializer.serialize(entities) as SerializerResult;
    expect(result.files!["Chart.yaml"]).toContain("name: nightly-cleanup");
    expect(result.files!["templates/cron-job.yaml"]).toBeDefined();
  });
});

describe("helm composites-basic: worker", () => {
  test("serializes to valid Helm chart with autoscaling", () => {
    const entities = makeEntities(
      ["chart", new Chart(wkChart)],
      ["values", new Values(wkValues)],
      ["deployment", new Deployment(wkDeployment)],
      ["serviceAccount", new ServiceAccount(wkSa)],
    );
    if (wkHpa) entities.set("hpa", new HPA(wkHpa) as unknown as Declarable);
    if (wkPdb) entities.set("pdb", new PDB(wkPdb) as unknown as Declarable);

    const result = helmSerializer.serialize(entities) as SerializerResult;
    expect(result.files!["Chart.yaml"]).toContain("name: queue-processor");
    expect(result.files!["templates/deployment.yaml"]).toBeDefined();
    expect(result.files!["templates/hpa.yaml"]).toBeDefined();
  });
});
