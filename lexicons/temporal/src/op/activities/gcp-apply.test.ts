import { describe, test, expect } from "vitest";
import {
  bucketInsertBody,
  resolveGcpEndpoint,
  resolveGcpProject,
  applyBucket,
  parseManifest,
  type CnrmStorageBucket,
  type GcpHttp,
} from "./gcp-apply";

const FULL: CnrmStorageBucket = {
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

describe("bucketInsertBody (#711)", () => {
  test("maps every field, renaming to the GCS insert shape", () => {
    expect(bucketInsertBody(FULL)).toEqual({
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

describe("resolveGcpEndpoint (#711)", () => {
  test("uses STORAGE_EMULATOR_HOST when set (floci-gcp)", () => {
    expect(resolveGcpEndpoint({ STORAGE_EMULATOR_HOST: "http://localhost:4588" } as NodeJS.ProcessEnv))
      .toBe("http://localhost:4588");
  });

  test("defaults to real GCS", () => {
    expect(resolveGcpEndpoint({} as NodeJS.ProcessEnv)).toBe("https://storage.googleapis.com");
  });
});

describe("resolveGcpProject (#711)", () => {
  test("env wins over the annotation", () => {
    expect(resolveGcpProject(FULL, { GOOGLE_CLOUD_PROJECT: "env-project" } as NodeJS.ProcessEnv))
      .toBe("env-project");
  });

  test("falls back to the CNRM annotation", () => {
    expect(resolveGcpProject(FULL, {} as NodeJS.ProcessEnv)).toBe("annotated-project");
  });

  test("throws when neither is present", () => {
    expect(() => resolveGcpProject({ metadata: { name: "b" } }, {} as NodeJS.ProcessEnv))
      .toThrow(/no GCP project/);
  });
});

describe("applyBucket idempotency (#711)", () => {
  function recorder(getStatus: number): { http: GcpHttp; calls: Array<{ method: string; url: string }> } {
    const calls: Array<{ method: string; url: string }> = [];
    const http: GcpHttp = async (method, url) => {
      calls.push({ method, url });
      if (method === "GET") return { status: getStatus, text: "" };
      return { status: 200, text: "{}" };
    };
    return { http, calls };
  }

  test("existing bucket (GET 200) → skip create", async () => {
    const { http, calls } = recorder(200);
    const res = await applyBucket(FULL, { endpoint: "http://localhost:4588", project: "p" }, http);
    expect(res).toEqual({ bucket: "my-data-bucket", created: false });
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  test("absent bucket (GET 404) → POST create at the project-scoped insert URL", async () => {
    const { http, calls } = recorder(404);
    const res = await applyBucket(FULL, { endpoint: "http://localhost:4588/", project: "floci-local" }, http);
    expect(res).toEqual({ bucket: "my-data-bucket", created: true });
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
    expect(calls[1].url).toBe("http://localhost:4588/storage/v1/b?project=floci-local");
  });

  test("create failure surfaces the status", async () => {
    const http: GcpHttp = async (method) =>
      method === "GET" ? { status: 404, text: "" } : { status: 403, text: "denied" };
    await expect(
      applyBucket(FULL, { endpoint: "http://x", project: "p" }, http),
    ).rejects.toThrow(/create failed \(403\)/);
  });
});

describe("parseManifest (#711)", () => {
  test("JSON array", () => {
    expect(parseManifest('[{"kind":"StorageBucket"}]', "x.json")).toHaveLength(1);
  });

  test("single JSON object is wrapped", () => {
    expect(parseManifest('{"kind":"StorageBucket"}', "x.json")).toHaveLength(1);
  });

  test("YAML multi-doc splits on ---", () => {
    const yaml = "kind: StorageBucket\nmetadata:\n  name: a\n---\nkind: StorageBucket\nmetadata:\n  name: b\n";
    const docs = parseManifest(yaml, "x.yaml");
    expect(docs).toHaveLength(2);
    expect(docs.map((d) => d.metadata?.name)).toEqual(["a", "b"]);
  });
});
