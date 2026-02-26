import { describe, test, expect } from "bun:test";
import { createResource } from "@intentius/chant/runtime";
import type { Declarable } from "@intentius/chant/declarable";
import type { SerializerResult } from "@intentius/chant/serializer";
import { helmSerializer } from "../../src/serializer";
import { Chart, Values, HelmCRD } from "../../src/resources";

const Ingress = createResource("K8s::Networking::Ingress", "k8s", {});
const Namespace = createResource("K8s::Core::Namespace", "k8s", {});
const ResourceQuota = createResource("K8s::Core::ResourceQuota", "k8s", {});
const LimitRange = createResource("K8s::Core::LimitRange", "k8s", {});
const NetworkPolicy = createResource("K8s::Networking::NetworkPolicy", "k8s", {});
const DaemonSet = createResource("K8s::Apps::DaemonSet", "k8s", {});
const ServiceAccount = createResource("K8s::Core::ServiceAccount", "k8s", {});
const ConfigMap = createResource("K8s::Core::ConfigMap", "k8s", {});
const ClusterRole = createResource("K8s::Rbac::ClusterRole", "k8s", {});
const ClusterRoleBinding = createResource("K8s::Rbac::ClusterRoleBinding", "k8s", {});
const Job = createResource("K8s::Batch::Job", "k8s", {});

function makeEntities(...pairs: [string, Record<string, unknown>][]): Map<string, Declarable> {
  const m = new Map<string, Declarable>();
  for (const [name, entity] of pairs) m.set(name, entity as unknown as Declarable);
  return m;
}

import { chart as siChart, values as siValues, ingress as siIngress, certificate as siCert } from "./src/secure-ingress";
import { chart as nsChart, values as nsValues, namespace as nsNamespace, resourceQuota as nsRQ, limitRange as nsLR, networkPolicy as nsNP } from "./src/namespace-env";
import { chart as dsChart, values as dsValues, daemonSet as dsDaemonSet, serviceAccount as dsSa } from "./src/daemon-set";
import { chart as esChart, values as esValues, externalSecret as esExternalSecret } from "./src/external-secret";
import { chart as crdChart, values as crdValues, crdInstallJob, crdConfigMap, serviceAccount as crdSa, clusterRole, clusterRoleBinding } from "./src/crd-lifecycle";
import { chart as libChart, helpers as libHelpers } from "./src/library-chart";

describe("helm composites-infrastructure: secure-ingress", () => {
  test("serializes with TLS ingress", () => {
    const entities = makeEntities(
      ["chart", new Chart(siChart)],
      ["values", new Values(siValues)],
      ["ingress", new Ingress(siIngress)],
    );
    // Certificate is a CRD — use fallback apiVersion/kind from props
    if (siCert) {
      const Cert = createResource("K8s::CertManager::Certificate", "k8s", {});
      entities.set("certificate", new Cert(siCert) as unknown as Declarable);
    }

    const result = helmSerializer.serialize(entities) as SerializerResult;
    expect(result.files!["Chart.yaml"]).toContain("name: api-gateway");
    expect(result.files!["templates/ingress.yaml"]).toBeDefined();
  });
});

describe("helm composites-infrastructure: namespace-env", () => {
  test("serializes with governance resources", () => {
    const entities = makeEntities(
      ["chart", new Chart(nsChart)],
      ["values", new Values(nsValues)],
      ["namespace", new Namespace(nsNamespace)],
    );
    if (nsRQ) entities.set("resourceQuota", new ResourceQuota(nsRQ) as unknown as Declarable);
    if (nsLR) entities.set("limitRange", new LimitRange(nsLR) as unknown as Declarable);
    if (nsNP) entities.set("networkPolicy", new NetworkPolicy(nsNP) as unknown as Declarable);

    const result = helmSerializer.serialize(entities) as SerializerResult;
    expect(result.files!["Chart.yaml"]).toContain("name: staging");
    expect(result.files!["templates/namespace.yaml"]).toBeDefined();
    expect(result.files!["templates/resource-quota.yaml"]).toBeDefined();
    expect(result.files!["templates/limit-range.yaml"]).toBeDefined();
    expect(result.files!["templates/network-policy.yaml"]).toBeDefined();
  });
});

describe("helm composites-infrastructure: daemon-set", () => {
  test("serializes with host paths", () => {
    const entities = makeEntities(
      ["chart", new Chart(dsChart)],
      ["values", new Values(dsValues)],
      ["daemonSet", new DaemonSet(dsDaemonSet)],
    );
    if (dsSa) entities.set("serviceAccount", new ServiceAccount(dsSa) as unknown as Declarable);

    const result = helmSerializer.serialize(entities) as SerializerResult;
    expect(result.files!["Chart.yaml"]).toContain("name: log-collector");
    expect(result.files!["templates/daemon-set.yaml"]).toBeDefined();
  });
});

describe("helm composites-infrastructure: external-secret", () => {
  test("serializes with ExternalSecret CRD", () => {
    const entities = makeEntities(
      ["chart", new Chart(esChart)],
      ["values", new Values(esValues)],
    );
    // ExternalSecret is a CRD
    const ES = createResource("K8s::ExternalSecrets::ExternalSecret", "k8s", {});
    entities.set("externalSecret", new ES(esExternalSecret) as unknown as Declarable);

    const result = helmSerializer.serialize(entities) as SerializerResult;
    expect(result.files!["Chart.yaml"]).toContain("name: app-secrets");
    expect(result.files!["templates/external-secret.yaml"]).toBeDefined();
  });
});

describe("helm composites-infrastructure: crd-lifecycle", () => {
  test("serializes with CRD install job and RBAC", () => {
    const entities = makeEntities(
      ["chart", new Chart(crdChart)],
      ["values", new Values(crdValues)],
      ["crdInstallJob", new Job(crdInstallJob)],
      ["crdConfigMap", new ConfigMap(crdConfigMap)],
      ["serviceAccount", new ServiceAccount(crdSa)],
      ["clusterRole", new ClusterRole(clusterRole)],
      ["clusterRoleBinding", new ClusterRoleBinding(clusterRoleBinding)],
    );

    const result = helmSerializer.serialize(entities) as SerializerResult;
    expect(result.files!["Chart.yaml"]).toContain("name: cert-manager-crd");
    expect(result.files!["templates/crd-install-job.yaml"]).toBeDefined();
    expect(result.files!["templates/crd-config-map.yaml"]).toBeDefined();
    expect(result.files!["templates/cluster-role.yaml"]).toBeDefined();
  });
});

describe("helm composites-infrastructure: library-chart", () => {
  test("serializes as library chart", () => {
    const entities = makeEntities(
      ["chart", new Chart({ ...libChart, type: "library" })],
    );

    const result = helmSerializer.serialize(entities) as SerializerResult;
    expect(result.files!["Chart.yaml"]).toContain("name: common-lib");
    expect(result.files!["Chart.yaml"]).toContain("type: library");
  });
});
