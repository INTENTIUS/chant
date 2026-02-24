import { describe, test, expect } from "bun:test";
import {
  parseK8sManifests,
  extractContainers,
  extractPodSpec,
  WORKLOAD_KINDS,
} from "./k8s-helpers";

describe("parseK8sManifests", () => {
  test("splits multi-doc YAML", () => {
    const yaml = `
apiVersion: v1
kind: Service
metadata:
  name: svc
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: deploy
`;
    const manifests = parseK8sManifests(yaml);
    expect(manifests.length).toBe(2);
    expect(manifests[0].kind).toBe("Service");
    expect(manifests[1].kind).toBe("Deployment");
  });

  test("handles single document", () => {
    const yaml = `
apiVersion: v1
kind: ConfigMap
metadata:
  name: config
data:
  key: value
`;
    const manifests = parseK8sManifests(yaml);
    expect(manifests.length).toBe(1);
    expect(manifests[0].kind).toBe("ConfigMap");
  });

  test("handles empty/invalid YAML gracefully", () => {
    expect(parseK8sManifests("")).toEqual([]);
    expect(parseK8sManifests("---")).toEqual([]);
    // "---\n---" doesn't split on /\n---\n/ — the full string is parsed as empty object
    expect(parseK8sManifests("---\n---\n")).toEqual([]);
  });

  test("skips blank documents between separators", () => {
    const yaml = `
apiVersion: v1
kind: Pod
metadata:
  name: p
---

---
apiVersion: v1
kind: Service
metadata:
  name: s
`;
    const manifests = parseK8sManifests(yaml);
    expect(manifests.length).toBe(2);
  });
});

describe("extractContainers", () => {
  test("extracts from Deployment", () => {
    const manifest = {
      kind: "Deployment",
      spec: {
        template: {
          spec: {
            containers: [{ name: "app", image: "nginx" }],
          },
        },
      },
    };
    const containers = extractContainers(manifest);
    expect(containers.length).toBe(1);
    expect(containers[0].name).toBe("app");
  });

  test("extracts from Pod", () => {
    const manifest = {
      kind: "Pod",
      spec: {
        containers: [{ name: "app", image: "nginx" }],
      },
    };
    const containers = extractContainers(manifest);
    expect(containers.length).toBe(1);
  });

  test("extracts from StatefulSet", () => {
    const manifest = {
      kind: "StatefulSet",
      spec: {
        template: {
          spec: {
            containers: [{ name: "db", image: "postgres" }],
          },
        },
      },
    };
    const containers = extractContainers(manifest);
    expect(containers.length).toBe(1);
  });

  test("extracts from DaemonSet", () => {
    const manifest = {
      kind: "DaemonSet",
      spec: {
        template: {
          spec: {
            containers: [{ name: "agent", image: "fluentd" }],
          },
        },
      },
    };
    const containers = extractContainers(manifest);
    expect(containers.length).toBe(1);
  });

  test("extracts from Job", () => {
    const manifest = {
      kind: "Job",
      spec: {
        template: {
          spec: {
            containers: [{ name: "worker", image: "job:1.0" }],
          },
        },
      },
    };
    const containers = extractContainers(manifest);
    expect(containers.length).toBe(1);
  });

  test("extracts from CronJob", () => {
    const manifest = {
      kind: "CronJob",
      spec: {
        jobTemplate: {
          spec: {
            template: {
              spec: {
                containers: [{ name: "cron", image: "cron:1.0" }],
              },
            },
          },
        },
      },
    };
    const containers = extractContainers(manifest);
    expect(containers.length).toBe(1);
  });

  test("includes init containers", () => {
    const manifest = {
      kind: "Deployment",
      spec: {
        template: {
          spec: {
            containers: [{ name: "app", image: "nginx" }],
            initContainers: [{ name: "init", image: "busybox" }],
          },
        },
      },
    };
    const containers = extractContainers(manifest);
    expect(containers.length).toBe(2);
  });

  test("returns empty for non-workload types", () => {
    const manifest = { kind: "ConfigMap", data: {} };
    const containers = extractContainers(manifest);
    expect(containers.length).toBe(0);
  });
});

describe("extractPodSpec", () => {
  test("returns spec for Pod", () => {
    const manifest = {
      kind: "Pod",
      spec: { containers: [{ name: "app" }] },
    };
    const podSpec = extractPodSpec(manifest);
    expect(podSpec).toBeDefined();
    expect(podSpec!.containers).toBeDefined();
  });

  test("returns null for ConfigMap", () => {
    const manifest = { kind: "ConfigMap", data: {} };
    expect(extractPodSpec(manifest)).toBeNull();
  });

  test("returns null when no spec", () => {
    const manifest = { kind: "Deployment" };
    expect(extractPodSpec(manifest)).toBeNull();
  });
});

describe("WORKLOAD_KINDS", () => {
  test("includes all expected kinds", () => {
    expect(WORKLOAD_KINDS.has("Pod")).toBe(true);
    expect(WORKLOAD_KINDS.has("Deployment")).toBe(true);
    expect(WORKLOAD_KINDS.has("StatefulSet")).toBe(true);
    expect(WORKLOAD_KINDS.has("DaemonSet")).toBe(true);
    expect(WORKLOAD_KINDS.has("Job")).toBe(true);
    expect(WORKLOAD_KINDS.has("CronJob")).toBe(true);
  });

  test("does not include non-workload kinds", () => {
    expect(WORKLOAD_KINDS.has("Service")).toBe(false);
    expect(WORKLOAD_KINDS.has("ConfigMap")).toBe(false);
  });
});
