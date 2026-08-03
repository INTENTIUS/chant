import { describe, test, expect } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import {
  bucketInsertBody,
  pubSubTopicBody,
  cloudRunServiceBody,
  resolveGcpProject,
  applyResource,
  deleteResource,
  waitForOperation,
  longRunningOperation,
  parseManifest,
  referencedNames,
  orderByReferences,
  pruneOrphans,
  gcpApply,
  gcpDelete,
  chantOwnershipLabels,
  isChantOwned,
  pubSubSubscriptionBody,
  storageBucketMapper,
  pubSubTopicMapper,
  pubSubSubscriptionMapper,
  cloudRunServiceMapper,
  secretManagerSecretMapper,
  gcpServiceAccountMapper,
  MAPPERS,
  type CnrmStorageBucket,
  type GcpResource,
  type GcpHttp,
} from "./gcp-apply";

const RUN_SERVICE: GcpResource = {
  apiVersion: "run.cnrm.cloud.google.com/v1beta1",
  kind: "RunService",
  metadata: { name: "hello-svc" },
  spec: { location: "us-central1", template: { containers: [{ image: "gcr.io/x/hello" }] } },
};

const BUCKET: CnrmStorageBucket = {
  apiVersion: "storage.cnrm.cloud.google.com/v1beta1",
  kind: "StorageBucket",
  metadata: {
    name: "my-data-bucket",
    annotations: { "cnrm.cloud.google.com/project-id": "annotated-project" },
  },
  spec: {
    location: "US",
    storageClass: "STANDARD",
    uniformBucketLevelAccess: true,
    versioning: { enabled: true },
    lifecycleRule: [{ action: { type: "Delete" }, condition: { age: 365 } }],
  },
};

const TOPIC: GcpResource = {
  apiVersion: "pubsub.cnrm.cloud.google.com/v1beta1",
  kind: "PubSubTopic",
  metadata: { name: "events", labels: { team: "data" } },
  spec: { messageRetentionDuration: "86400s" },
};

describe("bucketInsertBody (#711)", () => {
  test("maps every field, renaming to the GCS insert shape", () => {
    expect(bucketInsertBody(BUCKET)).toEqual({
      name: "my-data-bucket",
      location: "US",
      storageClass: "STANDARD",
      iamConfiguration: { uniformBucketLevelAccess: { enabled: true } },
      versioning: { enabled: true },
      lifecycle: { rule: [{ action: { type: "Delete" }, condition: { age: 365 } }] },
    });
  });

  test("minimal — name plus location only", () => {
    expect(bucketInsertBody({ metadata: { name: "b" }, spec: { location: "EU" } })).toEqual({
      name: "b",
      location: "EU",
    });
  });

  test("throws without metadata.name", () => {
    expect(() => bucketInsertBody({ spec: { location: "US" } })).toThrow(/metadata.name/);
  });
});

describe("pubSubTopicBody (#706)", () => {
  test("maps labels and messageRetentionDuration; name travels in the URL", () => {
    expect(pubSubTopicBody(TOPIC)).toEqual({
      labels: { team: "data" },
      messageRetentionDuration: "86400s",
    });
  });

  test("empty for a bare topic", () => {
    expect(pubSubTopicBody({ metadata: { name: "t" } })).toEqual({});
  });
});

describe("mappers build correct plans (#706)", () => {
  test("StorageBucket → POST /storage/v1/b?project=", () => {
    const plan = storageBucketMapper.plan(BUCKET, { base: "http://localhost:4588", project: "p" });
    expect(plan.getUrl).toBe("http://localhost:4588/storage/v1/b/my-data-bucket");
    expect(plan.create.method).toBe("POST");
    expect(plan.create.url).toBe("http://localhost:4588/storage/v1/b?project=p");
  });

  test("PubSubTopic → PUT /v1/projects/{p}/topics/{t}, same URL for GET", () => {
    const plan = pubSubTopicMapper.plan(TOPIC, { base: "http://localhost:4588", project: "p" });
    const url = "http://localhost:4588/v1/projects/p/topics/events";
    expect(plan.getUrl).toBe(url);
    expect(plan.create.method).toBe("PUT");
    expect(plan.create.url).toBe(url);
  });

  test("registry keys match each mapper's kind", () => {
    expect(Object.keys(MAPPERS).sort()).toEqual([
      "IAMServiceAccount",
      "PubSubSubscription",
      "PubSubTopic",
      "RunService",
      "SecretManagerSecret",
      "StorageBucket",
    ]);
    for (const [key, mapper] of Object.entries(MAPPERS)) expect(mapper.kind).toBe(key);
  });
});

describe("Cloud Run mapper + LRO (#706)", () => {
  test("cloudRunServiceBody passes the template through", () => {
    expect(cloudRunServiceBody(RUN_SERVICE)).toEqual({
      template: { containers: [{ image: "gcr.io/x/hello" }] },
    });
  });

  test("RunService plan → POST v2 services?serviceId, async operation present", () => {
    const plan = cloudRunServiceMapper.plan(RUN_SERVICE, { base: "http://x", project: "p" });
    expect(plan.getUrl).toBe("http://x/v2/projects/p/locations/us-central1/services/hello-svc");
    expect(plan.create.method).toBe("POST");
    expect(plan.create.url).toBe("http://x/v2/projects/p/locations/us-central1/services?serviceId=hello-svc");
    expect(cloudRunServiceMapper.operation).toBeDefined();
  });

  test("longRunningOperation: poll url from an operation name, undefined for a sync resource", () => {
    const op = longRunningOperation("v2");
    expect(op.pollUrl({ name: "projects/p/locations/l/operations/abc" }, { base: "http://x", project: "p" }))
      .toBe("http://x/v2/projects/p/locations/l/operations/abc");
    // A synchronous create returns the resource (no /operations/ segment) → no poll.
    expect(op.pollUrl({ name: "projects/p/locations/l/services/hello" }, { base: "http://x", project: "p" }))
      .toBeUndefined();
  });

  test("longRunningOperation: isDone + error extraction", () => {
    const op = longRunningOperation("v2");
    expect(op.isDone({ done: true })).toBe(true);
    expect(op.isDone({ done: null })).toBe(false);
    expect(op.error({ done: true, error: { message: "boom" } })).toBe("boom");
    expect(op.error({ done: true })).toBeUndefined();
  });

  test("waitForOperation polls until done", async () => {
    let polls = 0;
    const http: GcpHttp = async () => {
      polls++;
      return { status: 200, text: JSON.stringify({ done: polls >= 2 }) };
    };
    await waitForOperation(longRunningOperation("v2"), "http://x/v2/op", http, undefined, { intervalMs: 1 });
    expect(polls).toBe(2);
  });

  test("waitForOperation throws on operation error", async () => {
    const http: GcpHttp = async () => ({ status: 200, text: JSON.stringify({ done: true, error: { message: "denied" } }) });
    await expect(
      waitForOperation(longRunningOperation("v2"), "http://x/v2/op", http, undefined, { intervalMs: 1 }),
    ).rejects.toThrow(/operation failed: denied/);
  });

  test("deleteResource: async delete polls the operation to done", async () => {
    const calls: string[] = [];
    const http: GcpHttp = async (method, url) => {
      calls.push(`${method} ${url.includes("/operations/") ? "op" : "svc"}`);
      if (method === "GET" && url.includes("/operations/")) return { status: 200, text: JSON.stringify({ done: true }) };
      // DELETE → returns an operation
      return { status: 200, text: JSON.stringify({ name: "projects/p/locations/us-central1/operations/del" }) };
    };
    const res = await deleteResource(cloudRunServiceMapper, RUN_SERVICE, { base: "http://x", project: "p" }, http);
    expect(res).toEqual({ kind: "RunService", name: "hello-svc", deleted: true });
    expect(calls).toEqual(["DELETE svc", "GET op"]);
  });

  test("applyResource: async create → polls the operation to done", async () => {
    const calls: string[] = [];
    const http: GcpHttp = async (method, url) => {
      calls.push(`${method} ${url.includes("/operations/") ? "op" : url.includes("?serviceId") ? "create" : "get"}`);
      if (method === "GET" && url.includes("/operations/")) return { status: 200, text: JSON.stringify({ done: true }) };
      if (method === "GET") return { status: 404, text: "" }; // service not there yet
      // create → return an operation
      return { status: 200, text: JSON.stringify({ name: "projects/p/locations/us-central1/operations/xyz" }) };
    };
    const res = await applyResource(cloudRunServiceMapper, RUN_SERVICE, { base: "http://x", project: "p" }, http);
    expect(res).toEqual({ kind: "RunService", name: "hello-svc", created: true, updated: false });
    expect(calls).toEqual(["GET get", "POST create", "GET op"]);
  });

  test("applyResource: async update (existing) → PATCH then polls the operation", async () => {
    const calls: string[] = [];
    const http: GcpHttp = async (method, url) => {
      calls.push(`${method} ${url.includes("/operations/") ? "op" : "svc"}`);
      if (method === "GET" && url.includes("/operations/")) return { status: 200, text: JSON.stringify({ done: true }) };
      if (method === "GET") return { status: 200, text: "{}" }; // service exists → reconcile
      // PATCH → return an operation
      return { status: 200, text: JSON.stringify({ name: "projects/p/locations/us-central1/operations/upd" }) };
    };
    const res = await applyResource(cloudRunServiceMapper, RUN_SERVICE, { base: "http://x", project: "p" }, http);
    expect(res).toEqual({ kind: "RunService", name: "hello-svc", created: false, updated: true });
    expect(calls).toEqual(["GET svc", "PATCH svc", "GET op"]);
  });
});

describe("resolveGcpProject (#711)", () => {
  test("env wins over the annotation", () => {
    expect(resolveGcpProject(BUCKET, { GOOGLE_CLOUD_PROJECT: "env-project" } as NodeJS.ProcessEnv))
      .toBe("env-project");
  });

  test("falls back to the CNRM annotation", () => {
    expect(resolveGcpProject(BUCKET, {} as NodeJS.ProcessEnv)).toBe("annotated-project");
  });

  test("throws when neither is present", () => {
    expect(() => resolveGcpProject({ metadata: { name: "b" } }, {} as NodeJS.ProcessEnv))
      .toThrow(/no GCP project/);
  });
});

describe("applyResource create/update (#706)", () => {
  function recorder(getStatus: number): { http: GcpHttp; calls: Array<{ method: string; url: string }> } {
    const calls: Array<{ method: string; url: string }> = [];
    const http: GcpHttp = async (method, url) => {
      calls.push({ method, url });
      return method === "GET" ? { status: getStatus, text: "" } : { status: 200, text: "{}" };
    };
    return { http, calls };
  }

  test("absent (GET 404) → create (POST)", async () => {
    const { http, calls } = recorder(404);
    const res = await applyResource(storageBucketMapper, BUCKET, { base: "http://x", project: "p" }, http);
    expect(res).toEqual({ kind: "StorageBucket", name: "my-data-bucket", created: true, updated: false });
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
  });

  test("existing (GET 200) with update support → reconcile (PATCH)", async () => {
    const { http, calls } = recorder(200);
    const res = await applyResource(storageBucketMapper, BUCKET, { base: "http://x", project: "p" }, http);
    expect(res).toEqual({ kind: "StorageBucket", name: "my-data-bucket", created: false, updated: true });
    expect(calls.map((c) => c.method)).toEqual(["GET", "PATCH"]);
    // name is immutable — the PATCH body omits it.
    expect(JSON.parse(String((await recorderPatchBody(BUCKET)))).name).toBeUndefined();
  });

  test("existing (GET 200) without update support (subscription) → left unchanged", async () => {
    const sub: GcpResource = {
      kind: "PubSubSubscription",
      metadata: { name: "s" },
      spec: { topicRef: { name: "events" } },
    };
    const { http, calls } = recorder(200);
    const res = await applyResource(pubSubSubscriptionMapper, sub, { base: "http://x", project: "p" }, http);
    expect(res).toEqual({ kind: "PubSubSubscription", name: "s", created: false, updated: false });
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  test("PubSubTopic update uses the {topic, updateMask} envelope", async () => {
    let patchBody: unknown;
    const http: GcpHttp = async (method, _url, body) => {
      if (method === "PATCH") patchBody = body;
      return { status: 200, text: "{}" };
    };
    const res = await applyResource(pubSubTopicMapper, TOPIC, { base: "http://x", project: "p" }, http);
    expect(res).toEqual({ kind: "PubSubTopic", name: "events", created: false, updated: true });
    const b = patchBody as { topic: { name: string; labels: Record<string, string> }; updateMask: string };
    expect(b.topic.name).toBe("projects/p/topics/events");
    expect(b.topic.labels["managed-by"]).toBe("chant");
    expect(b.updateMask.split(",")).toContain("labels");
  });

  test("create failure surfaces kind + status", async () => {
    const http: GcpHttp = async (method) =>
      method === "GET" ? { status: 404, text: "" } : { status: 403, text: "denied" };
    await expect(
      applyResource(storageBucketMapper, BUCKET, { base: "http://x", project: "p" }, http),
    ).rejects.toThrow(/StorageBucket my-data-bucket create failed \(403\)/);
  });

  test("update failure surfaces kind + status", async () => {
    const http: GcpHttp = async (method) =>
      method === "GET" ? { status: 200, text: "" } : { status: 409, text: "conflict" };
    await expect(
      applyResource(storageBucketMapper, BUCKET, { base: "http://x", project: "p" }, http),
    ).rejects.toThrow(/StorageBucket my-data-bucket update failed \(409\)/);
  });

  async function recorderPatchBody(res: CnrmStorageBucket): Promise<string> {
    let patchBody = "{}";
    const http: GcpHttp = async (method, _url, body) => {
      if (method === "PATCH") patchBody = JSON.stringify(body);
      return { status: 200, text: "" };
    };
    await applyResource(storageBucketMapper, res, { base: "http://x", project: "p" }, http);
    return patchBody;
  }
});

describe("deleteResource (#706)", () => {
  test("sync delete: DELETE the resource URL → deleted", async () => {
    const calls: Array<{ method: string; url: string }> = [];
    const http: GcpHttp = async (method, url) => {
      calls.push({ method, url });
      return { status: 200, text: "" };
    };
    const res = await deleteResource(storageBucketMapper, BUCKET, { base: "http://x", project: "p" }, http);
    expect(res).toEqual({ kind: "StorageBucket", name: "my-data-bucket", deleted: true });
    expect(calls).toEqual([{ method: "DELETE", url: "http://x/storage/v1/b/my-data-bucket" }]);
  });

  test("already-absent (DELETE 404) → deleted:false, idempotent", async () => {
    const http: GcpHttp = async () => ({ status: 404, text: "" });
    const res = await deleteResource(pubSubTopicMapper, TOPIC, { base: "http://x", project: "p" }, http);
    expect(res).toEqual({ kind: "PubSubTopic", name: "events", deleted: false });
  });

  test("delete failure surfaces kind + status", async () => {
    const http: GcpHttp = async () => ({ status: 409, text: "in use" });
    await expect(
      deleteResource(storageBucketMapper, BUCKET, { base: "http://x", project: "p" }, http),
    ).rejects.toThrow(/StorageBucket my-data-bucket delete failed \(409\)/);
  });
});

describe("Secret Manager + IAM service account mappers (#706)", () => {
  test("secret: POST ?secretId, default automatic replication, stamped, PATCH updateMask=labels", () => {
    const secret: GcpResource = { kind: "SecretManagerSecret", metadata: { name: "api-key" }, spec: {} };
    const plan = secretManagerSecretMapper.plan(secret, { base: "http://x", project: "p" });
    expect(plan.getUrl).toBe("http://x/v1/projects/p/secrets/api-key");
    expect(plan.create.url).toBe("http://x/v1/projects/p/secrets?secretId=api-key");
    expect((plan.create.body as { replication: unknown; labels: Record<string, string> }).replication).toEqual({ automatic: {} });
    expect((plan.create.body as { labels: Record<string, string> }).labels["managed-by"]).toBe("chant");
    expect(plan.update?.url).toBe("http://x/v1/projects/p/secrets/api-key?updateMask=labels");
    expect(secretManagerSecretMapper.list).toBeDefined();
  });

  test("service account: POST serviceAccounts, GET by derived email, no prune/stamp", () => {
    const sa: GcpResource = { kind: "IAMServiceAccount", metadata: { name: "deployer" }, spec: { displayName: "Deployer" } };
    const plan = gcpServiceAccountMapper.plan(sa, { base: "http://x", project: "p" });
    expect(plan.getUrl).toBe("http://x/v1/projects/p/serviceAccounts/deployer@p.iam.gserviceaccount.com");
    expect(plan.create.url).toBe("http://x/v1/projects/p/serviceAccounts");
    expect(plan.create.body).toEqual({ accountId: "deployer", serviceAccount: { displayName: "Deployer" } });
    expect(gcpServiceAccountMapper.list).toBeUndefined(); // no labels → not pruned
  });
});

describe("references + ordering (#706)", () => {
  const topic: GcpResource = { kind: "PubSubTopic", metadata: { name: "orders" } };
  const sub: GcpResource = {
    kind: "PubSubSubscription",
    metadata: { name: "orders-sub" },
    spec: { topicRef: { name: "orders" }, ackDeadlineSeconds: 20 },
  };

  test("referencedNames pulls local *Ref names, ignores external", () => {
    expect(referencedNames(sub)).toEqual(["orders"]);
    expect(referencedNames({ spec: { topicRef: { external: "projects/p/topics/x" } } })).toEqual([]);
    expect(referencedNames(topic)).toEqual([]);
  });

  test("referencedNames handles *Refs arrays and nesting", () => {
    const r: GcpResource = {
      spec: { config: { subnetworkRefs: [{ name: "a" }, { name: "b" }], networkRef: { name: "a" } } },
    };
    expect(referencedNames(r).sort()).toEqual(["a", "b"]);
  });

  test("orderByReferences puts a referenced resource before its referrer", () => {
    // Manifest lists the subscription first (wrong order); ordering fixes it.
    const ordered = orderByReferences([sub, topic]);
    expect(ordered.map((r) => r.metadata?.name)).toEqual(["orders", "orders-sub"]);
  });

  test("orderByReferences is stable for independent resources", () => {
    const a: GcpResource = { kind: "PubSubTopic", metadata: { name: "a" } };
    const b: GcpResource = { kind: "PubSubTopic", metadata: { name: "b" } };
    expect(orderByReferences([a, b]).map((r) => r.metadata?.name)).toEqual(["a", "b"]);
  });

  test("orderByReferences throws on a cycle", () => {
    const x: GcpResource = { kind: "K", metadata: { name: "x" }, spec: { yRef: { name: "y" } } };
    const y: GcpResource = { kind: "K", metadata: { name: "y" }, spec: { xRef: { name: "x" } } };
    expect(() => orderByReferences([x, y])).toThrow(/reference cycle/);
  });

  test("pubSubSubscriptionBody resolves topicRef.name to a full topic path", () => {
    expect(pubSubSubscriptionBody(sub, "floci-local")).toEqual({
      topic: "projects/floci-local/topics/orders",
      ackDeadlineSeconds: 20,
    });
  });

  test("subscription mapper plan → PUT the subscription URL", () => {
    const plan = pubSubSubscriptionMapper.plan(sub, { base: "http://x", project: "p" });
    expect(plan.getUrl).toBe("http://x/v1/projects/p/subscriptions/orders-sub");
    expect(plan.create.method).toBe("PUT");
    expect((plan.create.body as { topic: string }).topic).toBe("projects/p/topics/orders");
  });
});

describe("ownership + prune (#706)", () => {
  test("chantOwnershipLabels / isChantOwned", () => {
    expect(chantOwnershipLabels()).toEqual({ "managed-by": "chant" });
    expect(isChantOwned({ "managed-by": "chant" })).toBe(true);
    expect(isChantOwned({ "managed-by": "other" })).toBe(false);
    expect(isChantOwned(null)).toBe(false);
    expect(isChantOwned(undefined)).toBe(false);
  });

  test("create bodies are stamped with the ownership label", () => {
    const plan = storageBucketMapper.plan(BUCKET, { base: "http://x", project: "p" });
    expect((plan.create.body as { labels: Record<string, string> }).labels["managed-by"]).toBe("chant");
    const topicPlan = pubSubTopicMapper.plan(TOPIC, { base: "http://x", project: "p" });
    expect((topicPlan.create.body as { labels: Record<string, string> }).labels["managed-by"]).toBe("chant");
  });

  test("list specs read live items (bucket items, topic name from path)", () => {
    expect(storageBucketMapper.list?.url({ base: "http://x", project: "p" })).toBe("http://x/storage/v1/b?project=p");
    expect(storageBucketMapper.list?.items({ items: [{ name: "b", labels: null }] })).toEqual([{ name: "b", labels: null }]);
    expect(pubSubTopicMapper.list?.items({ topics: [{ name: "projects/p/topics/orders", labels: { "managed-by": "chant" } }] }))
      .toEqual([{ name: "orders", labels: { "managed-by": "chant" } }]);
  });

  test("pruneOrphans deletes chant-owned resources absent from the manifest, leaves foreign", async () => {
    const desired: GcpResource[] = [{ kind: "StorageBucket", metadata: { name: "keep" } }];
    const calls: Array<{ method: string; url: string }> = [];
    const http: GcpHttp = async (method, url) => {
      calls.push({ method, url });
      if (method === "GET") {
        return {
          status: 200,
          text: JSON.stringify({
            items: [
              { name: "keep", labels: { "managed-by": "chant" } },
              { name: "orphan", labels: { "managed-by": "chant" } },
              { name: "foreign", labels: null },
            ],
          }),
        };
      }
      return { status: 200, text: "" }; // DELETE
    };
    const resolve = () => ({ base: "http://x", project: "p" });
    const { pruned, notPrunable } = await pruneOrphans(desired, resolve, http);
    expect(pruned).toEqual([{ kind: "StorageBucket", name: "orphan", deleted: true }]);
    expect(notPrunable).toEqual([]);
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([
      { method: "DELETE", url: "http://x/storage/v1/b/orphan" },
    ]);
  });

  // #1447. A kind the prune could not consider was `continue`, so `pruned: []`
  // came back — which reads as "there was nothing to prune", not "I did not
  // look at this kind". Same conflation the read path fixed in #1089/#1201.
  test("a kind with no list capability is reported, not silently skipped", async () => {
    // IAMServiceAccount is mapped but has no `list` spec.
    const desired: GcpResource[] = [{ kind: "IAMServiceAccount", metadata: { name: "sa" } }];
    const calls: string[] = [];
    const http: GcpHttp = async (method) => {
      calls.push(method);
      return { status: 200, text: "{}" };
    };
    const { pruned, notPrunable } = await pruneOrphans(desired, () => ({ base: "http://x", project: "p" }), http);
    expect(pruned).toEqual([]);
    expect(notPrunable).toEqual([{ kind: "IAMServiceAccount", reason: "no-list-capability" }]);
    // Reported without touching the transport at all.
    expect(calls).toEqual([]);
  });

  // Not in #1447's list, same class: a failed LIST was also `continue`. A 403 or
  // a 500 meant the kind went unconsidered and the result said nothing.
  test("a failed list is reported, with the status, not silently skipped", async () => {
    const desired: GcpResource[] = [{ kind: "StorageBucket", metadata: { name: "keep" } }];
    const deletes: string[] = [];
    const http: GcpHttp = async (method, url) => {
      if (method === "DELETE") deletes.push(url);
      return method === "GET" ? { status: 403, text: "forbidden" } : { status: 200, text: "" };
    };
    const { pruned, notPrunable } = await pruneOrphans(desired, () => ({ base: "http://x", project: "p" }), http);
    expect(pruned).toEqual([]);
    expect(notPrunable).toEqual([{ kind: "StorageBucket", reason: "list-failed", detail: "403: forbidden" }]);
    // And nothing was deleted on the strength of a list that failed.
    expect(deletes).toEqual([]);
  });
});

describe("parseManifest (#711)", () => {
  test("JSON array", () => {
    expect(parseManifest('[{"kind":"StorageBucket"}]', "x.json")).toHaveLength(1);
  });

  test("YAML multi-doc splits on ---", () => {
    const yaml = "kind: StorageBucket\nmetadata:\n  name: a\n---\nkind: PubSubTopic\nmetadata:\n  name: b\n";
    const docs = parseManifest(yaml, "x.yaml");
    expect(docs.map((d) => d.kind)).toEqual(["StorageBucket", "PubSubTopic"]);
  });
});

/**
 * #1447 — a resource `MAPPERS` has no entry for was dropped with a
 * `console.log`, and the return value looked exactly like a complete apply.
 * `ApplyOp` reported success over a partial one.
 *
 * The GCP lexicon serializes many more kinds than the six `MAPPERS` covers, so
 * this is not a hypothetical: anything else in the manifest was silently not
 * applied.
 */
describe("gcpApply / gcpDelete report what they did not attempt (#1447)", () => {
  /** A manifest with one kind chant can apply and one it cannot. */
  const manifest = (): string => {
    const path = `/tmp/chant-1447-${process.pid}-${Math.random().toString(36).slice(2)}.json`;
    writeFileSync(
      path,
      JSON.stringify([
        { kind: "StorageBucket", metadata: { name: "mapped" }, spec: { location: "US" } },
        { kind: "SQLInstance", metadata: { name: "unmapped" }, spec: {} },
      ]),
    );
    return path;
  };

  const ok: GcpHttp = async (method) =>
    method === "GET" ? { status: 404, text: "" } : { status: 200, text: "{}" };

  test("an unmapped kind lands in notAttempted, not in applied", async () => {
    const path = manifest();
    try {
      const res = await gcpApply({ manifestPath: path, endpoint: "http://x", project: "p" }, undefined, ok);
      expect(res.applied.map((a) => a.name)).toEqual(["mapped"]);
      expect(res.notAttempted).toEqual([
        { kind: "SQLInstance", name: "unmapped", reason: "unsupported-kind" },
      ]);
    } finally {
      unlinkSync(path);
    }
  });

  // The distinction the old shape could not express: without notAttempted, this
  // result and one from a manifest that never declared SQLInstance are identical.
  test("a fully-applied manifest reports notAttempted empty", async () => {
    const path = `/tmp/chant-1447-full-${process.pid}.json`;
    writeFileSync(path, JSON.stringify([{ kind: "StorageBucket", metadata: { name: "only" }, spec: {} }]));
    try {
      const res = await gcpApply({ manifestPath: path, endpoint: "http://x", project: "p" }, undefined, ok);
      expect(res.applied).toHaveLength(1);
      expect(res.notAttempted).toEqual([]);
      expect(res.notPrunable).toEqual([]);
    } finally {
      unlinkSync(path);
    }
  });

  // The delete side matters more: a caller reading only `deleted` would believe
  // the manifest was fully torn down.
  test("gcpDelete reports the resources it never attempted to delete", async () => {
    const path = manifest();
    try {
      const res = await gcpDelete({ manifestPath: path, endpoint: "http://x", project: "p" }, undefined, ok);
      expect(res.deleted.map((d) => d.name)).toEqual(["mapped"]);
      expect(res.notAttempted).toEqual([
        { kind: "SQLInstance", name: "unmapped", reason: "unsupported-kind" },
      ]);
    } finally {
      unlinkSync(path);
    }
  });

  // A malformed manifest is a different fact from an unsupported kind — one is a
  // bug in the input, the other a known gap in coverage. Only the second belongs
  // in notAttempted.
  test("a manifest entry with no kind throws instead of being skipped", async () => {
    const path = `/tmp/chant-1447-nokind-${process.pid}.json`;
    writeFileSync(path, JSON.stringify([{ metadata: { name: "kindless" } }]));
    try {
      await expect(
        gcpApply({ manifestPath: path, endpoint: "http://x", project: "p" }, undefined, ok),
      ).rejects.toThrow(/no "kind".*kindless.*malformed manifest/s);
    } finally {
      unlinkSync(path);
    }
  });
});
