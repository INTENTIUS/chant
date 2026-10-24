import { describe, expect, it } from "vitest";
import type { GcpReadHttp } from "../api/read-client";
import { createWaitCloudRunReadyCapability, createWaitForOperationCapability } from "./wait-gcp";
import { describeStackStatus } from "../describe-stack-status";
import { MAPPERS } from "../op/activities/gcp-apply";

const ctx = { env: "dev", component: "web" };
const fast = { sleep: async () => {}, now: () => 0 };
const ok = (body: unknown) => ({ status: 200, text: JSON.stringify(body) });

describe("wait-for-operation (#3143)", () => {
  it("polls until done and returns the response", async () => {
    let n = 0;
    const http: GcpReadHttp = async () => ok(++n < 3 ? { done: false } : { done: true, response: { name: "svc" } });
    const out = await createWaitForOperationCapability({ ...fast, http }).run(ctx, { operation: "http://gcp.test/v2/projects/p/locations/l/operations/o" });
    expect(out).toEqual({ response: { name: "svc" } });
    expect(n).toBe(3);
  });

  it("throws the operation's error", async () => {
    const http: GcpReadHttp = async () => ok({ done: true, error: { message: "quota exceeded" } });
    await expect(createWaitForOperationCapability({ ...fast, http }).run(ctx, { operation: "http://gcp.test/op" })).rejects.toThrow(/quota exceeded/);
  });

  it("resolves a bare name against the endpoint", async () => {
    const urls: string[] = [];
    const http: GcpReadHttp = async (_m, url) => (urls.push(url), ok({ done: true }));
    await createWaitForOperationCapability({ ...fast, http }).run(ctx, { operation: "projects/p/operations/o", endpoint: "http://gcp.test/" });
    expect(urls).toEqual(["http://gcp.test/v2/projects/p/operations/o"]);
  });

  it("declares no rollback", () => {
    expect(createWaitForOperationCapability().rollback).toBeUndefined();
  });
});

describe("wait-cloud-run-ready (#3143)", () => {
  it("returns once the terminal condition succeeded on the latest revision", async () => {
    let n = 0;
    const http: GcpReadHttp = async (_m, url) => {
      expect(url).toContain("/v2/projects/p/locations/europe-west1/services/web");
      return ok(++n < 2
        ? { terminalCondition: { state: "CONDITION_RECONCILING" }, reconciling: true, latestCreatedRevision: "web-2", latestReadyRevision: "web-1" }
        : { terminalCondition: { state: "CONDITION_SUCCEEDED" }, latestCreatedRevision: "web-2", latestReadyRevision: "web-2", uri: "https://web.run.app" });
    };
    const out = await createWaitCloudRunReadyCapability({ ...fast, http }).run(ctx, { service: "web", project: "p", location: "europe-west1", endpoint: "http://gcp.test" });
    expect(out).toEqual({ revision: "web-2", uri: "https://web.run.app" });
  });

  it("throws on a failed condition", async () => {
    const http: GcpReadHttp = async () => ok({ terminalCondition: { state: "CONDITION_FAILED", message: "bad image" } });
    await expect(createWaitCloudRunReadyCapability({ ...fast, http }).run(ctx, { service: "web", project: "p", endpoint: "http://gcp.test" })).rejects.toThrow(/bad image/);
  });

  it("times out when the service never appears", async () => {
    let t = 0;
    const http: GcpReadHttp = async () => ({ status: 404, text: "{}" });
    await expect(
      createWaitCloudRunReadyCapability({ sleep: async () => {}, now: () => (t += 1000), http }).run(ctx, { service: "web", project: "p", endpoint: "http://gcp.test", timeoutMs: 1500 }),
    ).rejects.toThrow(/timed out in state NOT_FOUND/);
  });
});

describe("gcp describeStackStatus (#3143)", () => {
  const listKind = Object.entries(MAPPERS).find(([, m]) => m.list)!;
  const withItems = (items: unknown): GcpReadHttp => {
    const url = listKind[1].list!.url({ base: "http://gcp.test", project: "p" });
    return async (_m, u) => (u === url ? ok(items) : { status: 404, text: "{}" });
  };
  const bodyFor = (labels: Record<string, string>) => {
    const sample = listKind[1].list!;
    // Build whatever shape this kind's `items` reads by trying the common ones.
    for (const shape of [{ items: [{ name: "r", labels }] }, { buckets: [{ name: "r", labels }] }, { topics: [{ name: "r", labels }] }]) {
      if (sample.items(shape).length) return shape;
    }
    throw new Error("unknown list shape");
  };

  it("is present when an owned resource carries the stack label", async () => {
    const obs = await describeStackStatus({ environment: "dev", stack: "web" }, { project: "p", endpoint: "http://gcp.test", http: withItems(bodyFor({ "managed-by": "chant", "chant-stack": "web" })) });
    expect(obs).toMatchObject({ stack: "web", present: true });
  });

  it("is indeterminate when owned resources carry no stack label", async () => {
    const obs = await describeStackStatus({ environment: "dev", stack: "web" }, { project: "p", endpoint: "http://gcp.test", http: withItems(bodyFor({ "managed-by": "chant" })) });
    expect(obs).toBeNull();
  });

  it("is absent when lists work and nothing is owned", async () => {
    const obs = await describeStackStatus({ environment: "dev", stack: "web" }, { project: "p", endpoint: "http://gcp.test", http: withItems(bodyFor({})) });
    expect(obs).toEqual({ stack: "web", present: false });
  });

  it("is indeterminate when every list fails or there is no project", async () => {
    const down: GcpReadHttp = async () => ({ status: 500, text: "" });
    expect(await describeStackStatus({ environment: "dev", stack: "web" }, { project: "p", http: down })).toBeNull();
  });
});
