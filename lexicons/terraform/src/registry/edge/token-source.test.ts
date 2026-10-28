// Lambda@Edge tokens from SSM Parameter Store or Secrets Manager (chant#4590), tested as a handler in
// process with a fake fetch standing in for both AWS APIs: no AWS call, real or emulated, and no deploy.
import { describe, expect, it, vi } from "vitest";
import { signV4 } from "@intentius/chant/cloud-lister/sigv4";
import { downloadDoc } from "../index";
import {
  FAILED_READ_BACKOFF_MS,
  lambdaEdgeHandler,
  parseStoredTokens,
  signV4Web,
  type CloudFrontRequestEvent,
  type EdgeAwsFetch,
  type RegistryEdgeOptions,
} from "./index";

const HOST = "modules.test";
const DIR = "v1/modules/acme/net/generic";
const TARBALL = `https://${HOST}/${DIR}/0.1.0/net-0.1.0.tar.gz`;
const credentials = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", sessionToken: "session" };
const T0 = 1_800_000_000_000;

const objects = new Map<string, string>([[`${DIR}/0.1.0/download`, downloadDoc(TARBALL)]]);
const files: RegistryEdgeOptions["files"] = async (key) => ({ body: objects.get(key) });

const event = (uri: string, token?: string): CloudFrontRequestEvent => ({
  Records: [{ cf: { request: { uri, querystring: "", method: "GET", headers: { host: [{ key: "Host", value: HOST }], ...(token ? { authorization: [{ key: "Authorization", value: `Bearer ${token}` }] } : {}) } } } }],
});

const status = (answer: unknown): string | undefined => (answer && typeof answer === "object" && "status" in answer ? String((answer as { status: string }).status) : undefined);
const passedOn = (answer: unknown): boolean => !!answer && typeof answer === "object" && "uri" in answer;

/**
 * Waits for the read the handler starts when it is made. It signs with WebCrypto before it calls
 * fetch, and that digest settles off the microtask queue, so the call lands a moment after.
 */
const firstRead = (calls: Call[]): Promise<void> => vi.waitFor(() => expect(calls.length).toBeGreaterThan(0), { timeout: 2_000, interval: 5 });

interface Call {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** A fake SSM and Secrets Manager: answers from `values`, records each call, fails while `down` is set. */
function fakeAws(values: { ssm?: Record<string, string>; secrets?: Record<string, string> }) {
  const calls: Call[] = [];
  const state = { down: false as false | "network" | number };
  const fetch: EdgeAwsFetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    if (state.down === "network") throw new Error("connect ETIMEDOUT");
    const reply = (code: number, doc: unknown) => ({ ok: code < 300, status: code, text: async () => JSON.stringify(doc) });
    if (typeof state.down === "number") return reply(state.down, { __type: "com.amazonaws#ThrottlingException" });
    const target = init.headers["x-amz-target"];
    const req = JSON.parse(init.body) as { Name?: string; SecretId?: string; WithDecryption?: boolean };
    if (target === "AmazonSSM.GetParameter") {
      const value = values.ssm?.[req.Name!];
      return value === undefined ? reply(400, { __type: "ParameterNotFound" }) : reply(200, { Parameter: { Name: req.Name, Type: "SecureString", Value: value } });
    }
    if (target === "secretsmanager.GetSecretValue") {
      const value = values.secrets?.[req.SecretId!];
      return value === undefined ? reply(400, { __type: "ResourceNotFoundException" }) : reply(200, { Name: req.SecretId, SecretString: value });
    }
    return reply(400, { __type: "UnknownOperationException" });
  };
  return { fetch, calls, state, values };
}

describe("tokens in the zip (the default source)", () => {
  it("keeps auth.tokens working with no store read", async () => {
    const aws = fakeAws({});
    const handler = lambdaEdgeHandler({ files, auth: { tokens: ["zip-token"] }, now: () => T0 });
    expect(status(await handler(event(`/${DIR}/versions`)))).toBe("401");
    expect(passedOn(await handler(event(`/${DIR}/versions`, "zip-token")))).toBe(true);
    const explicit = lambdaEdgeHandler({ files, auth: { tokens: ["zip-token"], source: { kind: "zip" } }, now: () => T0 });
    expect(passedOn(await explicit(event(`/${DIR}/versions`, "zip-token")))).toBe(true);
    expect(aws.calls).toEqual([]);
  });
});

describe("tokens from SSM Parameter Store", () => {
  it("reads the parameter at cold start with a signed GetParameter call, and checks requests against it", async () => {
    const aws = fakeAws({ ssm: { "/registry/tokens": "old-token,new-token" } });
    const handler = lambdaEdgeHandler({ files, auth: { source: { kind: "ssm", name: "/registry/tokens", region: "us-east-1", credentials, fetch: aws.fetch } }, now: () => T0 });
    // The read starts when the handler is made, before any request.
    await firstRead(aws.calls);
    expect(aws.calls).toHaveLength(1);
    const call = aws.calls[0]!;
    expect(call.url).toBe("https://ssm.us-east-1.amazonaws.com/");
    expect(JSON.parse(call.body)).toEqual({ Name: "/registry/tokens", WithDecryption: true });
    expect(call.headers["x-amz-target"]).toBe("AmazonSSM.GetParameter");
    expect(call.headers["x-amz-security-token"]).toBe("session");
    expect(call.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/ssm\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-amz-target, Signature=[0-9a-f]{64}$/);

    expect(status(await handler(event(`/${DIR}/versions`)))).toBe("401");
    expect(status(await handler(event(`/${DIR}/versions`, "wrong")))).toBe("401");
    expect(passedOn(await handler(event(`/${DIR}/versions`, "old-token")))).toBe(true);
    expect(passedOn(await handler(event(`/${DIR}/versions`, "new-token")))).toBe(true);
    // Within the cache time the parameter is not read again.
    expect(aws.calls).toHaveLength(1);
  });

  it("picks up a rotated parameter after cacheSeconds, with no redeploy", async () => {
    let now = T0;
    const aws = fakeAws({ ssm: { "/registry/tokens": "old-token" } });
    const handler = lambdaEdgeHandler({ files, auth: { source: { kind: "ssm", name: "/registry/tokens", cacheSeconds: 60, credentials, fetch: aws.fetch } }, now: () => now });
    expect(passedOn(await handler(event(`/${DIR}/versions`, "old-token")))).toBe(true);

    aws.values.ssm!["/registry/tokens"] = "new-token";
    now += 30_000;
    // Still the cached read: the old token holds until the cache runs out, and never longer.
    expect(passedOn(await handler(event(`/${DIR}/versions`, "old-token")))).toBe(true);
    now += 31_000;
    expect(status(await handler(event(`/${DIR}/versions`, "old-token")))).toBe("401");
    expect(passedOn(await handler(event(`/${DIR}/versions`, "new-token")))).toBe(true);
    expect(aws.calls).toHaveLength(2);
  });

  it("caps the cache time at an hour", async () => {
    let now = T0;
    const aws = fakeAws({ ssm: { p: "t" } });
    const handler = lambdaEdgeHandler({ files, auth: { source: { kind: "ssm", name: "p", cacheSeconds: 86_400, credentials, fetch: aws.fetch } }, now: () => now });
    await handler(event(`/${DIR}/versions`, "t"));
    now += 3_600_001;
    await handler(event(`/${DIR}/versions`, "t"));
    expect(aws.calls).toHaveLength(2);
  });

  it("shares one read between requests that arrive while it is in flight", async () => {
    const aws = fakeAws({ ssm: { p: "t" } });
    const handler = lambdaEdgeHandler({ files, auth: { source: { kind: "ssm", name: "p", credentials, fetch: aws.fetch } }, now: () => T0 });
    const answers = await Promise.all([1, 2, 3].map(() => handler(event(`/${DIR}/versions`, "t"))));
    expect(answers.every(passedOn)).toBe(true);
    expect(aws.calls).toHaveLength(1);
  });

  it("reads the region it is given, never the replica's", async () => {
    const aws = fakeAws({ ssm: { p: "t" } });
    lambdaEdgeHandler({ files, auth: { source: { kind: "ssm", name: "p", region: "eu-west-1", credentials, fetch: aws.fetch } } });
    await firstRead(aws.calls);
    expect(aws.calls[0]!.url).toBe("https://ssm.eu-west-1.amazonaws.com/");
    expect(aws.calls[0]!.headers.authorization).toContain("/eu-west-1/ssm/aws4_request");
  });
});

describe("tokens from Secrets Manager", () => {
  it("reads SecretString with a signed GetSecretValue call, JSON form with a signing key", async () => {
    const aws = fakeAws({ secrets: { "registry/tokens": JSON.stringify({ tokens: ["s3cret"], signingKey: "sign-key" }) } });
    const handler = lambdaEdgeHandler({ files, auth: { source: { kind: "secrets-manager", secretId: "registry/tokens", credentials, fetch: aws.fetch } }, now: () => T0 });
    await firstRead(aws.calls);
    const call = aws.calls[0]!;
    expect(call.url).toBe("https://secretsmanager.us-east-1.amazonaws.com/");
    expect(call.headers["x-amz-target"]).toBe("secretsmanager.GetSecretValue");
    expect(JSON.parse(call.body)).toEqual({ SecretId: "registry/tokens" });
    expect(call.headers.authorization).toContain("/us-east-1/secretsmanager/aws4_request");

    expect(status(await handler(event(`/${DIR}/versions`)))).toBe("401");
    const download = await handler(event(`/${DIR}/0.1.0/download`, "s3cret"));
    expect(status(download)).toBe("200");
    const location = new URL((download as { headers: Record<string, { value: string }[]> }).headers["x-terraform-get"]![0]!.value);
    expect(location.searchParams.get("signature")).toBeTruthy();
  });

  it("takes a plain-text secret, one token per line", async () => {
    const aws = fakeAws({ secrets: { s: "a-token\nb-token\n" } });
    const handler = lambdaEdgeHandler({ files, auth: { source: { kind: "secrets-manager", secretId: "s", credentials, fetch: aws.fetch } }, now: () => T0 });
    expect(passedOn(await handler(event(`/${DIR}/versions`, "b-token")))).toBe(true);
  });

  it("takes credentials from a function, such as a role the caller assumes", async () => {
    const aws = fakeAws({ secrets: { s: "t" } });
    const handler = lambdaEdgeHandler({ files, auth: { source: { kind: "secrets-manager", secretId: "s", credentials: async () => ({ accessKeyId: "AKIDFN", secretAccessKey: "x" }), fetch: aws.fetch } }, now: () => T0 });
    expect(passedOn(await handler(event(`/${DIR}/versions`, "t")))).toBe(true);
    expect(aws.calls[0]!.headers.authorization).toContain("Credential=AKIDFN/");
    expect(aws.calls[0]!.headers["x-amz-security-token"]).toBeUndefined();
  });
});

describe("fails closed", () => {
  it("answers 503 and never passes a request on while the store cannot be reached", async () => {
    const aws = fakeAws({ ssm: { p: "t" } });
    aws.state.down = "network";
    const log: string[] = [];
    const handler = lambdaEdgeHandler({ files, auth: { source: { kind: "ssm", name: "p", credentials, fetch: aws.fetch } }, now: () => T0, log: (l) => log.push(l) });
    const answer = await handler(event(`/${DIR}/versions`, "t"));
    expect(status(answer)).toBe("503");
    expect((answer as { headers: Record<string, { value: string }[]> }).headers["cache-control"]![0]!.value).toBe("no-store");
    expect(status(await handler(event(`/${DIR}/0.1.0/download`, "t")))).toBe("503");
    expect(log.join("\n")).toContain("token store:");
    expect(log.join("\n")).not.toContain("Bearer");
  });

  it("refuses on an AWS error answer, a missing parameter, or a value with no token", async () => {
    for (const [values, down] of [[{ ssm: { p: "t" } }, 400], [{ ssm: {} }, false], [{ ssm: { p: " ,\n " } }, false], [{ ssm: { p: "{not json" } }, false]] as const) {
      const aws = fakeAws(values as { ssm: Record<string, string> });
      aws.state.down = down;
      const handler = lambdaEdgeHandler({ files, auth: { source: { kind: "ssm", name: "p", credentials, fetch: aws.fetch } }, now: () => T0 });
      expect(status(await handler(event(`/${DIR}/versions`, "t")))).toBe("503");
    }
  });

  it("drops the cached tokens when a refresh fails, then recovers after the backoff", async () => {
    let now = T0;
    const aws = fakeAws({ ssm: { p: "t" } });
    const handler = lambdaEdgeHandler({ files, auth: { source: { kind: "ssm", name: "p", cacheSeconds: 60, credentials, fetch: aws.fetch } }, now: () => now });
    expect(passedOn(await handler(event(`/${DIR}/versions`, "t")))).toBe(true);
    aws.state.down = 500;
    now += 61_000;
    expect(status(await handler(event(`/${DIR}/versions`, "t")))).toBe("503");
    // Within the backoff the store is not read again on every request.
    expect(status(await handler(event(`/${DIR}/versions`, "t")))).toBe("503");
    expect(aws.calls).toHaveLength(2);
    aws.state.down = false;
    now += FAILED_READ_BACKOFF_MS + 1;
    expect(passedOn(await handler(event(`/${DIR}/versions`, "t")))).toBe(true);
    expect(aws.calls).toHaveLength(3);
  });

  it("refuses when there are no credentials in the runtime", async () => {
    const aws = fakeAws({ ssm: { p: "t" } });
    const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process!.env;
    const saved = { id: env.AWS_ACCESS_KEY_ID, secret: env.AWS_SECRET_ACCESS_KEY };
    delete env.AWS_ACCESS_KEY_ID;
    delete env.AWS_SECRET_ACCESS_KEY;
    try {
      const handler = lambdaEdgeHandler({ files, auth: { source: { kind: "ssm", name: "p", fetch: aws.fetch } }, now: () => T0 });
      expect(status(await handler(event(`/${DIR}/versions`, "t")))).toBe("503");
      expect(aws.calls).toEqual([]);
    } finally {
      if (saved.id !== undefined) env.AWS_ACCESS_KEY_ID = saved.id;
      if (saved.secret !== undefined) env.AWS_SECRET_ACCESS_KEY = saved.secret;
    }
  });
});

describe("parseStoredTokens", () => {
  it("reads the line and comma form and the JSON form", () => {
    expect(parseStoredTokens("a, b\nc")).toEqual({ tokens: ["a", "b", "c"] });
    expect(parseStoredTokens('{"tokens":"a,b"}')).toEqual({ tokens: ["a", "b"] });
    expect(parseStoredTokens('{"tokens":["a"," b "],"signingKey":"k"}')).toEqual({ tokens: ["a", "b"], signingKey: "k" });
    expect(() => parseStoredTokens("{oops")).toThrow("do not parse");
  });
});

describe("signV4Web", () => {
  it("signs exactly as chant core's signer does", async () => {
    const input = {
      method: "POST",
      url: "https://ssm.us-east-1.amazonaws.com/",
      headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": "AmazonSSM.GetParameter" },
      body: JSON.stringify({ Name: "/registry/tokens", WithDecryption: true }),
      region: "us-east-1",
      service: "ssm",
      credentials,
      now: new Date(T0),
    };
    expect(await signV4Web(input)).toEqual(signV4(input));
  });
});
