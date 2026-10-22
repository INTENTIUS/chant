import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCapabilityPlugin } from "@intentius/chant/components/capability-plugin";
import { buildCapabilityRegistry } from "@intentius/chant/components/capability-plugin-loader";
import { isPlanMovedError } from "@intentius/chant/components/capability";
import type { GcpHttp } from "../op/activities/gcp-apply";
import { createGcpApplyCapability, GcpPlanMovedError, readOnlyHttp } from "./gcp-apply";
import { gcpCapabilityPlugin } from "./capability-plugin";

/**
 * An in-memory GCP behind the applier's REST paths: buckets, topics and
 * Cloud Run services, keyed by URL path. Records every request.
 */
function fakeGcp() {
  const store = new Map<string, Record<string, unknown>>();
  const calls: Array<{ method: string; url: string }> = [];
  const http: GcpHttp = async (method, url, body) => {
    calls.push({ method, url });
    const u = new URL(url);
    const path = u.pathname;
    const b = (body ?? {}) as Record<string, unknown>;
    const found = (p: string) => (store.has(p) ? { status: 200, text: JSON.stringify(store.get(p)) } : { status: 404, text: "not found" });
    if (method === "GET") {
      if (path.endsWith("/storage/v1/b")) {
        return { status: 200, text: JSON.stringify({ items: [...store.entries()].filter(([k]) => k.startsWith("/storage/v1/b/")).map(([, v]) => v) }) };
      }
      if (path.includes("/operations/")) return { status: 200, text: JSON.stringify({ done: true }) };
      return found(path);
    }
    if (method === "POST" && path.endsWith("/storage/v1/b")) {
      store.set(`${path}/${b.name as string}`, { ...b });
      return { status: 200, text: JSON.stringify(b) };
    }
    if (method === "POST" && path.endsWith("/services")) {
      const id = u.searchParams.get("serviceId")!;
      store.set(`${path}/${id}`, { ...b, name: id, uri: `https://${id}-abc.a.run.app` });
      return { status: 200, text: JSON.stringify({ name: "projects/p/locations/us-central1/operations/op1" }) };
    }
    if (method === "PUT") {
      store.set(path, { ...b, name: path.split("/").pop() });
      return { status: 200, text: JSON.stringify(b) };
    }
    if (method === "PATCH") {
      const patch = (b.topic ?? b) as Record<string, unknown>;
      store.set(path, { ...store.get(path), ...patch });
      return { status: 200, text: JSON.stringify(store.get(path)) };
    }
    if (method === "DELETE") {
      store.delete(path);
      return { status: 200, text: "{}" };
    }
    return { status: 400, text: `unhandled ${method} ${url}` };
  };
  return { store, calls, http, writes: () => calls.filter((c) => c.method !== "GET") };
}

const bucket = (name: string, storageClass = "STANDARD") => ({
  apiVersion: "storage.cnrm.cloud.google.com/v1beta1",
  kind: "StorageBucket",
  metadata: { name, annotations: { "cnrm.cloud.google.com/project-id": "test-project" } },
  spec: { location: "us-central1", storageClass },
});
const topic = { apiVersion: "pubsub.cnrm.cloud.google.com/v1beta1", kind: "PubSubTopic", metadata: { name: "events" }, spec: {} };
const service = {
  apiVersion: "run.cnrm.cloud.google.com/v1beta1",
  kind: "RunService",
  metadata: { name: "web" },
  spec: { location: "us-central1", template: { containers: [{ image: "us-docker.pkg.dev/test/web:1" }] } },
};

const ctx = { env: "test", component: "gcp-app" };
const ENV_KEYS = ["GCP_ENDPOINT_URL", "GCP_PROJECT_ID", "GOOGLE_CLOUD_PROJECT"] as const;

describe("gcp-apply (#4273)", () => {
  let dir: string;
  let manifest: string;
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
  const write = (resources: unknown[]): void => writeFileSync(manifest, JSON.stringify(resources));

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.GCP_ENDPOINT_URL = "http://floci.test:4588";
    process.env.GCP_PROJECT_ID = "test-project";
    delete process.env.GOOGLE_CLOUD_PROJECT;
    dir = mkdtempSync(join(tmpdir(), "gcp-apply-step-"));
    manifest = join(dir, "manifest.json");
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("plans creates without writing, applies them, then plans no change with the Cloud Run URL known", async () => {
    const gcp = fakeGcp();
    const capability = createGcpApplyCapability(gcp.http);
    write([bucket("assets"), topic, service]);

    const first = await capability.plan!(ctx, { manifest });
    expect(gcp.writes()).toEqual([]);
    expect(first.member).toBe("gcp-app");
    expect(first.changeSet!.entries.map((e) => [e.address, e.action])).toEqual([
      ["PubSubTopic/events", "create"],
      ["RunService/web", "create"],
      ["StorageBucket/assets", "create"],
    ]);
    expect(first.changeSet!.entries.every((e) => e.lexicon === "gcp" && e.planner === "chant" && e.scope === "test-project")).toBe(true);
    expect(first.outputs).toEqual({ known: {}, unknown: ["webUri"] });
    // Every read went to the endpoint override.
    expect(gcp.calls.every((c) => c.url.startsWith("http://floci.test:4588/"))).toBe(true);

    const applied = await capability.run({ ...ctx, plans: { "gcp-app": first.artifact } }, { manifest });
    expect(applied.applied.map((a) => [a.kind, a.created])).toEqual([
      ["StorageBucket", true],
      ["PubSubTopic", true],
      ["RunService", true],
    ]);
    expect(applied.outputs).toEqual({ webUri: "https://web-abc.a.run.app" });

    const second = await capability.plan!(ctx, { manifest });
    expect(second.changeSet!.entries.map((e) => e.action)).toEqual(["no-op", "no-op", "no-op"]);
    expect(second.outputs).toEqual({ known: { webUri: "https://web-abc.a.run.app" }, unknown: [] });
    await expect(capability.outputs!(ctx, { manifest })).resolves.toEqual({ webUri: "https://web-abc.a.run.app" });

    // Applying again agrees with the plan: nothing is sent.
    const before = gcp.writes().length;
    const again = await capability.run(ctx, { manifest });
    expect(again.applied.every((a) => !a.created && !a.updated)).toBe(true);
    expect(gcp.writes().length).toBe(before);
  });

  test("an update names each changed field with its value before and after, and run refuses a plan the manifest moved past", async () => {
    const gcp = fakeGcp();
    const capability = createGcpApplyCapability(gcp.http);
    write([bucket("assets")]);
    await capability.run(ctx, { manifest });

    write([bucket("assets", "NEARLINE")]);
    const plan = await capability.plan!(ctx, { manifest });
    expect(plan.changeSet!.entries).toEqual([
      expect.objectContaining({
        address: "StorageBucket/assets",
        action: "update",
        disruption: "in-place",
        attributes: [{ path: "storageClass", before: "STANDARD", after: "NEARLINE" }],
      }),
    ]);

    write([bucket("assets", "COLDLINE")]);
    const moved = capability.run({ ...ctx, plans: { "gcp-app": plan.artifact } }, { manifest });
    await expect(moved).rejects.toBeInstanceOf(GcpPlanMovedError);
    await expect(moved).rejects.toSatisfy(isPlanMovedError);
    expect(gcp.store.get("/storage/v1/b/assets")!.storageClass).toBe("STANDARD");

    write([bucket("assets", "NEARLINE")]);
    const done = await capability.run({ ...ctx, plans: { "gcp-app": plan.artifact } }, { manifest });
    expect(done.applied).toEqual([{ kind: "StorageBucket", name: "assets", created: false, updated: true }]);
  });

  test("with prune, a chant-owned bucket the manifest dropped is a delete and a foreign one is left out", async () => {
    const gcp = fakeGcp();
    const capability = createGcpApplyCapability(gcp.http);
    write([bucket("keep"), bucket("old")]);
    await capability.run(ctx, { manifest });
    gcp.store.set("/storage/v1/b/foreign", { name: "foreign", labels: {} });

    write([bucket("keep")]);
    const plan = await capability.plan!(ctx, { manifest, prune: true });
    expect(plan.changeSet!.entries.map((e) => [e.address, e.action, e.disruption])).toEqual([
      ["StorageBucket/keep", "no-op", undefined],
      ["StorageBucket/old", "delete", "destroy"],
    ]);
  });

  test("a kind with no mapper, and a read that is neither 200 nor 404, are holes", async () => {
    const http: GcpHttp = async () => ({ status: 403, text: "denied" });
    const capability = createGcpApplyCapability(http);
    write([bucket("assets"), { kind: "SQLInstance", metadata: { name: "db" }, spec: {} }]);
    const plan = await capability.plan!(ctx, { manifest });
    expect(plan.changeSet!.entries).toEqual([]);
    expect(plan.changeSet!.member.holes.map((h) => h.address)).toEqual(["StorageBucket/assets", "SQLInstance/db"]);
    expect(plan.changeSet!.member.holes[0]!.reason).toMatch(/answered 403/);
    expect(plan.changeSet!.member.holes[1]!.reason).toMatch(/no REST mapper for SQLInstance/);
  });

  test("inputs waiting on another component read nothing and leave a hole", async () => {
    const gcp = fakeGcp();
    const capability = createGcpApplyCapability(gcp.http);
    const plan = await capability.plan!({ ...ctx, unresolvedInputs: ["network"] }, { manifest: join(dir, "not-built.json") });
    expect(gcp.calls).toEqual([]);
    expect(plan.artifact).toBeUndefined();
    expect(plan.changeSet!.member.holes).toEqual([{ address: "gcp-app", type: "gcp-apply", reason: "inputs from network; re-checked on apply" }]);
  });

  test("the project follows projectRef.external, then the annotation, then GCP_PROJECT_ID, then GOOGLE_CLOUD_PROJECT", async () => {
    const gcp = fakeGcp();
    const capability = createGcpApplyCapability(gcp.http);
    const named = (name: string, extra: Record<string, unknown>) => ({ kind: "PubSubTopic", metadata: { name, ...extra }, spec: {} });
    write([
      { kind: "PubSubTopic", metadata: { name: "a", annotations: { "cnrm.cloud.google.com/project-id": "annotated" } }, spec: { projectRef: { external: "projects/from-ref" } } },
      named("b", { annotations: { "cnrm.cloud.google.com/project-id": "annotated" } }),
      named("c", {}),
    ]);
    await capability.plan!(ctx, { manifest });
    delete process.env.GCP_PROJECT_ID;
    process.env.GOOGLE_CLOUD_PROJECT = "cloud-project";
    write([named("d", {})]);
    await capability.plan!(ctx, { manifest });
    expect(gcp.calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/v1/projects/from-ref/topics/a",
      "/v1/projects/annotated/topics/b",
      "/v1/projects/test-project/topics/c",
      "/v1/projects/cloud-project/topics/d",
    ]);
  });

  test("the step's endpoint wins over GCP_ENDPOINT_URL and enters the plan digest", async () => {
    const gcp = fakeGcp();
    const capability = createGcpApplyCapability(gcp.http);
    write([topic]);
    const viaEnv = await capability.plan!(ctx, { manifest });
    const viaStep = await capability.plan!(ctx, { manifest, endpoint: "http://localhost:4599" });
    expect(gcp.calls.map((c) => new URL(c.url).origin)).toEqual(["http://floci.test:4588", "http://localhost:4599"]);
    expect(viaStep.planDigest).not.toBe(viaEnv.planDigest);
  });

  test("the plan's HTTP refuses a write, and lets a policy read through", async () => {
    const seen: string[] = [];
    const read = readOnlyHttp(async (method, url) => {
      seen.push(`${method} ${url}`);
      return { status: 200, text: "{}" };
    });
    await expect(read("PATCH", "http://x/b/assets", {})).rejects.toThrow(/a plan only reads/);
    await expect(read("POST", "http://x/v1/projects/p/serviceAccounts", {})).rejects.toThrow(/a plan only reads/);
    await read("POST", "http://x/v1/projects/p/topics/t:getIamPolicy", {});
    await read("GET", "http://x/b/assets");
    expect(seen).toEqual(["POST http://x/v1/projects/p/topics/t:getIamPolicy", "GET http://x/b/assets"]);
  });
});

describe("gcpCapabilityPlugin (#4273)", () => {
  test("satisfies the CapabilityPlugin contract and contributes gcp-apply with plan and outputs", () => {
    expect(isCapabilityPlugin(gcpCapabilityPlugin)).toBe(true);
    const [step] = gcpCapabilityPlugin.capabilities();
    expect(step!.kind).toBe("gcp-apply");
    expect(typeof step!.plan).toBe("function");
    expect(typeof step!.outputs).toBe("function");
  });

  test("a project listing the gcp lexicon gets gcp-apply in its registry", async () => {
    const registry = await buildCapabilityRegistry({ lexicons: ["gcp"] });
    expect(registry.has("gcp-apply")).toBe(true);
  });
});
