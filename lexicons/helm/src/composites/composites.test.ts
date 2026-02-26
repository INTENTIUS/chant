import { describe, test, expect } from "bun:test";
import { INTRINSIC_MARKER } from "@intentius/chant/intrinsic";
import { HelmWebApp } from "./helm-web-app";
import { HelmStatefulService } from "./helm-stateful-service";
import { HelmCronJob } from "./helm-cron-job";
import { HelmMicroservice } from "./helm-microservice";
import { HelmLibrary } from "./helm-library";

function hasIntrinsic(obj: unknown): boolean {
  if (obj && typeof obj === "object" && INTRINSIC_MARKER in (obj as any)) return true;
  if (obj && typeof obj === "object") {
    for (const v of Object.values(obj as Record<string, unknown>)) {
      if (hasIntrinsic(v)) return true;
    }
  }
  if (Array.isArray(obj)) {
    for (const v of obj) {
      if (hasIntrinsic(v)) return true;
    }
  }
  return false;
}

describe("HelmWebApp", () => {
  test("returns chart, values, deployment, and service", () => {
    const result = HelmWebApp({ name: "my-app" });
    expect(result.chart).toBeDefined();
    expect(result.values).toBeDefined();
    expect(result.deployment).toBeDefined();
    expect(result.service).toBeDefined();
  });

  test("chart has correct metadata", () => {
    const result = HelmWebApp({ name: "web-ui" });
    expect(result.chart.name).toBe("web-ui");
    expect(result.chart.apiVersion).toBe("v2");
    expect(result.chart.type).toBe("application");
  });

  test("values include default image and service config", () => {
    const result = HelmWebApp({ name: "app" });
    const vals = result.values as any;
    expect(vals.image.repository).toBe("nginx");
    expect(vals.service.port).toBe(80);
    expect(vals.replicaCount).toBe(1);
  });

  test("custom props flow through to values", () => {
    const result = HelmWebApp({
      name: "api",
      imageRepository: "myregistry/api",
      port: 3000,
      replicas: 3,
    });
    const vals = result.values as any;
    expect(vals.image.repository).toBe("myregistry/api");
    expect(vals.service.port).toBe(3000);
    expect(vals.replicaCount).toBe(3);
  });

  test("includes ingress, hpa, and serviceAccount by default", () => {
    const result = HelmWebApp({ name: "app" });
    expect(result.ingress).toBeDefined();
    expect(result.hpa).toBeDefined();
    expect(result.serviceAccount).toBeDefined();
  });

  test("can exclude optional resources", () => {
    const result = HelmWebApp({ name: "app", ingress: false, autoscaling: false, serviceAccount: false });
    expect(result.ingress).toBeUndefined();
    expect(result.hpa).toBeUndefined();
    expect(result.serviceAccount).toBeUndefined();
  });

  test("deployment uses Helm intrinsics", () => {
    const result = HelmWebApp({ name: "app" });
    expect(hasIntrinsic(result.deployment)).toBe(true);
  });
});

describe("HelmStatefulService", () => {
  test("returns chart, values, statefulSet, and service", () => {
    const result = HelmStatefulService({ name: "db" });
    expect(result.chart).toBeDefined();
    expect(result.values).toBeDefined();
    expect(result.statefulSet).toBeDefined();
    expect(result.service).toBeDefined();
  });

  test("chart is marked as application", () => {
    const result = HelmStatefulService({ name: "db" });
    expect(result.chart.type).toBe("application");
  });

  test("service is headless (clusterIP: None)", () => {
    const result = HelmStatefulService({ name: "db" });
    expect((result.service as any).spec.clusterIP).toBe("None");
  });

  test("statefulSet has volumeClaimTemplates", () => {
    const result = HelmStatefulService({ name: "db" });
    const spec = (result.statefulSet as any).spec;
    expect(spec.volumeClaimTemplates).toBeDefined();
    expect(spec.volumeClaimTemplates).toHaveLength(1);
  });

  test("values include persistence config", () => {
    const result = HelmStatefulService({ name: "db", storageSize: "50Gi" });
    const vals = result.values as any;
    expect(vals.persistence.size).toBe("50Gi");
  });

  test("uses Helm intrinsics", () => {
    const result = HelmStatefulService({ name: "db" });
    expect(hasIntrinsic(result.statefulSet)).toBe(true);
  });
});

describe("HelmCronJob", () => {
  test("returns chart, values, and cronJob", () => {
    const result = HelmCronJob({ name: "cleanup" });
    expect(result.chart).toBeDefined();
    expect(result.values).toBeDefined();
    expect(result.cronJob).toBeDefined();
  });

  test("chart has correct name", () => {
    const result = HelmCronJob({ name: "backup" });
    expect(result.chart.name).toBe("backup");
  });

  test("default schedule is hourly", () => {
    const result = HelmCronJob({ name: "job" });
    const vals = result.values as any;
    expect(vals.schedule).toBe("0 * * * *");
  });

  test("custom schedule flows through", () => {
    const result = HelmCronJob({ name: "nightly", schedule: "0 0 * * *" });
    const vals = result.values as any;
    expect(vals.schedule).toBe("0 0 * * *");
  });

  test("uses Helm intrinsics", () => {
    const result = HelmCronJob({ name: "job" });
    expect(hasIntrinsic(result.cronJob)).toBe(true);
  });
});

describe("HelmMicroservice", () => {
  test("returns all core resources", () => {
    const result = HelmMicroservice({ name: "api" });
    expect(result.chart).toBeDefined();
    expect(result.values).toBeDefined();
    expect(result.deployment).toBeDefined();
    expect(result.service).toBeDefined();
    expect(result.serviceAccount).toBeDefined();
  });

  test("includes optional resources by default", () => {
    const result = HelmMicroservice({ name: "api" });
    expect(result.configMap).toBeDefined();
    expect(result.ingress).toBeDefined();
    expect(result.hpa).toBeDefined();
    expect(result.pdb).toBeDefined();
  });

  test("can exclude optional resources", () => {
    const result = HelmMicroservice({
      name: "api",
      ingress: false,
      autoscaling: false,
      pdb: false,
      configMap: false,
    });
    expect(result.configMap).toBeUndefined();
    expect(result.ingress).toBeUndefined();
    expect(result.hpa).toBeUndefined();
    expect(result.pdb).toBeUndefined();
  });

  test("default port is 8080", () => {
    const result = HelmMicroservice({ name: "api" });
    const vals = result.values as any;
    expect(vals.service.port).toBe(8080);
  });

  test("default replicas is 2", () => {
    const result = HelmMicroservice({ name: "api" });
    const vals = result.values as any;
    expect(vals.replicaCount).toBe(2);
  });

  test("values include health probes", () => {
    const result = HelmMicroservice({ name: "api" });
    const vals = result.values as any;
    expect(vals.livenessProbe).toBeDefined();
    expect(vals.readinessProbe).toBeDefined();
  });

  test("values include resource limits and requests", () => {
    const result = HelmMicroservice({ name: "api" });
    const vals = result.values as any;
    expect(vals.resources.limits).toBeDefined();
    expect(vals.resources.requests).toBeDefined();
  });

  test("uses Helm intrinsics", () => {
    const result = HelmMicroservice({ name: "api" });
    expect(hasIntrinsic(result.deployment)).toBe(true);
  });
});

describe("HelmLibrary", () => {
  test("returns chart and helpers", () => {
    const result = HelmLibrary({ name: "common" });
    expect(result.chart).toBeDefined();
    expect(result.helpers).toBeDefined();
  });

  test("chart type is library", () => {
    const result = HelmLibrary({ name: "common" });
    expect(result.chart.type).toBe("library");
  });

  test("default helpers include standard names", () => {
    const result = HelmLibrary({ name: "common" });
    expect(result.helpers).toContain("name");
    expect(result.helpers).toContain("fullname");
    expect(result.helpers).toContain("labels");
  });

  test("custom helpers override defaults", () => {
    const result = HelmLibrary({ name: "lib", helpers: ["custom-a", "custom-b"] });
    expect(result.helpers).toEqual(["custom-a", "custom-b"]);
  });

  test("dependencies are included when provided", () => {
    const result = HelmLibrary({
      name: "common",
      dependencies: [{ name: "base", version: "1.x.x", repository: "https://charts.example.com" }],
    });
    expect(result.chart.dependencies).toHaveLength(1);
  });

  test("no dependencies by default", () => {
    const result = HelmLibrary({ name: "common" });
    expect(result.chart.dependencies).toBeUndefined();
  });
});
