/**
 * Tests `aggregateComponentBom` (#614) — the component-level BOM aggregation
 * that composes a component's leaf BOMs (a software SBOM + an IaC
 * config-BOM) into one component BOM. Structural validation against the
 * real, vendored SPDX-2.3/CycloneDX-1.5 JSON Schemas, same convention as
 * ./bom-writer.test.ts.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Ajv from "ajv";
import { aggregateComponentBom, componentBomLeavesFromManifest, type ComponentBomLeaf } from "./component-bom";
import { addArchiveEntry, createBuildArchiveManifest, findArchiveEntry } from "./build-archive";
import type { BomPackage } from "./bom-writer";

const SCHEMAS_DIR = join(import.meta.dirname, "__fixtures__/schemas");
function loadSchema(name: string): unknown {
  return JSON.parse(readFileSync(join(SCHEMAS_DIR, name), "utf-8"));
}

const FIXED_NOW = () => new Date("2026-01-01T00:00:00.000Z");

/** Build a manifest for "search-service": an image + a software SBOM leaf, a template + a config-BOM leaf. */
function multiArtifactManifest() {
  let manifest = createBuildArchiveManifest("search-service", { now: FIXED_NOW });
  manifest = addArchiveEntry(manifest, { kind: "image", path: "image.tar", digest: "sha256:img1" });
  manifest = addArchiveEntry(manifest, { kind: "template", path: "search.template.json", digest: "sha256:tmpl1" });
  manifest = addArchiveEntry(manifest, {
    kind: "sbom",
    bomKind: "software",
    path: "image.tar.sbom.json",
    digest: "sha256:sbomsoft",
    subjectDigest: "sha256:img1",
    mediaType: "application/spdx+json",
    packageCount: 1,
    generator: "chant-lockfile-sbom/package-lock.json",
  });
  manifest = addArchiveEntry(manifest, {
    kind: "sbom",
    bomKind: "config",
    path: "search.template.json.config-bom.json",
    digest: "sha256:sbomconfig",
    subjectDigest: "sha256:tmpl1",
    mediaType: "application/spdx+json",
    packageCount: 1,
    generator: "chant-config-bom-extractor",
  });
  return manifest;
}

function multiArtifactLeaves(manifest: ReturnType<typeof multiArtifactManifest>): ComponentBomLeaf[] {
  return [
    {
      entry: findArchiveEntry(manifest, "image.tar.sbom.json")!,
      packages: [{ name: "left-pad", version: "1.3.0", type: "npm" } satisfies BomPackage],
    },
    {
      entry: findArchiveEntry(manifest, "search.template.json.config-bom.json")!,
      packages: [{ name: "SearchBucket", version: "AWS::S3::Bucket", type: "config" } satisfies BomPackage],
    },
  ];
}

describe("aggregateComponentBom (#614)", () => {
  describe("multi-artifact component — a real assembly", () => {
    it("SPDX: composes both leaves into one valid document", () => {
      const manifest = multiArtifactManifest();
      const leaves = multiArtifactLeaves(manifest);
      const result = aggregateComponentBom({ component: "search-service", manifest, leaves, format: "spdx", now: FIXED_NOW });

      expect(result.leafCount).toBe(2);
      expect(result.totalPackageCount).toBe(2);
      expect(result.bom.format).toBe("spdx");

      const doc = JSON.parse(result.bom.bytes) as Record<string, unknown>;
      const schema = loadSchema("spdx-2.3.schema.json");
      const ajv = new Ajv({ strict: false, allErrors: true });
      const validate = ajv.compile(schema as object);
      const valid = validate(doc);
      if (!valid) throw new Error(ajv.errorsText(validate.errors));
      expect(valid).toBe(true);
      expect(doc.name).toBe("search-service");
    });

    it("CycloneDX: composes both leaves into one valid document with nested components + compositions", () => {
      const manifest = multiArtifactManifest();
      const leaves = multiArtifactLeaves(manifest);
      const result = aggregateComponentBom({ component: "search-service", manifest, leaves, format: "cyclonedx", now: FIXED_NOW });

      const doc = JSON.parse(result.bom.bytes) as {
        metadata: { component: { name: string; components: unknown[] } };
        compositions: Array<{ aggregate: string }>;
      };
      const cdxSchema = loadSchema("cyclonedx-1.5.schema.json");
      const jsfSchema = loadSchema("jsf-0.82.schema.json");
      const spdxLicenseSchema = loadSchema("cyclonedx-spdx-license.schema.json");
      const ajv = new Ajv({ strict: false, allErrors: true });
      ajv.addSchema(jsfSchema as object);
      ajv.addSchema(spdxLicenseSchema as object);
      const validate = ajv.compile(cdxSchema as object);
      const valid = validate(doc);
      if (!valid) throw new Error(ajv.errorsText(validate.errors));
      expect(valid).toBe(true);

      expect(doc.metadata.component.name).toBe("search-service");
      expect(doc.metadata.component.components).toHaveLength(2);
      expect(doc.compositions[0]!.aggregate).toBe("incomplete");
    });

    it("preserves which packages came from which leaf — never flattens software and config packages into one anonymous list", () => {
      const manifest = multiArtifactManifest();
      const leaves = multiArtifactLeaves(manifest);
      const result = aggregateComponentBom({ component: "search-service", manifest, leaves, format: "cyclonedx", now: FIXED_NOW });
      const doc = JSON.parse(result.bom.bytes);

      const softwareLeaf = doc.metadata.component.components.find((c: { name: string }) => c.name.startsWith("software:"));
      const configLeaf = doc.metadata.component.components.find((c: { name: string }) => c.name.startsWith("config:"));
      expect(softwareLeaf.components.map((c: { name: string }) => c.name)).toEqual(["left-pad"]);
      expect(configLeaf.components.map((c: { name: string }) => c.name)).toEqual(["SearchBucket"]);
    });

    it("each sub-document's subjectId traces back to the artifact digest it describes (subjectDigest), not the BOM document's own digest", () => {
      const manifest = multiArtifactManifest();
      const leaves = multiArtifactLeaves(manifest);
      const result = aggregateComponentBom({ component: "search-service", manifest, leaves, format: "cyclonedx", now: FIXED_NOW });
      const doc = JSON.parse(result.bom.bytes);

      const softwareLeaf = doc.metadata.component.components.find((c: { name: string }) => c.name.startsWith("software:"));
      const configLeaf = doc.metadata.component.components.find((c: { name: string }) => c.name.startsWith("config:"));
      const subjectIdOf = (c: { properties: Array<{ name: string; value: string }> }) =>
        c.properties.find((p) => p.name === "chant:subjectId")!.value;
      expect(subjectIdOf(softwareLeaf)).toBe("sha256:img1");
      expect(subjectIdOf(configLeaf)).toBe("sha256:tmpl1");
    });

    it("is deterministic — identical leaves + manifest produce byte-identical output", () => {
      const manifest = multiArtifactManifest();
      const leaves = multiArtifactLeaves(manifest);
      const a = aggregateComponentBom({ component: "search-service", manifest, leaves, format: "spdx", now: FIXED_NOW });
      const b = aggregateComponentBom({ component: "search-service", manifest, leaves, format: "spdx", now: FIXED_NOW });
      expect(a.bom.bytes).toBe(b.bom.bytes);
    });
  });

  describe("single-artifact component — 1:1, still a valid standalone document", () => {
    it("one leaf produces a valid document with no sub-document nesting", () => {
      let manifest = createBuildArchiveManifest("infra-only", { now: FIXED_NOW });
      manifest = addArchiveEntry(manifest, { kind: "template", path: "infra.template.json", digest: "sha256:tmpl1" });
      manifest = addArchiveEntry(manifest, {
        kind: "sbom",
        bomKind: "config",
        path: "infra.template.json.config-bom.json",
        digest: "sha256:sbomconfig",
        subjectDigest: "sha256:tmpl1",
        mediaType: "application/spdx+json",
        packageCount: 1,
      });
      const leaves: ComponentBomLeaf[] = [
        {
          entry: findArchiveEntry(manifest, "infra.template.json.config-bom.json")!,
          packages: [{ name: "SearchTable", version: "AWS::DynamoDB::Table", type: "config" }],
        },
      ];

      const result = aggregateComponentBom({ component: "infra-only", manifest, leaves, format: "spdx", now: FIXED_NOW });
      expect(result.leafCount).toBe(1);
      expect(result.totalPackageCount).toBe(1);

      const doc = JSON.parse(result.bom.bytes);
      const schema = loadSchema("spdx-2.3.schema.json");
      const ajv = new Ajv({ strict: false, allErrors: true });
      const validate = ajv.compile(schema as object);
      expect(validate(doc)).toBe(true);
      // no CONTAINS relationship — nothing nested, the leaf's packages are
      // the aggregate's own flat package list directly.
      expect(doc.relationships.some((r: { relationshipType: string }) => r.relationshipType === "CONTAINS")).toBe(false);
    });
  });

  describe("error handling", () => {
    it("throws when given zero leaves — aggregation over nothing is a caller bug, not a silent no-op", () => {
      const manifest = createBuildArchiveManifest("empty");
      expect(() => aggregateComponentBom({ component: "empty", manifest, leaves: [] })).toThrow(/no leaf BOMs/);
    });
  });

  describe("defaults", () => {
    it("defaults to DEFAULT_SBOM_FORMAT (spdx) when format is omitted", () => {
      const manifest = multiArtifactManifest();
      const leaves = multiArtifactLeaves(manifest);
      const result = aggregateComponentBom({ component: "search-service", manifest, leaves, now: FIXED_NOW });
      expect(result.bom.format).toBe("spdx");
    });
  });
});

describe("componentBomLeavesFromManifest (#614)", () => {
  it("builds ComponentBomLeaf[] for every sbom-kind entry that has a known package list", () => {
    const manifest = multiArtifactManifest();
    const packagesByPath = new Map<string, BomPackage[]>([
      ["image.tar.sbom.json", [{ name: "left-pad", version: "1.3.0", type: "npm" }]],
      ["search.template.json.config-bom.json", [{ name: "SearchBucket", version: "AWS::S3::Bucket", type: "config" }]],
    ]);
    const leaves = componentBomLeavesFromManifest(manifest, packagesByPath);
    expect(leaves).toHaveLength(2);
    expect(leaves.map((l) => l.entry.path).sort()).toEqual(["image.tar.sbom.json", "search.template.json.config-bom.json"]);
  });

  it("skips sbom entries with no known package list rather than failing", () => {
    const manifest = multiArtifactManifest();
    const packagesByPath = new Map<string, BomPackage[]>([
      ["image.tar.sbom.json", [{ name: "left-pad", version: "1.3.0", type: "npm" }]],
    ]);
    const leaves = componentBomLeavesFromManifest(manifest, packagesByPath);
    expect(leaves).toHaveLength(1);
    expect(leaves[0]!.entry.path).toBe("image.tar.sbom.json");
  });
});
