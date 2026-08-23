/**
 * The AVP transport's signing decision (#1686 follow-up).
 *
 * `lexicons/aws/src/api/sigv4.test.ts` proves a SigV4 signature is correct
 * against AWS's own vectors. Nothing here re-proves that — cedar does not hold
 * the implementation and deliberately does not import it. What these cover is
 * the decision the client makes: whether a signer runs at all, what request it
 * is handed, and that the unsigned path is unchanged when one is not wired in.
 */
import { createHmac } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  avpCall,
  resolveEndpointOverride,
  resolveAvpCredentials,
  type AvpClientOptions,
  type AvpHttp,
  type AvpSignableRequest,
  type AvpSigner,
} from "./client";

const credentials = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
const now = new Date("2015-08-30T12:36:00Z");

interface Call {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** An {@link AvpHttp} that records what it was given and answers an empty object. */
function recording(): { http: AvpHttp; calls: Call[] } {
  const calls: Call[] = [];
  const http: AvpHttp = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    return { status: 200, text: "{}" };
  };
  return { http, calls };
}

/**
 * A stand-in for the aws lexicon's `signRequest`, with its shape and its
 * observable habits: it emits `x-amz-date`, a session token when there is one,
 * and an `Authorization` header of the real form, and it never emits `host`.
 * The signature is an HMAC over the body — deterministic, and enough to tell a
 * signed request from the placeholder.
 */
function stubSigner(): { signer: AvpSigner; signed: AvpSignableRequest[] } {
  const signed: AvpSignableRequest[] = [];
  const signer: AvpSigner = (request) => {
    signed.push(request);
    const timestamp = (request.now ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, "");
    const day = timestamp.slice(0, 8);
    const scope = `${day}/${request.region}/${request.service}/aws4_request`;
    const signature = createHmac("sha256", request.credentials.secretAccessKey).update(request.body).digest("hex");
    return {
      ...request.headers,
      "x-amz-date": timestamp,
      ...(request.credentials.sessionToken ? { "x-amz-security-token": request.credentials.sessionToken } : {}),
      authorization:
        `AWS4-HMAC-SHA256 Credential=${request.credentials.accessKeyId}/${scope}, ` +
        `SignedHeaders=content-type;host;x-amz-date;x-amz-target, Signature=${signature}`,
    };
  };
  return { signer, signed };
}

describe("SigV4 on the AVP read path", () => {
  test("a signer, credentials and a real host produce a signed request", async () => {
    const { http, calls } = recording();
    const { signer, signed } = stubSigner();
    await avpCall("GetPolicyStore", { policyStoreId: "PS-abc" }, {
      region: "us-west-2",
      credentials,
      signer,
      now,
      http,
      env: {},
    });

    const auth = calls[0]!.headers.authorization!;
    expect(auth).toContain("Credential=AKIDEXAMPLE/20150830/us-west-2/verifiedpermissions/aws4_request");
    expect(auth).not.toContain("Signature=unsigned");
    expect(auth).toMatch(/Signature=[0-9a-f]{64}$/);
    expect(calls[0]!.headers["x-amz-date"]).toBe("20150830T123600Z");
    // `host` is signed but never emitted: fetch computes it and forbids the override.
    expect(calls[0]!.headers.host).toBeUndefined();

    // What the signer was handed is a complete SigV4 request for this call.
    expect(signed).toHaveLength(1);
    expect(signed[0]).toMatchObject({
      method: "POST",
      url: "https://verifiedpermissions.us-west-2.amazonaws.com/",
      service: "verifiedpermissions",
      region: "us-west-2",
      body: JSON.stringify({ policyStoreId: "PS-abc" }),
      credentials,
      now,
    });
    expect(signed[0]!.headers).toEqual({
      "content-type": "application/x-amz-json-1.0",
      "x-amz-target": "VerifiedPermissions.GetPolicyStore",
    });
    // The body the signer hashed is the body that went out.
    expect(calls[0]!.body).toBe(signed[0]!.body);
  });

  test("the signer's headers are the wire headers — no placeholder scope survives", async () => {
    const { http, calls } = recording();
    const { signer } = stubSigner();
    await avpCall("ListPolicies", { policyStoreId: "PS-abc" }, {
      region: "us-west-2",
      credentials,
      signer,
      now,
      http,
      env: { AWS_ACCESS_KEY_ID: "AKIDENV" },
    });
    expect(Object.keys(calls[0]!.headers).sort()).toEqual([
      "authorization",
      "content-type",
      "x-amz-date",
      "x-amz-target",
    ]);
  });

  test("a session token rides along when the credentials are temporary", async () => {
    const { http, calls } = recording();
    const { signer } = stubSigner();
    await avpCall("ListPolicies", { policyStoreId: "PS-abc" }, {
      region: "eu-west-1",
      signer,
      now,
      http,
      env: { AWS_ACCESS_KEY_ID: "AKIDENV", AWS_SECRET_ACCESS_KEY: "s", AWS_SESSION_TOKEN: "tok" },
    });
    expect(calls[0]!.headers.authorization).toContain("Credential=AKIDENV/20150830/eu-west-1/verifiedpermissions/");
    expect(calls[0]!.headers["x-amz-security-token"]).toBe("tok");
  });

  test("signing without a named region falls back to the same default the host does", async () => {
    const { http, calls } = recording();
    const { signer, signed } = stubSigner();
    await avpCall("ListPolicies", { policyStoreId: "PS-abc" }, { credentials, signer, now, http, env: {} });
    expect(calls[0]!.url).toBe("https://verifiedpermissions.us-east-1.amazonaws.com/");
    expect(signed[0]!.region).toBe("us-east-1");
    expect(calls[0]!.headers.authorization).toContain("/20150830/us-east-1/verifiedpermissions/aws4_request");
  });
});

describe("the unsigned path, unchanged", () => {
  /** The headers one `ListPolicies` goes out with under `options`. */
  async function headersFor(options: AvpClientOptions): Promise<Record<string, string>> {
    const { http, calls } = recording();
    await avpCall("ListPolicies", { policyStoreId: "PS-abc" }, { ...options, http });
    return calls[0]!.headers;
  }

  test("no signer leaves the transport exactly as it was", async () => {
    const headers = await headersFor({ region: "us-west-2", env: {} });
    expect(Object.keys(headers).sort()).toEqual(["authorization", "content-type", "x-amz-target"]);
    expect(headers["content-type"]).toBe("application/x-amz-json-1.0");
    expect(headers["x-amz-target"]).toBe("VerifiedPermissions.ListPolicies");
    expect(headers.authorization).toContain("Credential=chant/");
    expect(headers.authorization).toContain("/us-west-2/verifiedpermissions/aws4_request");
    expect(headers.authorization).toContain("SignedHeaders=host, Signature=unsigned");
    expect(headers["x-amz-date"]).toBeUndefined();
  });

  test("a signer with nothing to sign with is byte-identical to no signer", async () => {
    const { signer, signed } = stubSigner();
    const unsigned = await headersFor({ region: "us-west-2", env: {} });
    const withSigner = await headersFor({ region: "us-west-2", signer, env: {} });
    expect(withSigner).toEqual(unsigned);
    expect(signed).toHaveLength(0);
  });

  test("a resolver that declines is respected, and the environment is not consulted behind it", async () => {
    const { signer, signed } = stubSigner();
    const headers = await headersFor({
      region: "us-west-2",
      signer,
      credentials: () => undefined,
      env: { AWS_ACCESS_KEY_ID: "AKIDENV", AWS_SECRET_ACCESS_KEY: "s" },
    });
    expect(headers.authorization).toContain("Signature=unsigned");
    expect(signed).toHaveLength(0);
  });

  test("no region still means no authorization header at all", async () => {
    const headers = await headersFor({ env: {} });
    expect(Object.keys(headers).sort()).toEqual(["content-type", "x-amz-target"]);
  });
});

describe("endpoint overrides", () => {
  test("an override is not signed, so the emulator lanes need no credentials", async () => {
    const { http, calls } = recording();
    const { signer, signed } = stubSigner();
    await avpCall("ListPolicies", { policyStoreId: "PS-abc" }, {
      endpoint: "http://localhost:4566",
      region: "us-west-2",
      credentials,
      signer,
      http,
      env: {},
    });
    expect(calls[0]!.url).toBe("http://localhost:4566/");
    expect(calls[0]!.headers.authorization).toContain("Signature=unsigned");
    expect(calls[0]!.headers["x-amz-date"]).toBeUndefined();
    expect(signed).toHaveLength(0);
  });

  test("AWS_ENDPOINT_URL counts as an override, the same as the option does", async () => {
    const { http, calls } = recording();
    const { signer, signed } = stubSigner();
    await avpCall("ListPolicies", { policyStoreId: "PS-abc" }, {
      region: "us-west-2",
      credentials,
      signer,
      http,
      env: { AWS_ENDPOINT_URL: "http://localhost:4566" },
    });
    expect(calls[0]!.url).toBe("http://localhost:4566/");
    expect(calls[0]!.headers.authorization).toContain("Signature=unsigned");
    expect(signed).toHaveLength(0);
  });

  test("AWS_ENDPOINT_URL_VERIFIEDPERMISSIONS wins over AWS_ENDPOINT_URL, and the option over both (#1694)", async () => {
    const { http, calls } = recording();
    const { signer, signed } = stubSigner();
    const env = { AWS_ENDPOINT_URL: "http://all:1", AWS_ENDPOINT_URL_VERIFIEDPERMISSIONS: "http://avp:2" };
    await avpCall("ListPolicies", { policyStoreId: "PS-abc" }, { region: "us-west-2", credentials, signer, http, env });
    await avpCall("ListPolicies", { policyStoreId: "PS-abc" }, {
      endpoint: "http://opt:3",
      region: "us-west-2",
      credentials,
      signer,
      http,
      env,
    });
    expect(calls.map((c) => c.url)).toEqual(["http://avp:2/", "http://opt:3/"]);
    expect(signed).toHaveLength(0);
    expect(resolveEndpointOverride(undefined, {})).toBeUndefined();
  });

  test("signEndpointOverride signs against an override the environment named", async () => {
    const { http, calls } = recording();
    const { signer, signed } = stubSigner();
    await avpCall("ListPolicies", { policyStoreId: "PS-abc" }, {
      region: "us-west-2",
      credentials,
      signer,
      signEndpointOverride: true,
      now,
      http,
      env: { AWS_ENDPOINT_URL: "https://vpce-1234.verifiedpermissions.us-west-2.vpce.amazonaws.com" },
    });
    expect(calls[0]!.headers.authorization).toMatch(/Signature=[0-9a-f]{64}$/);
    expect(signed[0]!.url).toBe("https://vpce-1234.verifiedpermissions.us-west-2.vpce.amazonaws.com/");
  });

  test("signEndpointOverride signs one anyway — for an override that is real AWS", async () => {
    const { http, calls } = recording();
    const { signer, signed } = stubSigner();
    await avpCall("ListPolicies", { policyStoreId: "PS-abc" }, {
      endpoint: "https://vpce-1234.verifiedpermissions.us-west-2.vpce.amazonaws.com",
      region: "us-west-2",
      credentials,
      signer,
      signEndpointOverride: true,
      now,
      http,
      env: {},
    });
    expect(calls[0]!.headers.authorization).toMatch(/Signature=[0-9a-f]{64}$/);
    expect(signed[0]!.url).toBe("https://vpce-1234.verifiedpermissions.us-west-2.vpce.amazonaws.com/");
  });
});

describe("resolveAvpCredentials", () => {
  test("literal credentials are final", () => {
    expect(resolveAvpCredentials(credentials, { AWS_ACCESS_KEY_ID: "other" })).toEqual(credentials);
  });

  test("a resolver is authoritative in both directions", () => {
    expect(resolveAvpCredentials(() => credentials, {})).toEqual(credentials);
    expect(resolveAvpCredentials(() => undefined, { AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "b" })).toBeUndefined();
  });

  test("the environment answers when nothing was passed", () => {
    expect(
      resolveAvpCredentials(undefined, {
        AWS_ACCESS_KEY_ID: "a",
        AWS_SECRET_ACCESS_KEY: "b",
        AWS_SESSION_TOKEN: "t",
      }),
    ).toEqual({ accessKeyId: "a", secretAccessKey: "b", sessionToken: "t" });
  });

  test("a half-set environment is absent, not a signature that cannot verify", () => {
    expect(resolveAvpCredentials(undefined, { AWS_ACCESS_KEY_ID: "a" })).toBeUndefined();
    expect(resolveAvpCredentials(undefined, { AWS_SECRET_ACCESS_KEY: "b" })).toBeUndefined();
    expect(resolveAvpCredentials(undefined, {})).toBeUndefined();
  });
});
