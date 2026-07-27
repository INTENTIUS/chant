import { describe, test, expect } from "vitest";
import type { Declarable } from "@intentius/chant/declarable";
import type { SerializerResult } from "@intentius/chant/serializer";
import { helmSerializer } from "../../src/serializer";

function makeEntities(...pairs: [string, Declarable][]): Map<string, Declarable> {
  const m = new Map<string, Declarable>();
  for (const [name, entity] of pairs) m.set(name, entity);
  return m;
}

import { siChart, siValues, siIngress, siCert } from "./src/secure-ingress";
import { nsChart, nsValues, nsNamespace, nsRQ, nsLR, nsNP } from "./src/namespace-env";
import { dsChart, dsValues, dsDaemonSet, dsSa } from "./src/daemon-set";
import { esChart, esValues, esExternalSecret } from "./src/external-secret";
import { crdChart, crdValues, crdInstallJob, crdConfigMap, crdSa, clusterRole, clusterRoleBinding } from "./src/crd-lifecycle";
import { libChart, libHelpers } from "./src/library-chart";

describe("helm composites-infrastructure: secure-ingress", () => {
  test("serializes with TLS ingress", () => {
    const entities = makeEntities(
      ["chart", siChart],
      ["values", siValues],
      ["ingress", siIngress],
    );
    if (siCert) entities.set("certificate", siCert as unknown as Declarable);

    const result = helmSerializer.serialize(entities) as SerializerResult;
    expect(result.files!["Chart.yaml"]).toContain("name: api-gateway");
    expect(result.files!["templates/ingress.yaml"]).toBeDefined();
  });
});

describe("helm composites-infrastructure: namespace-env", () => {
  test("serializes with governance resources", () => {
    const entities = makeEntities(
      ["chart", nsChart],
      ["values", nsValues],
      ["namespace", nsNamespace],
    );
    if (nsRQ) entities.set("resourceQuota", nsRQ as unknown as Declarable);
    if (nsLR) entities.set("limitRange", nsLR as unknown as Declarable);
    if (nsNP) entities.set("networkPolicy", nsNP as unknown as Declarable);

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
      ["chart", dsChart],
      ["values", dsValues],
      ["daemonSet", dsDaemonSet],
    );
    if (dsSa) entities.set("serviceAccount", dsSa as unknown as Declarable);

    const result = helmSerializer.serialize(entities) as SerializerResult;
    expect(result.files!["Chart.yaml"]).toContain("name: log-collector");
    expect(result.files!["templates/daemon-set.yaml"]).toBeDefined();
  });
});

describe("helm composites-infrastructure: external-secret", () => {
  test("serializes with ExternalSecret CRD", () => {
    const entities = makeEntities(
      ["chart", esChart],
      ["values", esValues],
    );
    entities.set("externalSecret", esExternalSecret as unknown as Declarable);

    const result = helmSerializer.serialize(entities) as SerializerResult;
    expect(result.files!["Chart.yaml"]).toContain("name: app-secrets");
    expect(result.files!["templates/external-secret.yaml"]).toBeDefined();
  });
});

describe("helm composites-infrastructure: crd-lifecycle", () => {
  test("serializes with CRD install job and RBAC", () => {
    const entities = makeEntities(
      ["chart", crdChart],
      ["values", crdValues],
      ["crdInstallJob", crdInstallJob],
      ["crdConfigMap", crdConfigMap],
      ["serviceAccount", crdSa],
      ["clusterRole", clusterRole],
      ["clusterRoleBinding", clusterRoleBinding],
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
      ["chart", libChart],
    );

    const result = helmSerializer.serialize(entities) as SerializerResult;
    expect(result.files!["Chart.yaml"]).toContain("name: common-lib");
    expect(result.files!["Chart.yaml"]).toContain("type: library");
  });
});
