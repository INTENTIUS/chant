import { describe, test, expect } from "vitest";
import {
  gvkToTypeName,
  gvkToApiVersion,
  k8sShortName,
  k8sServiceName,
  specListMapKeyPairs,
  parseK8sSwaggerTypes,
} from "./parse";

describe("gvkToTypeName", () => {
  test("core group maps to Core", () => {
    expect(gvkToTypeName({ group: "", version: "v1", kind: "Pod" })).toBe(
      "K8s::Core::Pod",
    );
  });

  test("apps group", () => {
    expect(
      gvkToTypeName({ group: "apps", version: "v1", kind: "Deployment" }),
    ).toBe("K8s::Apps::Deployment");
  });

  test("batch group", () => {
    expect(
      gvkToTypeName({ group: "batch", version: "v1", kind: "Job" }),
    ).toBe("K8s::Batch::Job");
  });

  test("networking.k8s.io group", () => {
    expect(
      gvkToTypeName({
        group: "networking.k8s.io",
        version: "v1",
        kind: "Ingress",
      }),
    ).toBe("K8s::Networking::Ingress");
  });

  test("rbac group normalised to Rbac", () => {
    expect(
      gvkToTypeName({
        group: "rbac.authorization.k8s.io",
        version: "v1",
        kind: "Role",
      }),
    ).toBe("K8s::Rbac::Role");
  });

  test("autoscaling group", () => {
    expect(
      gvkToTypeName({
        group: "autoscaling",
        version: "v2",
        kind: "HorizontalPodAutoscaler",
      }),
    ).toBe("K8s::Autoscaling::HorizontalPodAutoscaler");
  });
});

describe("gvkToApiVersion", () => {
  test("core group returns version only", () => {
    expect(gvkToApiVersion({ group: "", version: "v1", kind: "Pod" })).toBe(
      "v1",
    );
  });

  test("empty string group returns version only", () => {
    expect(
      gvkToApiVersion({ group: "", version: "v1", kind: "Service" }),
    ).toBe("v1");
  });

  test("non-core group returns group/version", () => {
    expect(
      gvkToApiVersion({ group: "apps", version: "v1", kind: "Deployment" }),
    ).toBe("apps/v1");
  });

  test("networking group", () => {
    expect(
      gvkToApiVersion({
        group: "networking.k8s.io",
        version: "v1",
        kind: "Ingress",
      }),
    ).toBe("networking.k8s.io/v1");
  });
});

describe("k8sShortName", () => {
  test("returns short name for known types", () => {
    // k8sShortName should map well-known types to their abbreviations
    const name = k8sShortName("Deployment");
    expect(typeof name).toBe("string");
  });
});

describe("k8sServiceName", () => {
  test("returns service name for known types", () => {
    const name = k8sServiceName("Deployment");
    expect(typeof name).toBe("string");
  });
});

/**
 * chant #1441 — the merge semantics the API server publishes, read off every
 * definition rather than only the ones chant emits a type for.
 */
describe("specListMapKeyPairs", () => {
  const spec = JSON.stringify({
    definitions: {
      "io.k8s.api.core.v1.PodSpec": {
        properties: {
          containers: { type: "array", "x-kubernetes-list-type": "map", "x-kubernetes-list-map-keys": ["name"] },
          // atomic and set lists carry no identity key
          tolerations: { type: "array", "x-kubernetes-list-type": "atomic" },
          finalizers: { type: "array", "x-kubernetes-list-type": "set" },
          nodeName: { type: "string" },
        },
      },
      "io.k8s.api.core.v1.ServiceSpec": {
        properties: {
          ports: { type: "array", "x-kubernetes-list-type": "map", "x-kubernetes-list-map-keys": ["port", "protocol"] },
        },
      },
      "io.k8s.api.core.v1.NoProperties": {},
    },
  });

  test("collects only map-typed lists that name their keys", () => {
    expect(specListMapKeyPairs(spec)).toEqual([
      ["containers", ["name"]],
      ["ports", ["port", "protocol"]],
    ]);
  });

  test("accepts a Buffer, as the fetch path supplies", () => {
    expect(specListMapKeyPairs(Buffer.from(spec, "utf-8"))).toHaveLength(2);
  });

  test("a spec with no definitions yields nothing rather than throwing", () => {
    expect(specListMapKeyPairs(JSON.stringify({}))).toEqual([]);
  });
});

/**
 * chant #3093 — every object definition a resource reaches is typed, not
 * only the well-known property types.
 */
describe("parseK8sSwaggerTypes", () => {
  const ref = (key: string) => ({ $ref: `#/definitions/${key}` });
  const gvk = (group: string, version: string, kind: string) => ({ "x-kubernetes-group-version-kind": [{ group, version, kind }] });
  const spec = JSON.stringify({
    definitions: {
      "io.k8s.api.apps.v1.Deployment": {
        ...gvk("apps", "v1", "Deployment"),
        properties: {
          apiVersion: { type: "string" },
          kind: { type: "string" },
          metadata: ref("io.k8s.apimachinery.pkg.apis.meta.v1.ObjectMeta"),
          spec: ref("io.k8s.api.apps.v1.DeploymentSpec"),
          status: ref("io.k8s.api.apps.v1.DeploymentStatus"),
        },
      },
      "io.k8s.api.apps.v1.DeploymentSpec": {
        required: ["selector"],
        properties: {
          replicas: { type: "integer" },
          selector: ref("io.k8s.apimachinery.pkg.apis.meta.v1.LabelSelector"),
          strategy: ref("io.k8s.api.apps.v1.DeploymentStrategy"),
          extra: ref("io.k8s.apimachinery.pkg.runtime.RawExtension"),
          claims: { type: "array", items: ref("io.k8s.api.core.v1.ResourceClaim") },
          subjects: { type: "array", items: ref("io.k8s.api.flowcontrol.v1.Subject") },
          ports: { type: "array", items: ref("io.k8s.api.core.v1.EndpointPort") },
          slicePorts: { type: "array", items: ref("io.k8s.api.discovery.v1.EndpointPort") },
          schema: ref("io.k8s.apiextensions-apiserver.pkg.apis.apiextensions.v1.JSONSchemaProps"),
          templates: { type: "array", items: ref("io.k8s.api.core.v1.ConfigMap") },
          cpu: ref("io.k8s.apimachinery.pkg.api.resource.Quantity"),
        },
      },
      "io.k8s.api.apps.v1.DeploymentStatus": { properties: { replicas: { type: "integer" } } },
      "io.k8s.api.apps.v1.DeploymentStrategy": { properties: { type: { type: "string" } } },
      "io.k8s.apimachinery.pkg.apis.meta.v1.ObjectMeta": { properties: { name: { type: "string" } } },
      "io.k8s.apimachinery.pkg.apis.meta.v1.LabelSelector": {
        properties: { matchLabels: { type: "object", additionalProperties: { type: "string" } } },
      },
      "io.k8s.apimachinery.pkg.runtime.RawExtension": { type: "object", properties: { raw: { type: "string" } } },
      // A resource kind elsewhere, so the core definition cannot take the bare name.
      "io.k8s.api.resource.v1.ResourceClaim": { ...gvk("resource.k8s.io", "v1", "ResourceClaim"), properties: { metadata: {} } },
      "io.k8s.api.core.v1.ResourceClaim": { properties: { name: { type: "string" } } },
      // Clashes with the well-known rbac Subject.
      "io.k8s.api.flowcontrol.v1.Subject": { properties: { kind: { type: "string" } } },
      // Two groups want one name.
      "io.k8s.api.core.v1.EndpointPort": { properties: { port: { type: "integer" } } },
      "io.k8s.api.discovery.v1.EndpointPort": { properties: { port: { type: "integer" } } },
      "io.k8s.apiextensions-apiserver.pkg.apis.apiextensions.v1.JSONSchemaProps": {
        properties: {
          properties: { type: "object", additionalProperties: ref("io.k8s.apiextensions-apiserver.pkg.apis.apiextensions.v1.JSONSchemaProps") },
          items: ref("io.k8s.apiextensions-apiserver.pkg.apis.apiextensions.v1.JSONSchemaPropsOrArray"),
        },
      },
      "io.k8s.apiextensions-apiserver.pkg.apis.apiextensions.v1.JSONSchemaPropsOrArray": {},
      "io.k8s.api.core.v1.ConfigMap": {
        ...gvk("", "v1", "ConfigMap"),
        required: ["metadata"],
        properties: { kind: { type: "string" }, metadata: ref("io.k8s.apimachinery.pkg.apis.meta.v1.ObjectMeta"), data: { type: "object", additionalProperties: { type: "string" } } },
      },
      "io.k8s.api.unrelated.v1.Unreached": { properties: { x: { type: "string" } } },
    },
  });
  const parsed = parseK8sSwaggerTypes(spec);
  const tsType = (props: Array<{ name: string; tsType: string }>, name: string) => props.find((p) => p.name === name)?.tsType;
  const deployment = parsed.results.find((r) => r.resource.typeName === "K8s::Apps::Deployment")!;
  const deploymentSpec = parsed.definitionTypes.find((d) => d.name === "DeploymentSpec")!;

  test("a resource's spec is typed by its definition, not a Record", () => {
    expect(tsType(deployment.resource.properties, "spec")).toBe("DeploymentSpec");
    expect(deploymentSpec.defKey).toBe("io.k8s.api.apps.v1.DeploymentSpec");
    expect(deploymentSpec.properties.find((p) => p.name === "selector")).toMatchObject({ tsType: "LabelSelector", required: true });
    expect(tsType(deploymentSpec.properties, "replicas")).toBe("number");
  });

  test("the well-known property types keep their names and stay classes, not interfaces", () => {
    expect(tsType(deploymentSpec.properties, "strategy")).toBe("DeploymentStrategy");
    expect(parsed.definitionTypes.map((d) => d.name)).not.toContain("DeploymentStrategy");
  });

  test("a name taken by a resource kind or a well-known type is qualified by group, then by version", () => {
    expect(tsType(deploymentSpec.properties, "claims")).toBe("CoreResourceClaim[]");
    expect(tsType(deploymentSpec.properties, "subjects")).toBe("FlowcontrolSubject[]");
    expect(tsType(deploymentSpec.properties, "ports")).toBe("CoreEndpointPort[]");
    expect(tsType(deploymentSpec.properties, "slicePorts")).toBe("DiscoveryEndpointPort[]");
  });

  test("a recursive definition refers to itself by name", () => {
    const schema = parsed.definitionTypes.find((d) => d.name === "JSONSchemaProps")!;
    expect(tsType(schema.properties, "properties")).toBe("Record<string, JSONSchemaProps>");
    expect(tsType(schema.properties, "items")).toBe("any");
  });

  test("RawExtension stays open; a Quantity takes a string or a number", () => {
    expect(tsType(deploymentSpec.properties, "extra")).toBe("Record<string, any>");
    expect(tsType(deploymentSpec.properties, "cpu")).toBe("string | number");
    expect(parsed.definitionTypes.map((d) => d.name)).not.toContain("RawExtension");
  });

  test("an embedded resource is typed inline with its class's props", () => {
    expect(tsType(deploymentSpec.properties, "templates")).toBe("{ data?: Record<string, string>; metadata: ObjectMeta }[]");
  });

  test("status-only and unreachable definitions are not emitted", () => {
    const names = parsed.definitionTypes.map((d) => d.name);
    expect(names).not.toContain("DeploymentStatus");
    expect(names).not.toContain("Unreached");
  });

  test("definitions come out sorted by name", () => {
    const names = parsed.definitionTypes.map((d) => d.name);
    expect(names).toEqual([...names].sort());
  });
});
