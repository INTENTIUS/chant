/**
 * SigV4 (#1686), checked against AWS's own published vectors.
 *
 * A signing implementation that is only tested against itself proves nothing —
 * it will happily agree with its own mistake. Three of the fixtures below are
 * values AWS publishes: the derived signing key from the documentation's
 * "deriving the signing key" example, and the canonical request hash and
 * signature of `get-vanilla` from the `aws-sig-v4-test-suite`. If a refactor
 * breaks canonicalization, those three stop matching.
 *
 * Nothing here touches the network; there is nothing to touch. Signing is a
 * pure function of the request and the clock.
 */
import { describe, test, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  EMPTY_PAYLOAD_SHA256,
  amzDate,
  canonicalHeaders,
  canonicalRequest,
  resolveCredentials,
  sha256Hex,
  signRequest,
  signingKey,
  stringToSign,
} from "./sigv4";

/** The example secret AWS uses throughout its Signature Version 4 documentation. */
const SECRET = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
const ACCESS_KEY = "AKIDEXAMPLE";

describe("the published vectors", () => {
  test("the signing key matches the documented derivation", () => {
    // AWS, "Examples of how to derive a signing key for Signature Version 4":
    // 20120215 / us-east-1 / iam.
    expect(signingKey(SECRET, "20120215", "us-east-1", "iam").toString("hex")).toBe(
      "f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d",
    );
  });

  test("get-vanilla canonicalizes and signs exactly as the test suite says", () => {
    const { canonical, signed } = canonicalRequest(
      "GET",
      new URL("https://example.amazonaws.com/"),
      { host: "example.amazonaws.com", "x-amz-date": "20150830T123600Z" },
      EMPTY_PAYLOAD_SHA256,
    );

    expect(canonical).toBe(
      [
        "GET",
        "/",
        "",
        "host:example.amazonaws.com",
        "x-amz-date:20150830T123600Z",
        "",
        "host;x-amz-date",
        EMPTY_PAYLOAD_SHA256,
      ].join("\n"),
    );
    expect(signed).toBe("host;x-amz-date");

    const scope = "20150830/us-east-1/service/aws4_request";
    const sts = stringToSign("20150830T123600Z", scope, canonical);
    expect(sts).toBe(
      "AWS4-HMAC-SHA256\n20150830T123600Z\n" +
        `${scope}\nbb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63`,
    );

    const key = signingKey(SECRET, "20150830", "us-east-1", "service");
    expect(createHmac("sha256", key).update(sts, "utf8").digest("hex")).toBe(
      "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });

  test("the empty-payload constant is what SHA-256 of nothing actually is", () => {
    expect(sha256Hex("")).toBe(EMPTY_PAYLOAD_SHA256);
  });
});

describe("header canonicalization", () => {
  test("names lowercase and sort, values trim and collapse inner runs", () => {
    expect(
      canonicalHeaders({
        "X-Amz-Date": "20150830T123600Z",
        "Content-Type": "  application/json  ",
        Host: "example.amazonaws.com",
        "My-Header": "a   b\tc",
      }),
    ).toEqual({
      canonical:
        "content-type:application/json\nhost:example.amazonaws.com\n" +
        "my-header:a b c\nx-amz-date:20150830T123600Z\n",
      signed: "content-type;host;my-header;x-amz-date",
    });
  });

  test("sorting is by byte, so an uppercase name still sorts by its lowercase form", () => {
    expect(canonicalHeaders({ Zeta: "1", alpha: "2", MIDDLE: "3" }).signed).toBe("alpha;middle;zeta");
  });

  test("the unsignable headers are left out — signing what a proxy rewrites is an intermittent 403", () => {
    const { signed } = canonicalHeaders({
      authorization: "stale",
      "user-agent": "chant",
      "x-amzn-trace-id": "Root=1-x",
      connection: "keep-alive",
      expect: "100-continue",
      host: "example.amazonaws.com",
    });
    expect(signed).toBe("host");
  });

  test("a bodyless request hashes to the empty-payload constant, not to a hash of nothing-in-particular", () => {
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

  test("the query string sorts by name then value, RFC 3986 encoded", () => {
    const { canonical } = canonicalRequest(
      "GET",
      new URL("https://example.amazonaws.com/?b=2&a=z&a=a&c=hi%20there*"),
      { host: "example.amazonaws.com" },
      EMPTY_PAYLOAD_SHA256,
    );
    expect(canonical.split("\n")[2]).toBe("a=a&a=z&b=2&c=hi%20there%2A");
  });

  test("amzDate is ISO-8601 basic, which is what X-Amz-Date wants", () => {
    expect(amzDate(new Date("2015-08-30T12:36:00.123Z"))).toBe("20150830T123600Z");
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
