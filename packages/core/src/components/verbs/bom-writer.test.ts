/**
 * Validates the native BOM writer (#613) against the *actual* published
 * SPDX-2.3 and CycloneDX-1.5 JSON Schemas — vendored as fixtures under
 * ./__fixtures__/schemas/, the same "vendor the spec schema as a devDep test
 * fixture" convention #553 used for the Component contract schema and #607
 * used for the GitLab CI schema. No network at test time: the schemas are
 * committed, read from disk, and compiled once with `ajv`.
 *
 * Source of the vendored schemas (for provenance, not fetched at test time):
 *  - spdx-2.3.schema.json: https://github.com/spdx/spdx-spec/blob/support/2.3/schemas/spdx-schema.json
 *  - cyclonedx-1.5.schema.json: https://github.com/CycloneDX/specification/blob/1.5/schema/bom-1.5.schema.json
 *  - jsf-0.82.schema.json / cyclonedx-spdx-license.schema.json: CycloneDX's
 *    own `$ref` dependencies (renamed from the upstream `spdx.schema.json` to
 *    avoid confusion with SPDX's own document schema above, which is a
 *    different document entirely).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020";
import Ajv from "ajv";
import { writeSpdx, writeCycloneDx, writeBom, type BomInput, type BomPackage } from "./bom-writer";

const SCHEMAS_DIR = join(import.meta.dirname, "__fixtures__/schemas");

function loadSchema(name: string): unknown {
  return JSON.parse(readFileSync(join(SCHEMAS_DIR, name), "utf-8"));
}

const FIXED_NOW = () => new Date("2026-01-01T00:00:00.000Z");

const samplePackages: BomPackage[] = [
  { name: "left-pad", version: "1.3.0", type: "npm", purl: "pkg:npm/left-pad@1.3.0" },
  { name: "express", version: "4.19.2", type: "npm", purl: "pkg:npm/express@4.19.2", dependsOn: ["left-pad"] },
];

const sampleInput: BomInput = {
  subjectName: "search-service",
  subjectVersion: "1.0.0",
  subjectId: "sha256:" + "a".repeat(64),
  packages: samplePackages,
  generator: "chant-lockfile-sbom/package-lock.json",
};

describe("writeSpdx (#613) — structural validation against the real SPDX-2.3 JSON Schema", () => {
  const schema = loadSchema("spdx-2.3.schema.json");
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  // The vendored spdx-2.3.schema.json declares draft-07 ($schema), while
  // Ajv2020 is instantiated for draft 2020-12 fixtures elsewhere in this
  // repo (component-schema.test.ts) — use a plain Ajv (draft-07 capable) for
  // this one instead, matching the schema's own declared dialect.
  const ajvDraft07 = new Ajv({ strict: false, allErrors: true });
  const validate = ajvDraft07.compile(schema as object);

  it("is a valid JSON Schema document", () => {
    expect(ajv.validateSchema).toBeDefined();
    expect((schema as { $schema: string }).$schema).toContain("draft-07");
  });

  it("produces a document with every SPDX-2.3-required top-level field", () => {
    const bytes = writeSpdx(sampleInput, FIXED_NOW);
    const doc = JSON.parse(bytes);
    expect(doc.spdxVersion).toBe("SPDX-2.3");
    expect(doc.SPDXID).toBe("SPDXRef-DOCUMENT");
    expect(doc.documentNamespace).toEqual(expect.stringMatching(/^https:\/\//));
    expect(doc.name).toBe("search-service");
    expect(Array.isArray(doc.packages)).toBe(true);
    expect(doc.packages.length).toBeGreaterThan(0);
    for (const pkg of doc.packages) {
      expect(pkg.name).toBeTruthy();
      expect(pkg.SPDXID).toEqual(expect.stringMatching(/^SPDXRef-/));
    }
  });

  it("validates against the real SPDX-2.3 JSON Schema", () => {
    const bytes = writeSpdx(sampleInput, FIXED_NOW);
    const doc = JSON.parse(bytes);
    const valid = validate(doc);
    if (!valid) throw new Error(`SPDX document failed schema validation: ${ajvDraft07.errorsText(validate.errors)}`);
    expect(valid).toBe(true);
  });

  it("includes a DESCRIBES relationship from the document to the subject package, and DEPENDS_ON edges for declared deps", () => {
    const bytes = writeSpdx(sampleInput, FIXED_NOW);
    const doc = JSON.parse(bytes);
    expect(doc.relationships).toContainEqual(
      expect.objectContaining({ relationshipType: "DESCRIBES", spdxElementId: "SPDXRef-DOCUMENT" }),
    );
    expect(doc.relationships).toContainEqual(
      expect.objectContaining({ relationshipType: "DEPENDS_ON", relatedSpdxElement: "SPDXRef-Package-left-pad" }),
    );
  });

  it("is deterministic — identical input produces byte-identical output", () => {
    const a = writeSpdx(sampleInput, FIXED_NOW);
    const b = writeSpdx(sampleInput, FIXED_NOW);
    expect(a).toBe(b);
  });

  it("handles an empty package list (a subject with no declared deps) without failing schema validation", () => {
    const bytes = writeSpdx({ ...sampleInput, packages: [] }, FIXED_NOW);
    const doc = JSON.parse(bytes);
    expect(validate(doc)).toBe(true);
  });
});

describe("writeCycloneDx (#613) — structural validation against the real CycloneDX-1.5 JSON Schema", () => {
  const cdxSchema = loadSchema("cyclonedx-1.5.schema.json");
  const jsfSchema = loadSchema("jsf-0.82.schema.json");
  const spdxLicenseSchema = loadSchema("cyclonedx-spdx-license.schema.json");

  const ajv = new Ajv({ strict: false, allErrors: true });
  ajv.addSchema(jsfSchema as object);
  ajv.addSchema(spdxLicenseSchema as object);
  const validate = ajv.compile(cdxSchema as object);

  it("produces a document with every CycloneDX-1.5-required top-level field", () => {
    const bytes = writeCycloneDx(sampleInput, FIXED_NOW);
    const doc = JSON.parse(bytes);
    expect(doc.bomFormat).toBe("CycloneDX");
    expect(doc.specVersion).toBe("1.5");
    expect(doc.serialNumber).toEqual(expect.stringMatching(/^urn:uuid:/));
    expect(typeof doc.version).toBe("number");
    expect(doc.metadata?.component?.name).toBe("search-service");
    expect(Array.isArray(doc.components)).toBe(true);
    for (const c of doc.components) {
      expect(["application", "library", "framework", "container", "operating-system", "device", "firmware", "file"]).toContain(
        c.type,
      );
      expect(c.name).toBeTruthy();
    }
  });

  it("validates against the real CycloneDX-1.5 JSON Schema", () => {
    const bytes = writeCycloneDx(sampleInput, FIXED_NOW);
    const doc = JSON.parse(bytes);
    const valid = validate(doc);
    if (!valid) throw new Error(`CycloneDX document failed schema validation: ${ajv.errorsText(validate.errors)}`);
    expect(valid).toBe(true);
  });

  it("includes a dependencies section: the root subject depends on every listed component, plus declared inter-component deps", () => {
    const bytes = writeCycloneDx(sampleInput, FIXED_NOW);
    const doc = JSON.parse(bytes);
    const rootDep = doc.dependencies.find((d: { ref: string }) => d.ref === "subject:search-service");
    expect(rootDep.dependsOn).toEqual(expect.arrayContaining(["left-pad", "express"]));
    const expressDep = doc.dependencies.find((d: { ref: string }) => d.ref === "express");
    expect(expressDep.dependsOn).toEqual(["left-pad"]);
  });

  it("is deterministic — identical input produces a byte-identical serialNumber and document", () => {
    const a = writeCycloneDx(sampleInput, FIXED_NOW);
    const b = writeCycloneDx(sampleInput, FIXED_NOW);
    expect(a).toBe(b);
  });

  it("handles an empty package list without failing schema validation", () => {
    const bytes = writeCycloneDx({ ...sampleInput, packages: [] }, FIXED_NOW);
    const doc = JSON.parse(bytes);
    expect(validate(doc)).toBe(true);
  });
});

describe("writeBom (#613) — format dispatch wrapping the project-wide {format, mediaType, bytes} doc shape", () => {
  it("dispatches spdx to writeSpdx and sets the SPDX media type", () => {
    const doc = writeBom("spdx", sampleInput, FIXED_NOW);
    expect(doc.format).toBe("spdx");
    expect(doc.mediaType).toBe("application/spdx+json");
    expect(JSON.parse(doc.bytes).spdxVersion).toBe("SPDX-2.3");
  });

  it("dispatches cyclonedx to writeCycloneDx and sets the CycloneDX media type", () => {
    const doc = writeBom("cyclonedx", sampleInput, FIXED_NOW);
    expect(doc.format).toBe("cyclonedx");
    expect(doc.mediaType).toBe("application/vnd.cyclonedx+json");
    expect(JSON.parse(doc.bytes).bomFormat).toBe("CycloneDX");
  });
});
