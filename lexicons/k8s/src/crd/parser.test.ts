import { describe, test, expect } from "bun:test";
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
});
