import { describe, test, expect } from "vitest";
import { parseCRD, parseCRDSpec } from "./parser";

describe("parseCRD", () => {
  test("parses valid CRD YAML", () => {
    const crd = `
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: certificates.cert-manager.io
spec:
  group: cert-manager.io
  names:
    kind: Certificate
    plural: certificates
  scope: Namespaced
  versions:
    - name: v1
      served: true
      storage: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              properties:
                secretName:
                  type: string
                issuerRef:
                  type: object
                  properties:
                    name:
                      type: string
                    kind:
                      type: string
`;
    const results = parseCRD(crd);
    expect(results.length).toBe(1);
    expect(results[0].resource.typeName).toBe("K8s::CertManager::Certificate");
    expect(results[0].gvk.group).toBe("cert-manager.io");
    expect(results[0].gvk.version).toBe("v1");
    expect(results[0].gvk.kind).toBe("Certificate");
  });

  test("parses multi-doc CRD bundle", () => {
    const bundle = `
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: certificates.cert-manager.io
spec:
  group: cert-manager.io
  names:
    kind: Certificate
    plural: certificates
  scope: Namespaced
  versions:
    - name: v1
      served: true
      storage: true
      schema:
        openAPIV3Schema:
          type: object
---
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: issuers.cert-manager.io
spec:
  group: cert-manager.io
  names:
    kind: Issuer
    plural: issuers
  scope: Namespaced
  versions:
    - name: v1
      served: true
      storage: true
      schema:
        openAPIV3Schema:
          type: object
`;
    const results = parseCRD(bundle);
    expect(results.length).toBe(2);
  });

  test("skips non-CRD documents", () => {
    const mixed = `
apiVersion: v1
kind: ConfigMap
metadata:
  name: something
data:
  key: value
---
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: foos.example.com
spec:
  group: example.com
  names:
    kind: Foo
    plural: foos
  scope: Namespaced
  versions:
    - name: v1
      served: true
      storage: true
      schema:
        openAPIV3Schema:
          type: object
`;
    const results = parseCRD(mixed);
    expect(results.length).toBe(1);
    expect(results[0].resource.typeName).toBe("K8s::Example::Foo");
  });

  test("handles CRD without schema (empty properties)", () => {
    const crd = `
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: bars.example.com
spec:
  group: example.com
  names:
    kind: Bar
    plural: bars
  scope: Namespaced
  versions:
    - name: v1
      served: true
      storage: true
`;
    const results = parseCRD(crd);
    expect(results.length).toBe(1);
    expect(results[0].resource.properties).toEqual([]);
  });

  test("type name follows K8s::{GroupNs}::{Kind} convention", () => {
    const crd = `
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: widgets.my-company.io
spec:
  group: my-company.io
  names:
    kind: Widget
    plural: widgets
  scope: Namespaced
  versions:
    - name: v1alpha1
      served: true
      storage: true
      schema:
        openAPIV3Schema:
          type: object
`;
    const results = parseCRD(crd);
    expect(results[0].resource.typeName).toMatch(/^K8s::\w+::\w+$/);
  });
});

describe("parseCRDSpec", () => {
  test("extracts properties from openAPIV3Schema", () => {
    const spec = {
      group: "example.com",
      names: { kind: "Foo", plural: "foos" },
      scope: "Namespaced" as const,
      versions: [
        {
          name: "v1",
          served: true,
          storage: true,
          schema: {
            openAPIV3Schema: {
              type: "object",
              properties: {
                spec: {
                  type: "object",
                  properties: {
                    count: { type: "integer" },
                    name: { type: "string" },
                  },
                },
                metadata: { type: "object" },
              },
            },
          },
        },
      ],
    };

    const results = parseCRDSpec(spec);
    expect(results.length).toBe(1);
    const props = results[0].resource.properties;
    expect(props.some((p) => p.name === "spec")).toBe(true);
    expect(props.some((p) => p.name === "metadata")).toBe(true);
  });

  test("normalizeGroupName converts cert-manager.io to CertManager", () => {
    const spec = {
      group: "cert-manager.io",
      names: { kind: "Certificate", plural: "certificates" },
      scope: "Namespaced" as const,
      versions: [
        { name: "v1", served: true, storage: true },
      ],
    };

    const results = parseCRDSpec(spec);
    expect(results[0].resource.typeName).toBe("K8s::CertManager::Certificate");
  });

  test("argoproj.io group maps to the Argo namespace (override)", () => {
    const spec = {
      group: "argoproj.io",
      names: { kind: "Application", plural: "applications" },
      scope: "Namespaced" as const,
      versions: [
        { name: "v1alpha1", served: true, storage: true },
      ],
    };

    const results = parseCRDSpec(spec);
    expect(results[0].resource.typeName).toBe("K8s::Argo::Application");
  });

  test("dedupes property-type names when a scalar and array sibling collide", () => {
    // Argo Application has both `source` (object) and `sources` (array of the
    // same shape); singularizing `sources` → `Source` would collide.
    const spec = {
      group: "argoproj.io",
      names: { kind: "Application", plural: "applications" },
      scope: "Namespaced" as const,
      versions: [
        {
          name: "v1alpha1",
          served: true,
          storage: true,
          schema: {
            openAPIV3Schema: {
              type: "object",
              properties: {
                spec: {
                  type: "object",
                  properties: {
                    source: {
                      type: "object",
                      properties: { repoURL: { type: "string" } },
                    },
                    sources: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: { repoURL: { type: "string" } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      ],
    };

    const results = parseCRDSpec(spec);
    const names = results[0].propertyTypes.map((pt) => pt.name);
    expect(names).toContain("Application_Source");
    expect(names).toContain("Application_Sources");
    // No duplicate identifiers.
    expect(new Set(names).size).toBe(names.length);
  });

  test("extracts read-only typed status as a property type and status attribute", () => {
    const spec = {
      group: "cert-manager.io",
      names: { kind: "Certificate", plural: "certificates" },
      scope: "Namespaced" as const,
      versions: [
        {
          name: "v1",
          served: true,
          storage: true,
          schema: {
            openAPIV3Schema: {
              type: "object",
              properties: {
                spec: { type: "object", properties: { secretName: { type: "string" } } },
                status: {
                  type: "object",
                  properties: {
                    notAfter: { type: "string" },
                    revision: { type: "integer" },
                    conditions: { type: "array", items: { type: "object", properties: { type: { type: "string" } } } },
                  },
                },
              },
            },
          },
        },
      ],
    };

    const results = parseCRDSpec(spec);
    const res = results[0];

    // A read-only `status` attribute is present; status is never a writable property.
    const statusAttr = res.resource.attributes.find((a) => a.name === "status");
    expect(statusAttr).toBeDefined();
    expect(res.resource.properties.some((p) => p.name === "status")).toBe(false);

    // Rich per-field status type carried as a property type (the lexicon-JSON channel).
    const statusType = res.propertyTypes.find((pt) => pt.name === "Certificate_Status");
    expect(statusType).toBeDefined();
    expect(statusType!.defType).toBe("status");
    const byName = Object.fromEntries(statusType!.properties.map((p) => [p.name, p.tsType]));
    expect(byName.notAfter).toBe("string");
    expect(byName.revision).toBe("number");
  });

  test("no status attribute or type when the CRD has no status schema", () => {
    const spec = {
      group: "example.com",
      names: { kind: "Config", plural: "configs" },
      scope: "Namespaced" as const,
      versions: [
        {
          name: "v1",
          served: true,
          storage: true,
          schema: {
            openAPIV3Schema: {
              type: "object",
              properties: { spec: { type: "object", properties: { k: { type: "string" } } } },
            },
          },
        },
      ],
    };

    const results = parseCRDSpec(spec);
    expect(results[0].resource.attributes.some((a) => a.name === "status")).toBe(false);
    expect(results[0].propertyTypes.some((pt) => pt.name === "Config_Status")).toBe(false);
  });

  test("preserve-unknown status degrades to a read-only record with no property type", () => {
    const spec = {
      group: "example.com",
      names: { kind: "Widget", plural: "widgets" },
      scope: "Namespaced" as const,
      versions: [
        {
          name: "v1",
          served: true,
          storage: true,
          schema: {
            openAPIV3Schema: {
              type: "object",
              properties: {
                spec: { type: "object", properties: { k: { type: "string" } } },
                status: { type: "object", "x-kubernetes-preserve-unknown-fields": true },
              },
            },
          },
        },
      ],
    };

    const results = parseCRDSpec(spec);
    expect(results[0].resource.attributes.some((a) => a.name === "status")).toBe(true);
    expect(results[0].propertyTypes.some((pt) => pt.name === "Widget_Status")).toBe(false);
  });
});
