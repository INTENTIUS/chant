import { describe, expect, it } from "vitest";
import { AwsApiError, createClient } from "./client.js";
import { signRequest } from "./sigv4.js";

const CREDS = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" };

function fakeFetch(handler: (url: string, init: RequestInit) => { status?: number; body?: unknown }): typeof fetch {
  return (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const { status = 200, body = {} } = handler(String(url), init!);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
}

describe("sigv4", () => {
  it("signs deterministically and includes the session token when present", () => {
    const base = {
      method: "POST",
      url: new URL("https://organizations.us-east-1.amazonaws.com/"),
      headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": "T.A" },
      body: "{}",
      service: "organizations",
      region: "us-east-1",
      date: new Date("2026-08-07T12:00:00Z"),
    };
    const a = signRequest({ ...base, credentials: CREDS });
    const b = signRequest({ ...base, credentials: CREDS });
    expect(a.authorization).toBe(b.authorization);
    expect(a.authorization).toContain("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260807/us-east-1/organizations/aws4_request");
    expect(a.authorization).toContain("SignedHeaders=content-type;host;x-amz-date;x-amz-target");
    expect(a["x-amz-date"]).toBe("20260807T120000Z");

    const withToken = signRequest({ ...base, credentials: { ...CREDS, sessionToken: "tok" } });
    expect(withToken["x-amz-security-token"]).toBe("tok");
    expect(withToken.authorization).toContain("x-amz-security-token");
  });
});

describe("aws client", () => {
  it("sends x-amz-json-1.1 RPC with the right target and parses the response", async () => {
    let seen: { url: string; target?: string; body?: string } = { url: "" };
    const client = createClient({
      credentials: CREDS,
      fetchImpl: fakeFetch((url, init) => {
        seen = {
          url,
          target: (init.headers as Record<string, string>)["x-amz-target"],
          body: String(init.body),
        };
        return { body: { Roots: [{ Id: "r-1" }] } };
      }),
    });
    const res = await client.request<{ Roots: unknown[] }>("organizations", "ListRoots");
    expect(seen.url).toBe("https://organizations.us-east-1.amazonaws.com/");
    expect(seen.target).toBe("AWSOrganizationsV20161128.ListRoots");
    expect(res.Roots).toHaveLength(1);
  });

  it("honours the endpoint override (floci) and surfaces typed AWS errors", async () => {
    const client = createClient({
      credentials: CREDS,
      endpointUrl: "http://localhost:4566",
      fetchImpl: fakeFetch((url) => {
        expect(url).toBe("http://localhost:4566/");
        return { status: 400, body: { __type: "x#PolicyNotFoundException", message: "no such policy" } };
      }),
    });
    await expect(client.request("organizations", "DescribePolicy", { PolicyId: "p-x" })).rejects.toThrowError(
      AwsApiError,
    );
    await expect(client.request("organizations", "DescribePolicy", { PolicyId: "p-x" })).rejects.toMatchObject({
      statusCode: 400,
      errorType: "PolicyNotFoundException",
    });
  });

  it("paginate follows NextToken to the end", async () => {
    let calls = 0;
    const client = createClient({
      credentials: CREDS,
      fetchImpl: fakeFetch((_url, init) => {
        calls++;
        const req = JSON.parse(String(init.body)) as { NextToken?: string };
        return req.NextToken
          ? { body: { Accounts: [{ Id: "2" }] } }
          : { body: { Accounts: [{ Id: "1" }], NextToken: "t" } };
      }),
    });
    const all = await client.paginate<{ Id: string }>("organizations", "ListAccounts", {}, (p) => p.Accounts as never);
    expect(all.map((a) => a.Id)).toEqual(["1", "2"]);
    expect(calls).toBe(2);
  });
});
