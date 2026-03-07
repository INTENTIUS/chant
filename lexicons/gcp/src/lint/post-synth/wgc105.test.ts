import { describe, test, expect } from "bun:test";
import { wgc105 } from "./wgc105";

function makeCtx(yaml: string) {
  return {
    outputs: new Map([["gcp", yaml]]),
  };
}

describe("WGC105: public Cloud SQL", () => {
  test("flags SQLInstance with 0.0.0.0/0 in authorizedNetworks", () => {
    const yaml = `apiVersion: sql.cnrm.cloud.google.com/v1beta1
kind: SQLInstance
metadata:
  name: my-db
spec:
  databaseVersion: POSTGRES_15
  settings:
    ipConfiguration:
      authorizedNetworks:
        - value: "0.0.0.0/0"
          name: public
`;
    const diags = wgc105.check(makeCtx(yaml));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WGC105");
    expect(diags[0].severity).toBe("warning");
  });

  test("no diagnostic with private networks only", () => {
    const yaml = `apiVersion: sql.cnrm.cloud.google.com/v1beta1
kind: SQLInstance
metadata:
  name: my-db
spec:
  databaseVersion: POSTGRES_15
  settings:
    ipConfiguration:
      authorizedNetworks:
        - value: "10.0.0.0/8"
          name: internal
`;
    const diags = wgc105.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
