import { describe, expect, test } from "vitest";
import { stripServerFields, buildExportFromObjects } from "./live-export";
import { GcpGenerator } from "./generator";

// A live Config Connector object as `kubectl get -o json` returns it.
const liveBucket = () => ({
  apiVersion: "storage.cnrm.cloud.google.com/v1beta1",
  kind: "StorageBucket",
  metadata: {
    name: "my-bucket",
    namespace: "default",
    uid: "u-1",
    resourceVersion: "55",
    generation: 2,
    creationTimestamp: "2026-01-01T00:00:00Z",
    managedFields: [{ manager: "cnrm" }],
    annotations: {
      "cnrm.cloud.google.com/management-conflict-prevention-policy": "resource",
      "cnrm.cloud.google.com/project-id": "my-project",
      "team": "data",
    },
    labels: { env: "prod" },
  },
  spec: { location: "US", storageClass: "STANDARD" },
  status: { conditions: [{ type: "Ready", status: "True" }] },
});

const livePubsub = () => ({
  apiVersion: "pubsub.cnrm.cloud.google.com/v1beta1",
  kind: "PubSubTopic",
  metadata: { name: "events", namespace: "default", uid: "u-2" },
  spec: { messageRetentionDuration: "86400s" },
  status: { conditions: [] },
});

describe("GCP stripServerFields (#117)", () => {
  test("removes status, managedFields, and server metadata", () => {
    const cleaned = stripServerFields(liveBucket());
    expect(cleaned.status).toBeUndefined();
    const md = cleaned.metadata as Record<string, unknown>;
    expect(md.managedFields).toBeUndefined();
    expect(md.uid).toBeUndefined();
    expect(md.generation).toBeUndefined();
  });

  test("drops cnrm bookkeeping annotations but keeps authored ones", () => {
    const cleaned = stripServerFields(liveBucket());
    const annotations = (cleaned.metadata as Record<string, unknown>).annotations as Record<string, string>;
    expect(annotations["cnrm.cloud.google.com/management-conflict-prevention-policy"]).toBeUndefined();
    expect(annotations["cnrm.cloud.google.com/project-id"]).toBeUndefined();
    expect(annotations.team).toBe("data");
  });

  test("keeps authored spec and labels; does not mutate input", () => {
    const input = liveBucket();
    const cleaned = stripServerFields(input);
    expect(cleaned.spec).toEqual({ location: "US", storageClass: "STANDARD" });
    expect(input.status).toBeDefined();
  });
});

describe("GCP buildExportFromObjects (#117)", () => {
  test("maps live CC objects to export IR, stripped by default", () => {
    const ir = buildExportFromObjects([liveBucket(), livePubsub()]);
    expect(ir.resources).toHaveLength(2);
    const bucket = ir.resources.find((r) => r.logicalId === "my-bucket")!;
    expect(bucket.type).toBe("GCP::Storage::Bucket");
    expect((bucket.properties.metadata as Record<string, unknown>).uid).toBeUndefined();
    expect(bucket.properties.location).toBe("US");
  });

  test("verbatim keeps server fields", () => {
    const ir = buildExportFromObjects([liveBucket()], { verbatim: true });
    const bucket = ir.resources[0];
    expect((bucket.properties.metadata as Record<string, unknown>).uid).toBe("u-1");
  });

  test("selector by type narrows the export", () => {
    const ir = buildExportFromObjects([liveBucket(), livePubsub()], {
      selector: { type: "GCP::Pubsub::Topic" },
    });
    expect(ir.resources.map((r) => r.logicalId)).toEqual(["events"]);
  });

  test("selector by name narrows the export", () => {
    const ir = buildExportFromObjects([liveBucket(), livePubsub()], {
      selector: { name: "my-bucket" },
    });
    expect(ir.resources.map((r) => r.logicalId)).toEqual(["my-bucket"]);
  });

  test("owned filter keeps only objects carrying the chant marker label (#120)", () => {
    const mine = liveBucket();
    (mine.metadata as any).labels = { "app.kubernetes.io/managed-by": "chant", "chant.intentius.io/stack": "billing" };
    const theirs = livePubsub(); // no chant label
    const ir = buildExportFromObjects([mine, theirs], { owned: true });
    expect(ir.resources.map((r) => r.logicalId)).toEqual(["my-bucket"]);
  });

  test("export IR feeds GcpGenerator (templateGenerator) unchanged", () => {
    const ir = buildExportFromObjects([liveBucket()]);
    const files = new GcpGenerator().generate(ir);
    expect(files.length).toBeGreaterThan(0);
  });
});
