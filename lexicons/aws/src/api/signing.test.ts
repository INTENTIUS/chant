/**
 * The aws lexicon's signing surface (#1686) over core's SigV4 signer (#4583).
 *
 * A signing implementation that is only tested against itself proves nothing,
 * so the first block checks core's signer against `get-vanilla` from AWS's
 * `aws-sig-v4-test-suite`. The Cloud Control vector further down was recorded
 * from this lexicon's own signer before #4583 replaced it with core's: if the
 * header set the lexicon signs drifts, that signature stops matching.
 *
 * Nothing here touches the network; there is nothing to touch. Signing is a
 * pure function of the request and the clock.
 */
import { describe, test, expect } from "vitest";
import { sha256Hex, signV4 } from "@intentius/chant/cloud-lister/sigv4";
import { EMPTY_PAYLOAD_SHA256, UNSIGNED_HEADERS, resolveCredentials, signRequest } from "./signing";

/** The example secret AWS uses throughout its Signature Version 4 documentation. */
const SECRET = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
const ACCESS_KEY = "AKIDEXAMPLE";

describe("the published vector", () => {
  test("get-vanilla signs exactly as the test suite says", () => {
    const headers = signV4({
      method: "GET",
      url: "https://example.amazonaws.com/",
      headers: {},
      body: "",
      region: "us-east-1",
      service: "service",
      credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET },
      now: new Date("2015-08-30T12:36:00Z"),
    });
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
        "SignedHeaders=host;x-amz-date, " +
        "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });

  test("the empty-payload constant is what SHA-256 of nothing actually is", () => {
    expect(sha256Hex("")).toBe(EMPTY_PAYLOAD_SHA256);
  });
});

describe("the Cloud Control vector (#4583)", () => {
  // Recorded from lexicons/aws/src/api/sigv4.ts, the lexicon's own signer,
  // with these inputs, before it was removed in favour of core's.
  const request = {
    method: "POST",
    url: "https://cloudcontrolapi.us-east-1.amazonaws.com/",
    headers: {
      "content-type": "application/x-amz-json-1.0",
      "x-amz-target": "CloudApiService.GetResource",
      "user-agent": "chant/0.124.34",
      "x-amzn-trace-id": "Root=1-5759e988-bd862e3fe1be46a994272793",
    },
    body: JSON.stringify({ TypeName: "AWS::S3::Bucket", Identifier: "chant-example-bucket" }),
    service: "cloudcontrolapi",
    region: "us-east-1",
    now: new Date("2015-08-30T12:36:00Z"),
  };

  test("a GetResource read signs to the recorded signature, user-agent and trace id unsigned", () => {
    const headers = signRequest({ ...request, credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET } });
    expect(headers).toEqual({
      "content-type": "application/x-amz-json-1.0",
      "x-amz-target": "CloudApiService.GetResource",
      "user-agent": "chant/0.124.34",
      "x-amzn-trace-id": "Root=1-5759e988-bd862e3fe1be46a994272793",
      "x-amz-date": "20150830T123600Z",
      "x-amz-content-sha256": "0748e7c18ab9933c78b1a34cd08c91183112acfa9918aea20ba2f1a6d33ef3d0",
      authorization:
        "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/cloudcontrolapi/aws4_request, " +
        "SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-target, " +
        "Signature=f8f2bbebcf51eed1126eca37ab3e614b540f0d769eb64ec2a0c5ee811b168f51",
    });
  });

  test("with a session token, the token is sent, signed, and the signature is the recorded one", () => {
    const headers = signRequest({
      ...request,
      credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET, sessionToken: "FwoGZXIvYXdzEXAMPLE" },
    });
    expect(headers["x-amz-security-token"]).toBe("FwoGZXIvYXdzEXAMPLE");
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/cloudcontrolapi/aws4_request, " +
        "SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token;x-amz-target, " +
        "Signature=99fef393d5ff5ad524823b03476535fa00631828cc22dae15f8f3cfe9d18ab69",
    );
  });
});

describe("header set", () => {
  test("the unsigned headers are sent but left out of the signature", () => {
    const caller = {
      "user-agent": "chant",
      "x-amzn-trace-id": "Root=1-x",
      connection: "keep-alive",
      expect: "100-continue",
    };
    const headers = signRequest({
      method: "POST",
      url: "https://cloudformation.us-east-1.amazonaws.com/",
      headers: { ...caller, authorization: "stale" },
      body: "",
      service: "cloudformation",
      region: "us-east-1",
      credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET },
      now: new Date("2015-08-30T12:36:00Z"),
    });
    for (const [name, value] of Object.entries(caller)) expect(headers[name]).toBe(value);
    expect(headers.authorization).toContain("SignedHeaders=host;x-amz-content-sha256;x-amz-date,");
    expect([...UNSIGNED_HEADERS].sort()).toEqual(["authorization", "connection", "expect", "user-agent", "x-amzn-trace-id"]);
  });

  test("a bodyless request hashes to the empty-payload constant", () => {
    const headers = signRequest({
      method: "POST",
      url: "https://cloudformation.us-east-1.amazonaws.com/",
      headers: {},
      body: "",
      service: "cloudformation",
      region: "us-east-1",
      credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET },
      now: new Date("2015-08-30T12:36:00Z"),
    });
    expect(headers["x-amz-content-sha256"]).toBe(EMPTY_PAYLOAD_SHA256);
  });
});

describe("signRequest", () => {
  const credentials = { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET };
  const now = new Date("2015-08-30T12:36:00Z");

  test("adds its own headers, keeps the caller's, and never emits host", () => {
    const headers = signRequest({
      method: "POST",
      url: "https://cloudformation.us-west-2.amazonaws.com/",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "Action=DescribeStacks",
      service: "cloudformation",
      region: "us-west-2",
      credentials,
      now,
    });

    expect(headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(headers["x-amz-date"]).toBe("20150830T123600Z");
    expect(headers["x-amz-content-sha256"]).toBe(sha256Hex("Action=DescribeStacks"));
    expect(headers.host).toBeUndefined();
    // A fixed clock makes the whole header a fixture; the primitives it is
    // composed from are the ones checked against AWS's vectors above.
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-west-2/cloudformation/aws4_request, " +
        "SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, " +
        "Signature=3160e6fcf0cce7e8ff03c128e5e2bb6572ca59e843d3a88c26e45203288fc462",
    );
  });

  test("host is signed even though it is not emitted — a different host is a different signature", () => {
    const request = {
      method: "POST",
      headers: {},
      body: "",
      service: "cloudformation",
      region: "us-east-1",
      credentials,
      now,
    } as const;
    const one = signRequest({ ...request, url: "https://cloudformation.us-east-1.amazonaws.com/" });
    const other = signRequest({ ...request, url: "https://cloudformation.us-east-2.amazonaws.com/" });
    expect(one.authorization).not.toBe(other.authorization);
    expect(one.authorization).toContain("SignedHeaders=host;x-amz-content-sha256;x-amz-date");
  });

  test("a session token is both sent and signed", () => {
    const headers = signRequest({
      method: "POST",
      url: "https://cloudcontrolapi.us-east-1.amazonaws.com/",
      headers: {},
      body: "{}",
      service: "cloudcontrolapi",
      region: "us-east-1",
      credentials: { ...credentials, sessionToken: "FwoGZXIvYXdzEXAMPLE" },
      now,
    });
    expect(headers["x-amz-security-token"]).toBe("FwoGZXIvYXdzEXAMPLE");
    expect(headers.authorization).toContain("x-amz-security-token");
  });

  test("the same request at a different second is a different signature", () => {
    const request = {
      method: "POST",
      url: "https://cloudformation.us-east-1.amazonaws.com/",
      headers: {},
      body: "",
      service: "cloudformation",
      region: "us-east-1",
      credentials,
    } as const;
    expect(signRequest({ ...request, now }).authorization).not.toBe(
      signRequest({ ...request, now: new Date("2015-08-30T12:36:01Z") }).authorization,
    );
  });
});

describe("credential resolution", () => {
  const env = { AWS_ACCESS_KEY_ID: "AKIDENV", AWS_SECRET_ACCESS_KEY: "envsecret", AWS_SESSION_TOKEN: "envtoken" };

  test("explicit credentials beat the environment", () => {
    expect(resolveCredentials({ accessKeyId: "AKIDEXPLICIT", secretAccessKey: "s" }, env)).toEqual({
      accessKeyId: "AKIDEXPLICIT",
      secretAccessKey: "s",
    });
  });

  test("the environment answers when nothing was passed, session token included", () => {
    expect(resolveCredentials(undefined, env)).toEqual({
      accessKeyId: "AKIDENV",
      secretAccessKey: "envsecret",
      sessionToken: "envtoken",
    });
  });

  test("no session token in the environment means no session token in the result", () => {
    expect(resolveCredentials(undefined, { AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "b" })).toEqual({
      accessKeyId: "a",
      secretAccessKey: "b",
    });
  });

  test("a half-set environment is absent, not a signature that cannot verify", () => {
    expect(resolveCredentials(undefined, { AWS_ACCESS_KEY_ID: "a" })).toBeUndefined();
    expect(resolveCredentials(undefined, { AWS_SECRET_ACCESS_KEY: "b" })).toBeUndefined();
  });

  test("an empty environment is absent", () => {
    expect(resolveCredentials(undefined, {})).toBeUndefined();
  });

  test("a resolver decides, and its refusal is not overruled by the environment", () => {
    expect(resolveCredentials(() => ({ accessKeyId: "AKIDRESOLVED", secretAccessKey: "s" }), env)).toEqual({
      accessKeyId: "AKIDRESOLVED",
      secretAccessKey: "s",
    });
    expect(resolveCredentials(() => undefined, env)).toBeUndefined();
  });
});
