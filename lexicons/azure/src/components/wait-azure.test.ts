import { describe, expect, it } from "vitest";
import type { AzHttp } from "../op/activities/az-apply";
import { createWaitContainerAppCapability, createWaitForDeploymentCapability } from "./wait-azure";
import { describeStackStatus } from "../describe-stack-status";

const ctx = { env: "dev", component: "web" };
const base = "/subscriptions/s/resourceGroups/web";

/** A group whose resources change state after each poll: `states[i]` per resource, per round. */
function fakeGroup(rounds: string[][], tags: Record<string, string> = { "chant-managed-by": "chant" }) {
  let round = 0;
  const http: AzHttp = async (_m, url) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/resources")) {
      const value = rounds[0]!.map((_, i) => ({ id: `${base}/providers/Microsoft.Storage/storageAccounts/a${i}`, name: `a${i}`, type: "Microsoft.Storage/storageAccounts", tags }));
      return { status: 200, text: JSON.stringify({ value }) };
    }
    const i = Number(/a(\d+)$/.exec(path)![1]);
    const state = rounds[Math.min(round, rounds.length - 1)]![i]!;
    if (i === rounds[0]!.length - 1) round++;
    return { status: 200, text: JSON.stringify({ name: `a${i}`, properties: { provisioningState: state } }) };
  };
  return http;
}

const fast = { sleep: async () => {}, now: () => 0 };

describe("wait-for-deployment (#3142)", () => {
  it("polls until every resource is terminal", async () => {
    const cap = createWaitForDeploymentCapability({ ...fast, http: fakeGroup([["Creating", "Succeeded"], ["Succeeded", "Succeeded"]]) });
    const out = await cap.run(ctx, { endpoint: "http://x" });
    expect(out.resources.map((r) => r.state)).toEqual(["Succeeded", "Succeeded"]);
  });

  it("throws when a resource fails", async () => {
    const cap = createWaitForDeploymentCapability({ ...fast, http: fakeGroup([["Failed"]]) });
    await expect(cap.run(ctx, { endpoint: "http://x" })).rejects.toThrow(/ended Failed/);
  });

  it("times out while still provisioning", async () => {
    let t = 0;
    const cap = createWaitForDeploymentCapability({ sleep: async () => {}, now: () => (t += 1000), http: fakeGroup([["Creating"]]) });
    await expect(cap.run(ctx, { endpoint: "http://x", timeoutMs: 1500 })).rejects.toThrow(/timed out.*Creating/);
  });

  it("declares no rollback", () => {
    expect(createWaitForDeploymentCapability().rollback).toBeUndefined();
  });
});

describe("wait-container-app (#3142)", () => {
  const app = (props: Record<string, unknown>): AzHttp => async () => ({ status: 200, text: JSON.stringify({ properties: props }) });

  it("returns once the latest revision is the latest ready one", async () => {
    let n = 0;
    const http: AzHttp = async () => {
      const ready = ++n > 1;
      return {
        status: 200,
        text: JSON.stringify({ properties: { provisioningState: "Succeeded", latestRevisionName: "app--2", latestReadyRevisionName: ready ? "app--2" : "app--1", configuration: { ingress: { fqdn: "app.example" } } } }),
      };
    };
    const out = await createWaitContainerAppCapability({ ...fast, http }).run(ctx, { app: "app", endpoint: "http://x" });
    expect(out).toEqual({ revision: "app--2", fqdn: "app.example" });
    expect(n).toBe(2);
  });

  it("throws on a failed provisioning state", async () => {
    const cap = createWaitContainerAppCapability({ ...fast, http: app({ provisioningState: "Failed" }) });
    await expect(cap.run(ctx, { app: "app", endpoint: "http://x" })).rejects.toThrow(/ended Failed/);
  });
});

describe("azure describeStackStatus (#3142)", () => {
  it("is present and healthy when owned resources all succeeded", async () => {
    const obs = await describeStackStatus({ environment: "dev", stack: "web" }, { endpoint: "http://x", http: fakeGroup([["Succeeded", "Succeeded"]]) });
    expect(obs).toEqual({ stack: "web", present: true, status: "2/2 resources succeeded", healthy: true });
  });

  it("is unhealthy while one is still creating", async () => {
    const obs = await describeStackStatus({ environment: "dev", stack: "web" }, { endpoint: "http://x", http: fakeGroup([["Succeeded", "Creating"]]) });
    expect(obs).toMatchObject({ present: true, healthy: false });
  });

  it("is absent when nothing in the group is chant-owned", async () => {
    const obs = await describeStackStatus({ environment: "dev", stack: "web" }, { endpoint: "http://x", http: fakeGroup([["Succeeded"]], {}) });
    expect(obs).toEqual({ stack: "web", present: false });
  });

  it("is absent on a 404 group and indeterminate on a server error", async () => {
    const notFound: AzHttp = async () => ({ status: 404, text: "{}" });
    expect(await describeStackStatus({ environment: "dev", stack: "web" }, { endpoint: "http://x", http: notFound })).toEqual({ stack: "web", present: false });
    const boom: AzHttp = async () => ({ status: 500, text: "{}" });
    expect(await describeStackStatus({ environment: "dev", stack: "web" }, { endpoint: "http://x", http: boom })).toBeNull();
  });
});
