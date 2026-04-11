import { describe, test, expect } from "vitest";
import { wgc108 } from "./wgc108";

function makeCtx(yaml: string) {
  return {
    outputs: new Map([["gcp", yaml]]),
  };
}

describe("WGC108: missing backup configuration", () => {
  test("flags SQLInstance without backup", () => {
    const yaml = `apiVersion: sql.cnrm.cloud.google.com/v1beta1
kind: SQLInstance
metadata:
  name: my-db
spec:
  databaseVersion: POSTGRES_15
  settings:
    tier: db-f1-micro
`;
    const diags = wgc108.check(makeCtx(yaml));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WGC108");
    expect(diags[0].severity).toBe("warning");
  });

  test("no diagnostic when backup enabled", () => {
    const yaml = `apiVersion: sql.cnrm.cloud.google.com/v1beta1
kind: SQLInstance
metadata:
  name: my-db
spec:
  databaseVersion: POSTGRES_15
  settings:
    tier: db-f1-micro
    backupConfiguration:
      enabled: true
`;
    const diags = wgc108.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
