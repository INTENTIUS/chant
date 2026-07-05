/**
 * Tests `extract-config-bom` (#613) against a fixture synthesized template
 * (./__fixtures__/synthesized-template.json) — a stack with a nested
 * `AWS::CloudFormation::Stack`, an ECS task referencing a published image
 * digest, an EC2 launch template referencing an AMI, and a custom resource
 * carrying a lexicon version string. Purely structural/hermetic: no cloud
 * calls, the template is read from a fixture file and passed as an in-memory
 * string.
 */

import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020";
import Ajv from "ajv";
import {
  inventoryTemplate,
  inventoryToBomPackages,
  createExtractConfigBomCapability,
} from "./config-bom";
import { addArchiveTemplate } from "@intentius/chant/components/verbs/build";
import { findArchiveEntry, findConfigBomForSubject, templateEntries } from "@intentius/chant/components/verbs/build-archive";
import { DEFAULT_SBOM_FORMAT, SBOM_MEDIA_TYPES } from "@intentius/chant/components/verbs/sbom-generator";

const FIXTURES_DIR = join(import.meta.dirname, "__fixtures__");
const TEMPLATE = readFileSync(join(FIXTURES_DIR, "synthesized-template.json"), "utf-8");
const SCHEMAS_DIR = join(FIXTURES_DIR, "schemas");

function loadSchema(name: string): unknown {
  return JSON.parse(readFileSync(join(SCHEMAS_DIR, name), "utf-8"));
}

const ctx = { env: "dev", component: "search-service" };
const FIXED_NOW = () => new Date("2026-01-01T00:00:00.000Z");

describe("inventoryTemplate (#613) — structural template walk", () => {
  it("enumerates every declared resource with its CFN Type", () => {
    const inventory = inventoryTemplate(TEMPLATE);
    const names = inventory.resources.map((r) => r.name).sort();
    expect(names).toEqual([
      "SearchBucket",
      "SearchLaunchTemplate",
      "SearchServiceComponentMetadata",
      "SearchTaskDefinition",
      "network",
    ]);
    expect(inventory.resources.find((r) => r.name === "SearchBucket")!.type).toBe("AWS::S3::Bucket");
  });

  it("identifies the nested AWS::CloudFormation::Stack resource and its child template path", () => {
    const inventory = inventoryTemplate(TEMPLATE);
    expect(inventory.nestedStacks).toEqual([
      { resourceName: "network", templatePath: "network.template.json" },
    ]);
  });

  it("extracts the referenced image digest from the ECS task definition", () => {
    const inventory = inventoryTemplate(TEMPLATE);
    const imageRefs = inventory.externalReferences.filter((r) => r.kind === "image-digest");
    expect(imageRefs).toHaveLength(1);
    expect(imageRefs[0]!.value).toBe(
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(imageRefs[0]!.resourceName).toBe("SearchTaskDefinition");
  });

  it("extracts the referenced AMI id from the launch template", () => {
    const inventory = inventoryTemplate(TEMPLATE);
    const amiRefs = inventory.externalReferences.filter((r) => r.kind === "ami");
    expect(amiRefs).toEqual([
      { kind: "ami", value: "ami-0abcdef1234567890", resourceName: "SearchLaunchTemplate" },
    ]);
  });

  it("extracts a lexicon version string from a resource property named for it", () => {
    const inventory = inventoryTemplate(TEMPLATE);
    const versionRefs = inventory.externalReferences.filter((r) => r.kind === "lexicon-version");
    expect(versionRefs).toEqual([
      { kind: "lexicon-version", value: "0.13.1", resourceName: "SearchServiceComponentMetadata" },
    ]);
  });

  it("handles a template with no resources gracefully", () => {
    const inventory = inventoryTemplate(JSON.stringify({ Resources: {} }));
    expect(inventory.resources).toEqual([]);
    expect(inventory.nestedStacks).toEqual([]);
    expect(inventory.externalReferences).toEqual([]);
  });
});

describe("inventoryToBomPackages (#613)", () => {
  it("projects every resource into a config-type BomPackage and every reference into an external-reference-type one", () => {
    const inventory = inventoryTemplate(TEMPLATE);
    const packages = inventoryToBomPackages(inventory);
    const resourcePkgs = packages.filter((p) => p.type === "config");
    const refPkgs = packages.filter((p) => p.type === "external-reference");
    expect(resourcePkgs).toHaveLength(5);
    expect(refPkgs).toHaveLength(3);
  });

  it("tags the nested stack's config-package with a chant:nested-stack purl pointing at its child template", () => {
    const inventory = inventoryTemplate(TEMPLATE);
    const packages = inventoryToBomPackages(inventory);
    const networkPkg = packages.find((p) => p.name === "network")!;
    expect(networkPkg.purl).toBe("chant:nested-stack/network.template.json");
  });
});

describe("extract-config-bom capability (#613)", () => {
  it("defaults to SPDX and emits a valid SPDX-2.3 document", async () => {
    expect(DEFAULT_SBOM_FORMAT).toBe("spdx");
    const capability = createExtractConfigBomCapability();
    const output = await capability.run(ctx, { path: "search.template.json", content: TEMPLATE, now: FIXED_NOW });
    expect(output.bom.format).toBe("spdx");
    expect(output.bom.mediaType).toBe(SBOM_MEDIA_TYPES.spdx);
    expect(JSON.parse(output.bom.bytes).spdxVersion).toBe("SPDX-2.3");
  });

  it("emits a valid CycloneDX-1.5 document on request", async () => {
    const capability = createExtractConfigBomCapability();
    const output = await capability.run(ctx, {
      path: "search.template.json",
      content: TEMPLATE,
      format: "cyclonedx",
      now: FIXED_NOW,
    });
    expect(output.bom.format).toBe("cyclonedx");
    expect(JSON.parse(output.bom.bytes).bomFormat).toBe("CycloneDX");
  });

  it("validates the emitted SPDX config-BOM against the real SPDX-2.3 JSON Schema", async () => {
    const schema = loadSchema("spdx-2.3.schema.json");
    const ajv = new Ajv({ strict: false, allErrors: true });
    const validate = ajv.compile(schema as object);

    const capability = createExtractConfigBomCapability();
    const output = await capability.run(ctx, { path: "search.template.json", content: TEMPLATE, now: FIXED_NOW });
    const valid = validate(JSON.parse(output.bom.bytes));
    if (!valid) throw new Error(ajv.errorsText(validate.errors));
    expect(valid).toBe(true);
  });

  it("validates the emitted CycloneDX config-BOM against the real CycloneDX-1.5 JSON Schema", async () => {
    const cdxSchema = loadSchema("cyclonedx-1.5.schema.json");
    const jsfSchema = loadSchema("jsf-0.82.schema.json");
    const spdxLicenseSchema = loadSchema("cyclonedx-spdx-license.schema.json");
    const ajv = new Ajv({ strict: false, allErrors: true });
    // The CycloneDX-1.5 schema declares `iri-reference`/`idn-email` string
    // formats; accept them as-is (this test validates document *structure*, not
    // format semantics) so it passes regardless of the ambient ajv version.
    ajv.addFormat("iri-reference", true);
    ajv.addFormat("idn-email", true);
    ajv.addSchema(jsfSchema as object);
    ajv.addSchema(spdxLicenseSchema as object);
    const validate = ajv.compile(cdxSchema as object);

    const capability = createExtractConfigBomCapability();
    const output = await capability.run(ctx, {
      path: "search.template.json",
      content: TEMPLATE,
      format: "cyclonedx",
      now: FIXED_NOW,
    });
    const valid = validate(JSON.parse(output.bom.bytes));
    if (!valid) throw new Error(ajv.errorsText(validate.errors));
    expect(valid).toBe(true);
  });

  it("lists every declared resource and every external reference in the config-BOM's package count", async () => {
    const capability = createExtractConfigBomCapability();
    const output = await capability.run(ctx, { path: "search.template.json", content: TEMPLATE, now: FIXED_NOW });
    // 5 resources + 3 external references (image digest, AMI, lexicon version)
    expect(output.bom.packageCount).toBe(8);
    expect(output.inventory.resources).toHaveLength(5);
  });

  it("writes a sbom-kind, bomKind:config entry into the build-archive manifest, linked to the template's subject digest", async () => {
    const capability = createExtractConfigBomCapability();
    const { digest: templateDigest, manifest: templateManifest } = addArchiveTemplate({
      path: "search.template.json",
      content: TEMPLATE,
    });

    const output = await capability.run(ctx, {
      path: "search.template.json",
      content: TEMPLATE,
      digest: templateDigest,
      manifest: templateManifest,
      now: FIXED_NOW,
    });

    // addArchiveTemplate (./build.ts) is a plain helper with no DeployContext,
    // so a from-scratch manifest it seeds always starts as component:
    // "unknown" — this capability threads that manifest through unchanged
    // (accumulation, not ownership), matching generate-sbom's own
    // accumulate-onto-a-template-manifest test in ./sbom.test.ts.
    expect(output.manifest.component).toBe("unknown");
    const entry = findArchiveEntry(output.manifest, output.archivePath);
    expect(entry).toMatchObject({
      kind: "sbom",
      bomKind: "config",
      digest: output.digest,
      mediaType: SBOM_MEDIA_TYPES.spdx,
      subjectDigest: templateDigest,
    });
    expect(findConfigBomForSubject(output.manifest, templateDigest)).toBe(entry);
    expect(templateEntries(output.manifest)).toHaveLength(1);
  });

  it("defaults the archive path to <template path>.config-bom.json", async () => {
    const capability = createExtractConfigBomCapability();
    const output = await capability.run(ctx, { path: "search.template.json", content: TEMPLATE, now: FIXED_NOW });
    expect(output.archivePath).toBe("search.template.json.config-bom.json");
  });

  it("accepts an explicit into path and an archive: wiring reference on the template path", async () => {
    const capability = createExtractConfigBomCapability();
    const output = await capability.run(ctx, {
      path: "archive:search.template.json",
      content: TEMPLATE,
      into: "bom/search.config.spdx.json",
      now: FIXED_NOW,
    });
    expect(output.archivePath).toBe("bom/search.config.spdx.json");
  });

  it("a config-only component (no software artifact) still yields a config-BOM from just its template", async () => {
    // No image/jar/zip entry anywhere in this manifest — the config-BOM
    // capability doesn't need one, closing #613's "config-only components
    // don't get a BOM" gap.
    const capability = createExtractConfigBomCapability();
    const { manifest: templateManifest, digest: templateDigest } = addArchiveTemplate({
      path: "infra.template.json",
      content: TEMPLATE,
    });
    const output = await capability.run(
      { env: "dev", component: "dynamodb-infra" },
      { path: "infra.template.json", content: TEMPLATE, digest: templateDigest, manifest: templateManifest, now: FIXED_NOW },
    );
    expect(output.manifest.contents.map((e) => e.kind).sort()).toEqual(["sbom", "template"]);
    expect(output.manifest.contents.find((e) => e.kind === "sbom")!.bomKind).toBe("config");
  });

  it("declares no rollback — an already-generated, content-addressed config-BOM is not itself something to undo", () => {
    const capability = createExtractConfigBomCapability();
    expect(capability.rollback).toBeUndefined();
  });

  it("two extractions from identical template content produce the same manifest digest (content-addressed)", async () => {
    const capA = createExtractConfigBomCapability();
    const capB = createExtractConfigBomCapability();
    const outputA = await capA.run(ctx, { path: "search.template.json", content: TEMPLATE, now: FIXED_NOW });
    const outputB = await capB.run(ctx, { path: "search.template.json", content: TEMPLATE, now: FIXED_NOW });
    expect(outputA.digest).toBe(outputB.digest);
    expect(outputA.manifest.manifestDigest).toBe(outputB.manifest.manifestDigest);
  });

  describe("optional disk write (outDir)", () => {
    let tmpDir: string;
    afterEach(() => {
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    });

    it("writes config-bom.<format>.json to outDir when provided", async () => {
      tmpDir = mkdtempSync(join(tmpdir(), "chant-config-bom-"));
      const capability = createExtractConfigBomCapability();
      await capability.run(ctx, { path: "search.template.json", content: TEMPLATE, outDir: tmpDir, now: FIXED_NOW });
      const written = JSON.parse(readFileSync(join(tmpDir, "config-bom.spdx.json"), "utf-8"));
      expect(written.spdxVersion).toBe("SPDX-2.3");
    });
  });
});
