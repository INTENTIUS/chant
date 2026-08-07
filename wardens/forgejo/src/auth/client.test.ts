/**
 * Tests for the Forgejo REST client — injected fetch, no network.
 */

import { describe, it, expect } from "vitest";
import { createClient, ForgejoApiError } from "./client.js";

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function fakeFetch(handler: (rec: Recorded) => { status: number; body?: string }) {
  const calls: Recorded[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    const rec: Recorded = {
      url,
      method: init.method!,
      headers: init.headers as Record<string, string>,
      body: init.body as string | undefined,
    };
    calls.push(rec);
    const { status, body } = handler(rec);
    return {
      ok: status >= 200 && status < 300,
      status,
      async text() {
        return body ?? "";
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("createClient", () => {
  it("joins path onto <baseUrl>/api/v1 and sends token auth", async () => {
    const { fn, calls } = fakeFetch(() => ({ status: 200, body: JSON.stringify({ login: "acme" }) }));
    const client = createClient({ baseUrl: "https://forge.example.com/", token: "t0ken", fetchImpl: fn });

    const org = await client.request<{ login: string }>("GET", "/orgs/acme");
    expect(org.login).toBe("acme");
    expect(calls[0]!.url).toBe("https://forge.example.com/api/v1/orgs/acme");
    expect(calls[0]!.headers.Authorization).toBe("token t0ken");
  });

  it("serializes a JSON body and sets Content-Type", async () => {
    const { fn, calls } = fakeFetch(() => ({ status: 200, body: "{}" }));
    const client = createClient({ baseUrl: "https://forge.example.com", token: "t", fetchImpl: fn });
    await client.request("PATCH", "/orgs/acme", { description: "hi" });
    expect(calls[0]!.headers["Content-Type"]).toBe("application/json");
    expect(calls[0]!.body).toBe(JSON.stringify({ description: "hi" }));
  });

  it("returns {} for 204 / empty body", async () => {
    const { fn } = fakeFetch(() => ({ status: 204 }));
    const client = createClient({ baseUrl: "https://forge.example.com", token: "t", fetchImpl: fn });
    expect(await client.request("DELETE", "/teams/1/members/bob")).toEqual({});
  });

  it("throws ForgejoApiError with the status in the message on non-2xx", async () => {
    const { fn } = fakeFetch(() => ({ status: 404, body: '{"message":"Not Found"}' }));
    const client = createClient({ baseUrl: "https://forge.example.com", token: "t", fetchImpl: fn });
    await expect(client.request("GET", "/orgs/ghost")).rejects.toMatchObject({
      name: "ForgejoApiError",
      statusCode: 404,
    });
    await expect(client.request("GET", "/orgs/ghost")).rejects.toThrow("returned 404");
  });

  it("uses an absolute URL as-is (e.g. pagination links)", async () => {
    const { fn, calls } = fakeFetch(() => ({ status: 200, body: "[]" }));
    const client = createClient({ baseUrl: "https://forge.example.com", token: "t", fetchImpl: fn });
    await client.request("GET", "https://forge.example.com/api/v1/orgs/acme/teams?page=2");
    expect(calls[0]!.url).toBe("https://forge.example.com/api/v1/orgs/acme/teams?page=2");
  });

  it("wraps a network error", async () => {
    const fn = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const client = createClient({ baseUrl: "https://forge.example.com", token: "t", fetchImpl: fn });
    await expect(client.request("GET", "/orgs/acme")).rejects.toBeInstanceOf(ForgejoApiError);
  });
});
