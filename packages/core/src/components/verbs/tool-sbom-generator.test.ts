/**
 * Tests the real, deep-scan `SbomGenerator` backend (#610,
 * ./tool-sbom-generator.ts) against a `MockProcessRunner`
 * (./__tests__/mock-process-runner.ts) — no live `syft`/`docker buildx`/
 * `cyclonedx-maven`/`cdxgen` invoked. Asserts the command each artifact type
 * dispatches to, that output is parsed (package count), and that a missing
 * tool surfaces `ToolNotAvailableError` rather than a silent/empty SBOM.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createToolSbomGenerator } from "./tool-sbom-generator";
import { ToolNotAvailableError } from "./process-runner";
import { createMockProcessRunner } from "./__tests__/mock-process-runner";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-tool-sbom-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const CYCLONEDX_DOC = JSON.stringify({ bomFormat: "CycloneDX", components: [{ name: "left-pad" }, { name: "express" }] });
const SPDX_DOC = JSON.stringify({ spdxVersion: "SPDX-2.3", packages: [{ name: "left-pad" }] });

describe("createToolSbomGenerator — forDir (#610)", () => {
  it("scans with syft when available, requesting the SPDX format by default", async () => {
    const dir = tempDir();
    const mock = createMockProcessRunner({ responses: { "cat ": SPDX_DOC } });
    const generator = createToolSbomGenerator({ runner: mock.runner });

    const doc = await generator.forDir({ path: dir });

    expect(doc.format).toBe("spdx");
    expect(doc.mediaType).toBe("application/spdx+json");
    expect(doc.generator).toBe("syft");
    expect(doc.packageCount).toBe(1);
    const syftCall = mock.calls.find((c) => c.command.startsWith("syft "))!;
    expect(syftCall.command).toContain(`syft '${dir}' -o spdx-json=`);
  });

  it("requests CycloneDX output when format is cyclonedx", async () => {
    const dir = tempDir();
    const mock = createMockProcessRunner({ responses: { "cat ": CYCLONEDX_DOC } });
    const generator = createToolSbomGenerator({ runner: mock.runner });

    const doc = await generator.forDir({ path: dir, format: "cyclonedx" });

    expect(doc.mediaType).toBe("application/vnd.cyclonedx+json");
    expect(doc.packageCount).toBe(2);
    const syftCall = mock.calls.find((c) => c.command.startsWith("syft "))!;
    expect(syftCall.command).toContain("-o cyclonedx-json=");
  });

  it("falls back to cdxgen when syft is unavailable", async () => {
    const dir = tempDir();
    const mock = createMockProcessRunner({
      tools: { syft: false, cdxgen: true },
      responses: { "cat ": CYCLONEDX_DOC },
    });
    const generator = createToolSbomGenerator({ runner: mock.runner });

    const doc = await generator.forDir({ path: dir });

    expect(doc.generator).toBe("cdxgen");
    expect(doc.format).toBe("cyclonedx"); // cdxgen is CycloneDX-only, even though SPDX is the project default.
    expect(mock.calls.some((c) => c.command.startsWith("cdxgen "))).toBe(true);
    expect(mock.calls.some((c) => c.command.startsWith("syft "))).toBe(false);
  });

  it("throws ToolNotAvailableError when neither syft nor cdxgen is installed", async () => {
    const dir = tempDir();
    const mock = createMockProcessRunner({ tools: { syft: false, cdxgen: false } });
    const generator = createToolSbomGenerator({ runner: mock.runner });

    await expect(generator.forDir({ path: dir })).rejects.toThrow(ToolNotAvailableError);
  });
});

describe("createToolSbomGenerator — forZip (#610)", () => {
  it("always scans with syft", async () => {
    const mock = createMockProcessRunner({ responses: { "cat ": CYCLONEDX_DOC } });
    const generator = createToolSbomGenerator({ runner: mock.runner });

    const doc = await generator.forZip({ zipPath: "archive/lambda.zip", digest: "sha256:aaa", format: "cyclonedx" });

    expect(doc.generator).toBe("syft");
    expect(doc.packageCount).toBe(2);
    expect(mock.calls.some((c) => c.command.includes("archive/lambda.zip"))).toBe(true);
  });

  it("throws ToolNotAvailableError when syft is unavailable (no fallback for zip)", async () => {
    const mock = createMockProcessRunner({ tools: { syft: false } });
    const generator = createToolSbomGenerator({ runner: mock.runner });
    await expect(generator.forZip({ zipPath: "archive/lambda.zip", digest: "sha256:aaa" })).rejects.toThrow(
      ToolNotAvailableError,
    );
  });
});

describe("createToolSbomGenerator — forJar (#610)", () => {
  it("scans with syft when no pom.xml sits alongside the jar", async () => {
    const dir = tempDir();
    const jarPath = join(dir, "app.jar");
    const mock = createMockProcessRunner({ responses: { "cat ": CYCLONEDX_DOC } });
    const generator = createToolSbomGenerator({ runner: mock.runner });

    const doc = await generator.forJar({ jarPath, digest: "sha256:bbb", format: "cyclonedx" });

    expect(doc.generator).toBe("syft");
    expect(mock.calls.some((c) => c.command.startsWith("mvn "))).toBe(false);
  });

  it("prefers cyclonedx-maven when a pom.xml sits alongside the jar and mvn is available", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "pom.xml"), "<project></project>");
    const jarPath = join(dir, "app.jar");
    const mock = createMockProcessRunner({ tools: { mvn: true }, responses: { "cat ": CYCLONEDX_DOC } });
    const generator = createToolSbomGenerator({ runner: mock.runner });

    const doc = await generator.forJar({ jarPath, digest: "sha256:bbb" });

    expect(doc.generator).toBe("cyclonedx-maven");
    expect(doc.format).toBe("cyclonedx"); // cyclonedx-maven always produces CycloneDX regardless of the requested default.
    const mvnCall = mock.calls.find((c) => c.command.startsWith("mvn "))!;
    expect(mvnCall.command).toContain("cyclonedx-maven-plugin");
  });

  it("falls back to syft when a pom.xml is present but mvn is not installed", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "pom.xml"), "<project></project>");
    const jarPath = join(dir, "app.jar");
    const mock = createMockProcessRunner({ tools: { mvn: false, syft: true }, responses: { "cat ": CYCLONEDX_DOC } });
    const generator = createToolSbomGenerator({ runner: mock.runner });

    const doc = await generator.forJar({ jarPath, digest: "sha256:bbb" });
    expect(doc.generator).toBe("syft");
  });
});

describe("createToolSbomGenerator — forImage (#610)", () => {
  it("scans the saved tarball with syft when no Dockerfile sits next to it", async () => {
    const dir = tempDir();
    const imagePath = join(dir, "search.tar");
    const mock = createMockProcessRunner({ responses: { "cat ": SPDX_DOC } });
    const generator = createToolSbomGenerator({ runner: mock.runner });

    const doc = await generator.forImage({ imagePath, digest: "sha256:ccc" });

    expect(doc.generator).toBe("syft");
    expect(mock.calls.some((c) => c.command.startsWith("docker buildx"))).toBe(false);
  });

  it("prefers BuildKit's --sbom attestation when a Dockerfile sits next to the tarball and docker is available", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "Dockerfile"), "FROM scratch");
    const imagePath = join(dir, "search.tar");
    const mock = createMockProcessRunner({ tools: { docker: true }, responses: { "cat ": SPDX_DOC } });
    const generator = createToolSbomGenerator({ runner: mock.runner });

    const doc = await generator.forImage({ imagePath, digest: "sha256:ccc" });

    expect(doc.generator).toBe("buildkit");
    expect(doc.format).toBe("spdx");
    const buildxCall = mock.calls.find((c) => c.command.startsWith("docker buildx"))!;
    expect(buildxCall.command).toContain("--sbom=true");
    expect(buildxCall.command).toContain(dir);
  });

  it("falls back to syft when a Dockerfile is present but docker is unavailable", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "Dockerfile"), "FROM scratch");
    const imagePath = join(dir, "search.tar");
    const mock = createMockProcessRunner({ tools: { docker: false, syft: true }, responses: { "cat ": SPDX_DOC } });
    const generator = createToolSbomGenerator({ runner: mock.runner });

    const doc = await generator.forImage({ imagePath, digest: "sha256:ccc" });
    expect(doc.generator).toBe("syft");
  });

  it("throws ToolNotAvailableError when falling back to syft and syft is also unavailable", async () => {
    const dir = tempDir();
    const imagePath = join(dir, "search.tar");
    const mock = createMockProcessRunner({ tools: { syft: false } });
    const generator = createToolSbomGenerator({ runner: mock.runner });

    await expect(generator.forImage({ imagePath, digest: "sha256:ccc" })).rejects.toThrow(ToolNotAvailableError);
  });
});
