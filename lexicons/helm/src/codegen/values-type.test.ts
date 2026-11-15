import { describe, expect, test } from "vitest";
import yaml from "js-yaml";
import { commentedKeys, inferValuesType, type SubchartValues } from "./values-type";
import { typecheckValues } from "./values-check";

const infer = (text: string, deps?: SubchartValues[], valuesRoot?: string[]) =>
  inferValuesType(yaml.load(text), { text, dependencies: deps, valuesRoot });
const fits = (type: string, values: unknown) => typecheckValues(type, values);

describe("open maps", () => {
  const type = infer(`
nodeSelector:
  kubernetes.io/os: linux
podLabels:
  app: web
serviceAccount:
  annotations:
    team: infra
resources:
  limits:
    cpu: 100m
    memory: 128Mi
  requests:
    cpu: 100m
`);
  test("a map Kubernetes lets take any key takes any key", () => {
    expect(fits(type, { nodeSelector: { role: "build", "kubernetes.io/arch": "amd64" } })).toEqual([]);
    expect(fits(type, { podLabels: { anything: "x" }, serviceAccount: { annotations: { "iam/role": "r" } } })).toEqual([]);
    expect(fits(type, { resources: { limits: { "nvidia.com/gpu": 1, memory: "1Gi" } } })).toEqual([]);
  });

  test("a closed object stays closed, and a map keeps its value type", () => {
    expect(fits(type, { serviceAccount: { annotatons: {} } }).join("\n")).toMatch(/'"annotatons"' does not exist/);
    expect(fits(type, { resources: { limits: { memory: { x: 1 } } } })).not.toEqual([]);
  });

  test("an empty object default is an open map", () => {
    expect(infer("extra: {}\n")).toContain("extra?: Record<string, unknown>;");
  });
});

describe("Kubernetes fragments and free-form settings", () => {
  const type = infer(`
resources:
  requests:
    cpu: 100m
deploymentStrategy:
  type: RollingUpdate
tolerations:
  - key: dedicated
    operator: Exists
grafana.ini:
  analytics:
    check_for_updates: true
meshConfig:
  enablePrometheusMerge: true
image:
  repository: x
`);
  test("a resources block takes limits and requests whichever the default lists", () => {
    expect(fits(type, { resources: { limits: { cpu: 1 }, requests: { memory: "1Gi" } } })).toEqual([]);
  });

  test("API objects a default fills in only in part take the rest of their fields", () => {
    expect(fits(type, { deploymentStrategy: { rollingUpdate: { maxSurge: 1 } }, tolerations: [{ key: "a", effect: "NoSchedule" }] })).toEqual([]);
  });

  test("a settings file embedded in the values takes any key", () => {
    expect(fits(type, { "grafana.ini": { server: { root_url: "x" } }, meshConfig: { accessLogFile: "/dev/stdout" } })).toEqual([]);
  });

  test("other objects stay closed", () => {
    expect(fits(type, { image: { tag: "x" } }).join("\n")).toMatch(/'"tag"' does not exist/);
  });
});

describe("quantities", () => {
  const type = infer(`resources:\n  limits:\n    cpu: 100m\nworker:\n  cpu: 500m\n  memory: 1Gi\npersistence:\n  size: 8Gi\n  name: data\n`);
  test("a quantity takes a number or a string", () => {
    expect(fits(type, { resources: { limits: { cpu: 1 } }, worker: { cpu: 2, memory: "2Gi" }, persistence: { size: 10 } })).toEqual([]);
  });

  test("a number default under a quantity key still takes a string", () => {
    expect(fits(infer("agent:\n  cpu: 1\n"), { agent: { cpu: "250m" } })).toEqual([]);
  });

  test("a string that is not a quantity stays a string", () => {
    expect(fits(type, { persistence: { name: 3 } })).not.toEqual([]);
  });

  test("a boolean is not a quantity", () => {
    expect(fits(type, { worker: { cpu: true } })).not.toEqual([]);
  });
});

describe("commented keys", () => {
  const text = `
config:
  clientID: ""
  # existingSecret: oauth-secret
  ## A prose line: not a key
  # Example: not a key either
persistentVolume:
  enabled: true
  # storageClass: "-"
  # accessModes:
  #   - ReadWriteOnce
# topLevel: 1
extra:
  # ref: https://example.test/docs
  size: 1
`;
  test("a commented key sits in the object it is written in", () => {
    expect(commentedKeys(text)).toEqual([
      { parent: ["config"], key: "existingSecret" },
      { parent: ["persistentVolume"], key: "storageClass" },
      { parent: ["persistentVolume"], key: "accessModes" },
      { parent: [], key: "topLevel" },
    ]);
  });

  test("they are optional members of any type", () => {
    const type = infer(text);
    expect(fits(type, { config: { existingSecret: "s" }, persistentVolume: { storageClass: "fast", accessModes: ["ReadWriteMany"] }, topLevel: [1] })).toEqual([]);
    expect(fits(type, { config: { exisitngSecret: "s" } }).join("\n")).toMatch(/'"exisitngSecret"' does not exist/);
    expect(fits(type, { extra: { ref: "x" } }).join("\n")).toMatch(/'"ref"' does not exist/);
  });

  test("a commented key does not replace a real one", () => {
    expect(infer("a: 1\n# a: x\n")).toContain("a?: number;");
  });
});

describe("subcharts", () => {
  const parent = `grafana:\n  enabled: true\nreplicas: 1\n`;
  const grafana: SubchartValues = {
    name: "grafana",
    condition: "grafana.enabled",
    values: { persistence: { enabled: false }, service: { type: "ClusterIP" } },
  };
  test("a bundled subchart's keys are merged in under its name", () => {
    const type = infer(parent, [grafana]);
    expect(fits(type, { grafana: { persistence: { enabled: true }, service: { type: "NodePort" }, enabled: false } })).toEqual([]);
    expect(fits(type, { grafana: { persistance: {} } }).join("\n")).toMatch(/'"persistance"' does not exist/);
  });

  test("an alias replaces the name", () => {
    const type = infer("", [{ ...grafana, condition: undefined, alias: "dash" }]);
    expect(fits(type, { dash: { persistence: { enabled: true } } })).toEqual([]);
    expect(fits(type, { grafana: {} }).join("\n")).toMatch(/'"grafana"' does not exist/);
  });

  test("a dependency that is not bundled is open, and global is always open", () => {
    const type = infer(parent, [{ name: "grafana" }, { name: "kube-state-metrics" }]);
    expect(fits(type, { grafana: { anything: { at: "all" } }, "kube-state-metrics": { metricLabelsAllowlist: ["a"] } })).toEqual([]);
    expect(fits(type, { global: { imageRegistry: "r" } })).toEqual([]);
  });

  test("a subchart's own subcharts and commented keys come with it", () => {
    const type = infer("", [
      { name: "a", values: { x: 1 }, text: "x: 1\n# y: 2\n", dependencies: [{ name: "b", values: { z: true } }] },
    ]);
    expect(fits(type, { a: { x: 2, y: "any", b: { z: false } } })).toEqual([]);
    expect(fits(type, { a: { b: { zz: 1 } } }).join("\n")).toMatch(/'"zz"' does not exist/);
  });

  test("a chart with no dependencies has no global", () => {
    expect(infer(parent)).not.toContain("global");
  });
});

describe("values root", () => {
  const text = `_internal_defaults_do_not_set:\n  autoscaleEnabled: true\n  global:\n    hub: gcr.io\n    proxy:\n      logLevel: warning\n  pilot:\n    cpu:\n      targetAverageUtilization: 80\n`;
  test("Istio's wrapper is unwrapped without being named", () => {
    const type = infer(text);
    expect(type).not.toContain("_internal_defaults_do_not_set");
    expect(fits(type, { global: { hub: "r", proxy: { logLevel: "debug" } }, autoscaleEnabled: false })).toEqual([]);
    expect(fits(type, { globl: {} }).join("\n")).toMatch(/'"globl"' does not exist/);
  });

  test("a chart can name its own values root", () => {
    const type = infer("defaults:\n  one: 1\n  nested:\n    two: 2\nother: x\n", undefined, ["defaults"]);
    expect(fits(type, { one: 2, nested: { two: 3 }, other: "y" })).toEqual([]);
    expect(fits(type, { defaults: {} })).not.toEqual([]);
  });

  test("a values root path names a nested wrapper", () => {
    const type = infer("a:\n  b:\n    c: 1\n", undefined, ["a.b"]);
    expect(fits(type, { a: { c: 2 } })).toEqual([]);
  });
});
