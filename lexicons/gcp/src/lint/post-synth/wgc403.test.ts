import { describe, test, expect } from "bun:test";
import { wgc403 } from "./wgc403";

function makeCtx(yaml: string) {
  return {
    outputs: new Map([["gcp", yaml]]),
  };
}

describe("WGC403: type/structure mismatch", () => {
  test("flags string where number expected", () => {
    const yaml = `apiVersion: cloudfunctions.cnrm.cloud.google.com/v1beta1
kind: CloudFunctionsFunction
metadata:
  name: my-fn
spec:
  runtime: nodejs18
  availableMemoryMb: "512"
  region: us-central1
`;
    const diags = wgc403.check(makeCtx(yaml));
    const typeDiags = diags.filter(d => d.checkId === "WGC403");
    if (typeDiags.length > 0) {
      expect(typeDiags[0].severity).toBe("error");
      expect(typeDiags[0].message).toContain("number");
      expect(typeDiags[0].message).toContain("string");
    }
  });

  test("flags bare string instead of resourceRef object", () => {
    const yaml = `apiVersion: pubsub.cnrm.cloud.google.com/v1beta1
kind: PubSubSubscription
metadata:
  name: my-sub
spec:
  topicRef: my-topic
`;
    const diags = wgc403.check(makeCtx(yaml));
    const typeDiags = diags.filter(d => d.checkId === "WGC403");
    if (typeDiags.length > 0) {
      expect(typeDiags[0].severity).toBe("error");
      expect(typeDiags[0].message).toContain("resourceRef");
    }
  });

  test("no diagnostic with correct types", () => {
    const yaml = `apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: my-bucket
spec:
  location: US
  uniformBucketLevelAccess: true
`;
    const diags = wgc403.check(makeCtx(yaml));
    const typeDiags = diags.filter(d => d.checkId === "WGC403");
    expect(typeDiags).toHaveLength(0);
  });
});
