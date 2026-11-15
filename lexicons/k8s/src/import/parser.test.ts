import { describe, test, expect } from "vitest";
import { K8sParser } from "./parser";

const parser = new K8sParser();

describe("K8sParser", () => {
  test("empty YAML returns empty resources", () => {
    const ir = parser.parse("");
    expect(ir.resources).toEqual([]);
    expect(ir.parameters).toEqual([]);
  });

  test("single Deployment parses correctly", () => {
    const yaml = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
spec:
  replicas: 2
`;
    const ir = parser.parse(yaml);
    expect(ir.resources.length).toBe(1);
    const r = ir.resources[0];
    expect(r.type).toBe("K8s::Apps::Deployment");
    expect(r.logicalId).toBe("deploymentMyApp");
    expect(r.properties.spec).toEqual({ replicas: 2 });
  });

  test("an object name with characters an identifier cannot hold still gives an identifier", () => {
    const names: Array<[string, string, string]> = [
      ["ClusterRole", "system:metrics-server", "clusterRoleSystemMetricsServer"],
      ["Role", "cert-manager-cainjector:leaderelection", "roleCertManagerCainjectorLeaderelection"],
      ["ClusterRoleBinding", "system:kube-scheduler", "clusterRoleBindingSystemKubeScheduler"],
      ["ConfigMap", "a/b@c d", "configMapABCD"],
    ];
    for (const [kind, name, id] of names) {
      const ir = parser.parse(`apiVersion: rbac.authorization.k8s.io/v1\nkind: ${kind}\nmetadata:\n  name: "${name}"\n`);
      expect(ir.resources[0].logicalId).toBe(id);
      expect(ir.resources[0].logicalId).toMatch(/^[A-Za-z_$][A-Za-z0-9_$]*$/);
      expect(ir.resources[0].metadata?.originalName).toBe(name);
    }
  });

  test("multi-doc YAML produces multiple resources", () => {
    const yaml = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
---
apiVersion: v1
kind: Service
metadata:
  name: svc
`;
    const ir = parser.parse(yaml);
    expect(ir.resources.length).toBe(2);
  });

  test("multi-doc YAML splits on commented separators and document ends (#2965)", () => {
    const yaml = `--- # the app
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
...
--- # its service
apiVersion: v1
kind: Service
metadata:
  name: svc
...
`;
    const ir = parser.parse(yaml);
    expect(ir.resources.map((r) => r.type)).toEqual(["K8s::Apps::Deployment", "K8s::Core::Service"]);
  });

  test("apiVersion: apps/v1, kind: Deployment → K8s::Apps::Deployment", () => {
    const yaml = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: test
`;
    const ir = parser.parse(yaml);
    expect(ir.resources[0].type).toBe("K8s::Apps::Deployment");
  });

  test("apiVersion: v1, kind: Service → K8s::Core::Service", () => {
    const yaml = `
apiVersion: v1
kind: Service
metadata:
  name: test
`;
    const ir = parser.parse(yaml);
    expect(ir.resources[0].type).toBe("K8s::Core::Service");
  });

  test("v1/ConfigMap maps correctly", () => {
    const yaml = `
apiVersion: v1
kind: ConfigMap
metadata:
  name: config
data:
  key: value
`;
    const ir = parser.parse(yaml);
    expect(ir.resources[0].type).toBe("K8s::Core::ConfigMap");
    expect(ir.resources[0].properties.data).toEqual({ key: "value" });
  });

  test("unknown apiVersion/kind falls back to constructed type name", () => {
    const yaml = `
apiVersion: custom.io/v1
kind: Widget
metadata:
  name: w
`;
    const ir = parser.parse(yaml);
    expect(ir.resources[0].type).toMatch(/^K8s::\w+::Widget$/);
  });

  test("metadata.name extracted as logical ID component", () => {
    const yaml = `
apiVersion: v1
kind: Pod
metadata:
  name: my-pod
`;
    const ir = parser.parse(yaml);
    expect(ir.resources[0].logicalId).toBe("podMyPod");
    expect(ir.resources[0].metadata!.originalName).toBe("my-pod");
  });

  test("metadata includes apiVersion and kind", () => {
    const yaml = `
apiVersion: batch/v1
kind: Job
metadata:
  name: my-job
`;
    const ir = parser.parse(yaml);
    expect(ir.resources[0].metadata!.apiVersion).toBe("batch/v1");
    expect(ir.resources[0].metadata!.kind).toBe("Job");
  });

  test("properties exclude apiVersion and kind", () => {
    const yaml = `
apiVersion: v1
kind: Pod
metadata:
  name: test
spec:
  containers: []
`;
    const ir = parser.parse(yaml);
    const props = ir.resources[0].properties;
    expect(props.apiVersion).toBeUndefined();
    expect(props.kind).toBeUndefined();
    expect(props.metadata).toBeDefined();
    expect(props.spec).toBeDefined();
  });

  test("parameters are empty (K8s has no parameters)", () => {
    const yaml = `
apiVersion: v1
kind: Pod
metadata:
  name: test
`;
    const ir = parser.parse(yaml);
    expect(ir.parameters).toEqual([]);
  });

  test("tracks namespaces in metadata", () => {
    const yaml = `
apiVersion: v1
kind: Pod
metadata:
  name: test
  namespace: production
`;
    const ir = parser.parse(yaml);
    expect(ir.metadata?.namespaces).toContain("production");
  });

  test("one warning per kind the lexicon has no class for (#5070)", () => {
    const doc = (name: string) =>
      `apiVersion: external-secrets.io/v1\nkind: ExternalSecret\nmetadata:\n  name: ${name}\n`;
    const ir = parser.parse(`${doc("a")}---\n${doc("b")}---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: c\n`);
    expect(ir.warnings).toHaveLength(1);
    expect(ir.warnings![0]).toContain("ExternalSecret");
    expect(ir.warnings![0]).toContain("k8s.crds");
    expect(ir.warnings![0]).toContain("chant generate");
  });

  test("an object at an apiVersion its class does not build is warned about by name (#5075)", () => {
    const ir = parser.parse(
      "apiVersion: rbac.authorization.k8s.io/v1beta1\nkind: ClusterRole\nmetadata:\n  name: old\nrules: []\n",
    );
    expect(ir.warnings).toHaveLength(1);
    expect(ir.warnings![0]).toContain("ClusterRole old");
    expect(ir.warnings![0]).toContain("rbac.authorization.k8s.io/v1beta1");
    expect(ir.warnings![0]).toContain("builds rbac.authorization.k8s.io/v1,");
  });

  test("an autoscaling/v1 HorizontalPodAutoscaler keeps its class and raises no warning (#5075)", () => {
    const ir = parser.parse("apiVersion: autoscaling/v1\nkind: HorizontalPodAutoscaler\nmetadata:\n  name: h\n");
    expect(ir.warnings).toBeUndefined();
  });

  test("a kind with a class raises no warning", () => {
    expect(parser.parse("apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: c\n").warnings).toBeUndefined();
  });
});
