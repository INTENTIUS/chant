import { describe, test, expect } from "bun:test";
import { wgc101 } from "./wgc101";

function makeCtx(yaml: string) {
  return {
    outputs: new Map([["gcp", yaml]]),
  };
}

describe("WGC101: missing encryption", () => {
  test("flags StorageBucket without encryption", () => {
    const yaml = `apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: my-bucket
spec:
  location: US
`;
    const diags = wgc101.check(makeCtx(yaml));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WGC101");
    expect(diags[0].severity).toBe("warning");
  });

  test("no diagnostic when encryption present", () => {
    const yaml = `apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: my-bucket
spec:
  location: US
  encryption:
    kmsKeyRef:
      external: projects/p/locations/l/keyRings/kr/cryptoKeys/k
`;
    const diags = wgc101.check(makeCtx(yaml));
    const bucketDiags = diags.filter(d => d.entity === "my-bucket");
    expect(bucketDiags).toHaveLength(0);
  });
});
