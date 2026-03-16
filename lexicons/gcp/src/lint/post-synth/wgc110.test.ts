import { describe, test, expect } from "bun:test";
import { wgc110 } from "./wgc110";

function makeCtx(yaml: string) {
  return {
    outputs: new Map([["gcp", yaml]]),
  };
}

describe("WGC110: missing key rotation", () => {
  test("flags KMSCryptoKey without rotation period", () => {
    const yaml = `apiVersion: kms.cnrm.cloud.google.com/v1beta1
kind: KMSCryptoKey
metadata:
  name: my-key
spec:
  purpose: ENCRYPT_DECRYPT
`;
    const diags = wgc110.check(makeCtx(yaml));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WGC110");
    expect(diags[0].severity).toBe("warning");
  });

  test("no diagnostic when rotation period set", () => {
    const yaml = `apiVersion: kms.cnrm.cloud.google.com/v1beta1
kind: KMSCryptoKey
metadata:
  name: my-key
spec:
  purpose: ENCRYPT_DECRYPT
  rotationPeriod: 7776000s
`;
    const diags = wgc110.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
