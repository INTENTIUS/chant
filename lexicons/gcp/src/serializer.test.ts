import { describe, test, expect } from "bun:test";
import { gcpSerializer } from "./serializer";
import { DECLARABLE_MARKER } from "@intentius/chant/declarable";
import {
  defaultLabels,
  defaultAnnotations,
  DEFAULT_LABELS_MARKER,
  DEFAULT_ANNOTATIONS_MARKER,
} from "./default-labels";

// ── Mock helpers ────────────────────────────────────────────────────

function mockResource(
  entityType: string,
  props: Record<string, unknown>,
): any {
  return {
    [DECLARABLE_MARKER]: true,
    lexicon: "gcp",
    entityType,
    kind: "resource",
    props,
  };
}

function mockProperty(
  entityType: string,
  props: Record<string, unknown>,
): any {
  return {
    [DECLARABLE_MARKER]: true,
    lexicon: "gcp",
    entityType,
    kind: "property",
    props,
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("gcpSerializer", () => {
  test("name is gcp", () => {
    expect(gcpSerializer.name).toBe("gcp");
  });

  test("rulePrefix is WGC", () => {
    expect(gcpSerializer.rulePrefix).toBe("WGC");
  });

  test("empty entities produce empty string", () => {
    const result = gcpSerializer.serialize(new Map());
    expect(result).toBe("");
  });

  test("single resource produces valid YAML with apiVersion/kind/metadata/spec", () => {
    const entities = new Map<string, any>();
    entities.set(
      "myBucket",
      mockResource("GCP::Storage::Bucket", {
        location: "US",
        storageClass: "STANDARD",
      }),
    );

    const result = gcpSerializer.serialize(entities);
    expect(result).toContain("apiVersion:");
    expect(result).toContain("kind:");
    expect(result).toContain("metadata:");
    expect(result).toContain("spec:");
    expect(result).toContain("location: US");
    expect(result).toContain("storageClass: STANDARD");
  });

  test("metadata.name auto-generated from logical name (camelCase→kebab-case)", () => {
    const entities = new Map<string, any>();
    entities.set(
      "myDataBucket",
      mockResource("GCP::Storage::Bucket", {
        location: "US",
      }),
    );

    const result = gcpSerializer.serialize(entities);
    expect(result).toContain("name: my-data-bucket");
  });

  test("explicit metadata.name preserved", () => {
    const entities = new Map<string, any>();
    entities.set(
      "myBucket",
      mockResource("GCP::Storage::Bucket", {
        metadata: { name: "custom-bucket-name" },
        location: "US",
      }),
    );

    const result = gcpSerializer.serialize(entities);
    expect(result).toContain("name: custom-bucket-name");
  });

  test("all GCP resources use spec (no specless types)", () => {
    const entities = new Map<string, any>();
    entities.set(
      "instance",
      mockResource("GCP::Compute::Instance", {
        machineType: "e2-medium",
        zone: "us-central1-a",
      }),
    );

    const result = gcpSerializer.serialize(entities);
    expect(result).toContain("spec:");
    expect(result).toContain("machineType: e2-medium");
  });

  test("multi-resource entities joined by ---", () => {
    const entities = new Map<string, any>();
    entities.set(
      "bucket",
      mockResource("GCP::Storage::Bucket", {
        location: "US",
      }),
    );
    entities.set(
      "instance",
      mockResource("GCP::Compute::Instance", {
        machineType: "e2-medium",
      }),
    );

    const result = gcpSerializer.serialize(entities);
    expect(result).toContain("---");
  });

  test("default labels merged into metadata.labels", () => {
    const entities = new Map<string, any>();
    entities.set("labels", defaultLabels({ env: "prod" }));
    entities.set(
      "bucket",
      mockResource("GCP::Storage::Bucket", {
        location: "US",
      }),
    );

    const result = gcpSerializer.serialize(entities);
    expect(result).toContain("env: prod");
  });

  test("default annotations merged into metadata.annotations", () => {
    const entities = new Map<string, any>();
    entities.set("annot", defaultAnnotations({ "cnrm.cloud.google.com/project-id": "my-project" }));
    entities.set(
      "bucket",
      mockResource("GCP::Storage::Bucket", {
        location: "US",
      }),
    );

    const result = gcpSerializer.serialize(entities);
    expect(result).toContain("cnrm.cloud.google.com/project-id: my-project");
  });

  test("explicit labels override default labels", () => {
    const entities = new Map<string, any>();
    entities.set("labels", defaultLabels({ env: "dev" }));
    entities.set(
      "bucket",
      mockResource("GCP::Storage::Bucket", {
        metadata: { labels: { env: "prod" } },
        location: "US",
      }),
    );

    const result = gcpSerializer.serialize(entities);
    expect(result).toContain("env: prod");
    // Should not contain "dev" since explicit overrides
    const envLines = result.split("\n").filter((l: string) => l.includes("env:"));
    expect(envLines.every((l: string) => !l.includes("dev"))).toBe(true);
  });

  test("property entities skipped in output", () => {
    const entities = new Map<string, any>();
    entities.set("netConfig", mockProperty("GCP::Compute::NetworkConfig", { name: "config" }));
    entities.set(
      "instance",
      mockResource("GCP::Compute::Instance", {
        machineType: "e2-medium",
      }),
    );

    const result = gcpSerializer.serialize(entities);
    // Only one document — property entities should not appear as separate docs
    expect(result.split("---").length).toBeLessThanOrEqual(2);
  });

  test("DefaultLabels entities skipped in output", () => {
    const entities = new Map<string, any>();
    entities.set("labels", defaultLabels({ env: "prod" }));

    const result = gcpSerializer.serialize(entities);
    // defaultLabels alone should not produce any output
    expect(result).toBe("");
  });

  test("DefaultAnnotations entities skipped in output", () => {
    const entities = new Map<string, any>();
    entities.set("annotations", defaultAnnotations({ note: "hi" }));

    const result = gcpSerializer.serialize(entities);
    expect(result).toBe("");
  });

  test("key ordering: apiVersion, kind, metadata, spec", () => {
    const entities = new Map<string, any>();
    entities.set(
      "bucket",
      mockResource("GCP::Storage::Bucket", {
        location: "US",
      }),
    );

    const result = gcpSerializer.serialize(entities);
    const lines = result.split("\n");
    const keyLines = lines.filter((l: string) => /^\w+:/.test(l));
    const keys = keyLines.map((l: string) => l.split(":")[0]);

    const apiIdx = keys.indexOf("apiVersion");
    const kindIdx = keys.indexOf("kind");
    const metaIdx = keys.indexOf("metadata");
    const specIdx = keys.indexOf("spec");

    expect(apiIdx).toBeLessThan(kindIdx);
    expect(kindIdx).toBeLessThan(metaIdx);
    expect(metaIdx).toBeLessThan(specIdx);
  });

  test("fallback GVK derivation (GCP::Compute::Instance → compute.cnrm.cloud.google.com/v1beta1)", () => {
    const entities = new Map<string, any>();
    entities.set(
      "myInstance",
      mockResource("GCP::Compute::Instance", {
        machineType: "e2-medium",
      }),
    );

    const result = gcpSerializer.serialize(entities);
    expect(result).toContain("compute.cnrm.cloud.google.com/v1beta1");
    expect(result).toContain("ComputeInstance");
  });
});
