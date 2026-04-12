import { describe, test, expect } from "vitest";
import { wgc203 } from "./wgc203";

function makeCtx(yaml: string) {
  return {
    outputs: new Map([["gcp", yaml]]),
  };
}

describe("WGC203: cloud-platform OAuth scope", () => {
  test("flags ContainerNodePool with cloud-platform scope", () => {
    const yaml = `apiVersion: container.cnrm.cloud.google.com/v1beta1
kind: ContainerNodePool
metadata:
  name: my-pool
spec:
  clusterRef:
    name: my-cluster
  nodeConfig:
    oauthScopes:
      - "https://www.googleapis.com/auth/cloud-platform"
`;
    const diags = wgc203.check(makeCtx(yaml));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WGC203");
    expect(diags[0].severity).toBe("warning");
  });

  test("no diagnostic with specific scopes", () => {
    const yaml = `apiVersion: container.cnrm.cloud.google.com/v1beta1
kind: ContainerNodePool
metadata:
  name: my-pool
spec:
  clusterRef:
    name: my-cluster
  nodeConfig:
    oauthScopes:
      - "https://www.googleapis.com/auth/logging.write"
      - "https://www.googleapis.com/auth/monitoring"
`;
    const diags = wgc203.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
