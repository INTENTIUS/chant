import { describe, test, expect } from "vitest";
import type { Declarable } from "@intentius/chant/declarable";
import type { SerializerResult } from "@intentius/chant/serializer";
import { helmSerializer } from "../../src/serializer";

function makeEntities(...pairs: [string, Declarable][]): Map<string, Declarable> {
  const m = new Map<string, Declarable>();
  for (const [name, entity] of pairs) m.set(name, entity);
  return m;
}

import { chart as hwChart, values as hwValues, deployment as hwDeployment, service as hwService, serviceAccount as hwSa, ingress as hwIngress, hpa as hwHpa } from "./src/hardened-web-app";
import { chart as bmChart, values as bmValues, job as bmJob, serviceAccount as bmSa, role as bmRole, roleBinding as bmRoleBinding } from "./src/batch-migration";
import { chart as maChart, values as maValues, deployment as maDeployment, service as maService, serviceAccount as maSa, serviceMonitor as maServiceMonitor, prometheusRule as maPrometheusRule } from "./src/monitored-api";
import { chart as csChart, values as csValues, cronJob as csCronJob, serviceAccount as csSa } from "./src/cron-secured";

describe("helm composites-production: hardened-web-app", () => {
  test("serializes with security context", () => {
    const entities = makeEntities(
      ["chart", hwChart],
      ["values", hwValues],
      ["deployment", hwDeployment],
      ["service", hwService],
    );
    if (hwSa) entities.set("serviceAccount", hwSa as unknown as Declarable);
    if (hwIngress) entities.set("ingress", hwIngress as unknown as Declarable);
    if (hwHpa) entities.set("hpa", hwHpa as unknown as Declarable);

    const result = helmSerializer.serialize(entities) as SerializerResult;
    expect(result.files!["Chart.yaml"]).toContain("name: secure-frontend");
    expect(result.files!["values.yaml"]).toContain("runAsNonRoot: true");
    expect(result.files!["values.yaml"]).toContain("readOnlyRootFilesystem: true");
    expect(result.files!["templates/deployment.yaml"]).toBeDefined();
  });
});

describe("helm composites-production: batch-migration", () => {
  test("serializes with RBAC", () => {
    const entities = makeEntities(
      ["chart", bmChart],
      ["values", bmValues],
      ["job", bmJob],
    );
    if (bmSa) entities.set("serviceAccount", bmSa as unknown as Declarable);
    if (bmRole) entities.set("role", bmRole as unknown as Declarable);
    if (bmRoleBinding) entities.set("roleBinding", bmRoleBinding as unknown as Declarable);

    const result = helmSerializer.serialize(entities) as SerializerResult;
    expect(result.files!["Chart.yaml"]).toContain("name: db-migration");
    expect(result.files!["templates/job.yaml"]).toBeDefined();
    expect(result.files!["templates/role.yaml"]).toBeDefined();
    expect(result.files!["templates/role-binding.yaml"]).toBeDefined();
  });
});

describe("helm composites-production: monitored-api", () => {
  test("serializes with ServiceMonitor and PrometheusRule", () => {
    const entities = makeEntities(
      ["chart", maChart],
      ["values", maValues],
      ["deployment", maDeployment],
      ["service", maService],
    );
    if (maSa) entities.set("serviceAccount", maSa as unknown as Declarable);
    // ServiceMonitor and PrometheusRule are wrapped in If() conditionals by the composite.
    // Pass them directly as entities — the serializer handles HelmConditional at the entity level.
    if (maServiceMonitor) entities.set("serviceMonitor", maServiceMonitor as unknown as Declarable);
    if (maPrometheusRule) entities.set("prometheusRule", maPrometheusRule as unknown as Declarable);

    const result = helmSerializer.serialize(entities) as SerializerResult;
    expect(result.files!["Chart.yaml"]).toContain("name: payment-api");
    expect(result.files!["templates/deployment.yaml"]).toBeDefined();
    expect(result.files!["templates/service.yaml"]).toBeDefined();
  });
});

describe("helm composites-production: cron-secured", () => {
  test("serializes with security and concurrency", () => {
    const entities = makeEntities(
      ["chart", csChart],
      ["values", csValues],
      ["cronJob", csCronJob],
    );
    if (csSa) entities.set("serviceAccount", csSa as unknown as Declarable);

    const result = helmSerializer.serialize(entities) as SerializerResult;
    expect(result.files!["Chart.yaml"]).toContain("name: report-generator");
    expect(result.files!["values.yaml"]).toContain("runAsNonRoot: true");
    expect(result.files!["templates/cron-job.yaml"]).toBeDefined();
  });
});
