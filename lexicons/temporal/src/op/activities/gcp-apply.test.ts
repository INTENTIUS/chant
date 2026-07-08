import { describe, test, expect } from "vitest";
import {
  bucketInsertBody,
  pubSubTopicBody,
  resolveGcpProject,
  applyResource,
  parseManifest,
  storageBucketMapper,
  pubSubTopicMapper,
  MAPPERS,
  type CnrmStorageBucket,
  type GcpResource,
  type GcpHttp,
} from "./gcp-apply";

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
    expect(Object.keys(MAPPERS).sort()).toEqual(["PubSubTopic", "StorageBucket"]);
    for (const [key, mapper] of Object.entries(MAPPERS)) expect(mapper.kind).toBe(key);
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
