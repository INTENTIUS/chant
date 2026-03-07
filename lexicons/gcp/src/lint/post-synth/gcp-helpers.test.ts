import { describe, test, expect } from "bun:test";
import {
  parseGcpManifests,
  isConfigConnectorResource,
  getSpec,
  getAnnotations,
  getResourceName,
  findResourceRefs,
} from "./gcp-helpers";

describe("parseGcpManifests", () => {
  test("parses single document", () => {
    const yaml = `apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: my-bucket
spec:
  location: US
`;
    const manifests = parseGcpManifests(yaml);
    expect(manifests).toHaveLength(1);
    expect(manifests[0].kind).toBe("StorageBucket");
    expect(manifests[0].metadata?.name).toBe("my-bucket");
  });

  test("parses multi-document YAML", () => {
    const yaml = `apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: bucket-a
spec:
  location: US
---
apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: bucket-b
spec:
  location: EU
`;
    const manifests = parseGcpManifests(yaml);
    expect(manifests).toHaveLength(2);
    expect(manifests[0].metadata?.name).toBe("bucket-a");
    expect(manifests[1].metadata?.name).toBe("bucket-b");
  });

  test("skips empty documents", () => {
    const yaml = `---
---
apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: my-bucket
spec:
  location: US
---
`;
    const manifests = parseGcpManifests(yaml);
    expect(manifests).toHaveLength(1);
  });

  test("returns empty array for empty input", () => {
    const manifests = parseGcpManifests("");
    expect(manifests).toHaveLength(0);
  });
});

describe("isConfigConnectorResource", () => {
  test("returns true for cnrm resource", () => {
    expect(
      isConfigConnectorResource({
        apiVersion: "storage.cnrm.cloud.google.com/v1beta1",
        kind: "StorageBucket",
      }),
    ).toBe(true);
  });

  test("returns false for non-cnrm resource", () => {
    expect(
      isConfigConnectorResource({
        apiVersion: "apps/v1",
        kind: "Deployment",
      }),
    ).toBe(false);
  });

  test("returns false when apiVersion is missing", () => {
    expect(isConfigConnectorResource({ kind: "StorageBucket" })).toBe(false);
  });
});

describe("getSpec", () => {
  test("returns spec when present", () => {
    const spec = getSpec({ spec: { location: "US" } });
    expect(spec).toEqual({ location: "US" });
  });

  test("returns undefined when spec is missing", () => {
    expect(getSpec({})).toBeUndefined();
  });
});

describe("getAnnotations", () => {
  test("returns annotations when present", () => {
    const annotations = getAnnotations({
      metadata: {
        name: "x",
        annotations: { "cnrm.cloud.google.com/project-id": "my-project" },
      },
    });
    expect(annotations).toEqual({
      "cnrm.cloud.google.com/project-id": "my-project",
    });
  });

  test("returns undefined when annotations missing", () => {
    expect(getAnnotations({ metadata: { name: "x" } })).toBeUndefined();
  });

  test("returns undefined when metadata missing", () => {
    expect(getAnnotations({})).toBeUndefined();
  });
});

describe("getResourceName", () => {
  test("returns name from metadata", () => {
    expect(getResourceName({ metadata: { name: "my-bucket" } })).toBe(
      "my-bucket",
    );
  });

  test("returns 'unknown' when name missing", () => {
    expect(getResourceName({})).toBe("unknown");
  });
});

describe("findResourceRefs", () => {
  test("finds refs in spec", () => {
    const refs = findResourceRefs({
      clusterRef: { name: "my-cluster" },
      networkRef: { name: "my-network" },
    });
    expect(refs.has("my-cluster")).toBe(true);
    expect(refs.has("my-network")).toBe(true);
    expect(refs.size).toBe(2);
  });

  test("skips external refs", () => {
    const refs = findResourceRefs({
      projectRef: { name: "my-project", external: true },
    });
    expect(refs.size).toBe(0);
  });

  test("finds refs nested in arrays", () => {
    const refs = findResourceRefs({
      items: [{ subnetRef: { name: "subnet-1" } }],
    });
    expect(refs.has("subnet-1")).toBe(true);
  });

  test("returns empty set for null/undefined", () => {
    expect(findResourceRefs(null).size).toBe(0);
    expect(findResourceRefs(undefined).size).toBe(0);
  });
});
