import { describe, test, expect } from "vitest";
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
  storageBucketMapper,
  pubSubTopicMapper,
  cloudRunServiceMapper,
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
    expect(Object.keys(MAPPERS).sort()).toEqual(["PubSubTopic", "RunService", "StorageBucket"]);
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
    expect(res).toEqual({ kind: "RunService", name: "hello-svc", created: true });
    expect(calls).toEqual(["GET get", "POST create", "GET op"]);
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

describe("applyResource idempotency (#706)", () => {
  function recorder(getStatus: number): { http: GcpHttp; calls: Array<{ method: string; url: string }> } {
    const calls: Array<{ method: string; url: string }> = [];
    const http: GcpHttp = async (method, url) => {
      calls.push({ method, url });
      return method === "GET" ? { status: getStatus, text: "" } : { status: 200, text: "{}" };
    };
    return { http, calls };
  }

  test("existing (GET 200) → skip create", async () => {
    const { http, calls } = recorder(200);
    const res = await applyResource(storageBucketMapper, BUCKET, { base: "http://x", project: "p" }, http);
    expect(res).toEqual({ kind: "StorageBucket", name: "my-data-bucket", created: false });
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  test("absent (GET 404) → create; topic uses PUT", async () => {
    const { http, calls } = recorder(404);
    const res = await applyResource(pubSubTopicMapper, TOPIC, { base: "http://x", project: "p" }, http);
    expect(res).toEqual({ kind: "PubSubTopic", name: "events", created: true });
    expect(calls.map((c) => c.method)).toEqual(["GET", "PUT"]);
  });

  test("create failure surfaces kind + status", async () => {
    const http: GcpHttp = async (method) =>
      method === "GET" ? { status: 404, text: "" } : { status: 403, text: "denied" };
    await expect(
      applyResource(storageBucketMapper, BUCKET, { base: "http://x", project: "p" }, http),
    ).rejects.toThrow(/StorageBucket my-data-bucket create failed \(403\)/);
  });
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
