/**
 * Tests the hermetic lockfile/manifest-derived `SbomGenerator` (#613) against
 * fixture lockfiles (./__fixtures__/package-lock.json,
 * ./__fixtures__/pom.xml) — no network, no `syft`/`docker`/`mvn` invoked.
 */

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import {
  parseNpmPackageLock,
  parsePomXml,
  createLockfileSbomGenerator,
  sbomOutputPath,
} from "./lockfile-sbom-generator";
import { SbomGeneratorNotImplementedError } from "./sbom-generator";

const FIXTURES_DIR = join(import.meta.dirname, "__fixtures__");
const NPM_LOCK = readFileSync(join(FIXTURES_DIR, "package-lock.json"), "utf-8");
const POM_XML = readFileSync(join(FIXTURES_DIR, "pom.xml"), "utf-8");

describe("parseNpmPackageLock (#613)", () => {
  it("extracts every non-root package with its resolved version", () => {
    const packages = parseNpmPackageLock(NPM_LOCK);
    const names = packages.map((p) => p.name).sort();
    expect(names).toEqual(["accepts", "body-parser", "express", "left-pad", "mocha"]);
    const express = packages.find((p) => p.name === "express")!;
    expect(express.version).toBe("4.19.2");
    expect(express.type).toBe("npm");
    expect(express.purl).toBe("pkg:npm/express@4.19.2");
  });

  it("records declared dependency edges for DEPENDS_ON relationships", () => {
    const packages = parseNpmPackageLock(NPM_LOCK);
    const express = packages.find((p) => p.name === "express")!;
    expect(express.dependsOn).toEqual(expect.arrayContaining(["accepts", "body-parser"]));
  });

  it("does not include the root project itself as a dependency", () => {
    const packages = parseNpmPackageLock(NPM_LOCK);
    expect(packages.find((p) => p.name === "fixture-search-service")).toBeUndefined();
  });

  it("falls back to the v1 nested dependencies tree when packages is absent", () => {
    const v1Lock = JSON.stringify({
      name: "fixture-v1",
      version: "1.0.0",
      dependencies: {
        "left-pad": { version: "1.3.0", requires: {} },
        chalk: { version: "4.1.2", requires: { "left-pad": "1.3.0" } },
      },
    });
    const packages = parseNpmPackageLock(v1Lock);
    expect(packages.map((p) => p.name).sort()).toEqual(["chalk", "left-pad"]);
    expect(packages.find((p) => p.name === "chalk")!.dependsOn).toEqual(["left-pad"]);
  });
});

describe("parsePomXml (#613)", () => {
  it("extracts every declared <dependency> from the top-level <dependencies> block", () => {
    const packages = parsePomXml(POM_XML);
    const names = packages.map((p) => p.name).sort();
    expect(names).toEqual([
      "com.fasterxml.jackson.core:jackson-databind",
      "org.apache.spark:spark-core_2.12",
      "org.junit.jupiter:junit-jupiter",
    ]);
  });

  it("does not pull dependencies declared only in <dependencyManagement>", () => {
    const packages = parsePomXml(POM_XML);
    expect(packages.find((p) => p.name.includes("should-not-appear"))).toBeUndefined();
  });

  it("derives a maven purl from groupId/artifactId/version", () => {
    const packages = parsePomXml(POM_XML);
    const spark = packages.find((p) => p.name === "org.apache.spark:spark-core_2.12")!;
    expect(spark.version).toBe("3.5.1");
    expect(spark.type).toBe("maven");
    expect(spark.purl).toBe("pkg:maven/org.apache.spark/spark-core_2.12@3.5.1");
  });

  it("returns an empty list when there is no <dependencies> block", () => {
    expect(parsePomXml("<project></project>")).toEqual([]);
  });
});

describe("createLockfileSbomGenerator (#613) — hermetic SbomGenerator backend", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  function withNpmFixture(): string {
    tmpDir = mkdtempSync(join(tmpdir(), "chant-sbom-npm-"));
    writeFileSync(join(tmpDir, "package-lock.json"), NPM_LOCK);
    return tmpDir;
  }

  function withMavenFixture(): string {
    tmpDir = mkdtempSync(join(tmpdir(), "chant-sbom-maven-"));
    writeFileSync(join(tmpDir, "pom.xml"), POM_XML);
    return tmpDir;
  }

  it("forDir scans a directory's package-lock.json and emits a valid SPDX doc by default", async () => {
    const dir = withNpmFixture();
    const generator = createLockfileSbomGenerator();
    const doc = await generator.forDir({ path: dir });
    expect(doc.format).toBe("spdx");
    expect(doc.mediaType).toBe("application/spdx+json");
    expect(doc.packageCount).toBe(5);
    expect(doc.generator).toBe("chant-lockfile-sbom/package-lock.json");
    const parsed = JSON.parse(doc.bytes);
    expect(parsed.spdxVersion).toBe("SPDX-2.3");
  });

  it("forDir scans a directory's pom.xml when no package-lock.json is present", async () => {
    const dir = withMavenFixture();
    const generator = createLockfileSbomGenerator();
    const doc = await generator.forDir({ path: dir });
    expect(doc.packageCount).toBe(3);
    expect(doc.generator).toBe("chant-lockfile-sbom/pom.xml");
  });

  it("honors an explicit cyclonedx format request", async () => {
    const dir = withNpmFixture();
    const generator = createLockfileSbomGenerator();
    const doc = await generator.forDir({ path: dir, format: "cyclonedx" });
    expect(doc.format).toBe("cyclonedx");
    expect(doc.mediaType).toBe("application/vnd.cyclonedx+json");
    expect(JSON.parse(doc.bytes).bomFormat).toBe("CycloneDX");
  });

  it("writes the SBOM to disk as sbom.<format>.json alongside the scanned directory", async () => {
    const dir = withNpmFixture();
    const generator = createLockfileSbomGenerator();
    await generator.forDir({ path: dir });
    const written = readFileSync(sbomOutputPath(dir, "spdx"), "utf-8");
    expect(JSON.parse(written).spdxVersion).toBe("SPDX-2.3");
  });

  it("writes to a distinct outDir when configured, instead of alongside the scanned directory", async () => {
    const dir = withNpmFixture();
    const outDir = join(dir, "out");
    const generator = createLockfileSbomGenerator({ outDir });
    await generator.forDir({ path: dir });
    const written = readFileSync(sbomOutputPath(outDir, "spdx"), "utf-8");
    expect(JSON.parse(written).spdxVersion).toBe("SPDX-2.3");
  });

  it("forJar/forZip scan the artifact's containing directory for a lockfile", async () => {
    const dir = withNpmFixture();
    const generator = createLockfileSbomGenerator();
    const jarDoc = await generator.forJar({ jarPath: join(dir, "lib.jar"), digest: "sha256:jar1" });
    expect(jarDoc.packageCount).toBe(5);
    const zipDoc = await generator.forZip({ zipPath: join(dir, "fn.zip"), digest: "sha256:zip1" });
    expect(zipDoc.packageCount).toBe(5);
  });

  it("forImage throws SbomGeneratorNotImplementedError — an image's base layers are outside a lockfile's scope", async () => {
    const generator = createLockfileSbomGenerator();
    await expect(generator.forImage({ imagePath: "x.tar", digest: "sha256:1" })).rejects.toBeInstanceOf(
      SbomGeneratorNotImplementedError,
    );
  });

  it("throws a clear error when no supported lockfile/manifest is found", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "chant-sbom-empty-"));
    const generator = createLockfileSbomGenerator();
    await expect(generator.forDir({ path: tmpDir })).rejects.toThrow(/no supported lockfile/);
  });

  it("two generations from identical (path + content) input produce the same digest/bytes (content-addressed)", async () => {
    // Use two fixed, identically-named subdirectories under one root so
    // `path` (which feeds both subjectName and, absent a digest, subjectId)
    // is identical across both scans — isolating the assertion to "same
    // input, same output" rather than incidentally varying by directory
    // identity (which mkdtempSync's random suffix would otherwise do).
    const root = mkdtempSync(join(tmpdir(), "chant-sbom-determinism-"));
    tmpDir = root;
    const dirA = join(root, "component");
    const dirB = join(root, "component"); // same path, scanned twice in sequence
    mkdirSync(dirA, { recursive: true });
    writeFileSync(join(dirA, "package-lock.json"), NPM_LOCK);

    const fixedNow = () => new Date("2026-01-01T00:00:00.000Z");
    const docA = await createLockfileSbomGenerator({ now: fixedNow }).forDir({ path: dirA });
    const docB = await createLockfileSbomGenerator({ now: fixedNow }).forDir({ path: dirB });

    expect(docA.bytes).toBe(docB.bytes);
  });
});
