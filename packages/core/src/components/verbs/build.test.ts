import { describe, expect, it } from "vitest";
import { addArchiveTemplate, createDockerBuildCapability } from "./build";
import { createMockCloudExecutor } from "./__tests__/mock-cloud-executor";
import { findArchiveEntry } from "./build-archive";

const ctx = { env: "dev", component: "search-service" };

describe("docker-build (#557)", () => {
  it("builds via the injected executor and saves the tarball into the archive path, returning the built digest", async () => {
    const mock = createMockCloudExecutor();
    const capability = createDockerBuildCapability(mock.executor);

    const output = await capability.run(ctx, { context: ".", into: "archive/search.tar" });

    expect(output.archivePath).toBe("archive/search.tar");
    expect(output.digest).toMatch(/^sha256:/);
    expect(mock.calls.map((c) => c.method)).toEqual(["build", "save"]);
    const buildCall = mock.calls.find((c) => c.method === "build")!;
    expect(buildCall.args).toMatchObject({ context: "." });
    const saveCall = mock.calls.find((c) => c.method === "save")!;
    expect(saveCall.args).toMatchObject({ outFile: "archive/search.tar" });
  });

  it("passes dockerfile/target/buildArgs through to the executor", async () => {
    const mock = createMockCloudExecutor();
    const capability = createDockerBuildCapability(mock.executor);

    await capability.run(ctx, {
      context: ".",
      dockerfile: "Dockerfile.prod",
      target: "release",
      buildArgs: { NODE_ENV: "production" },
      into: "archive/x.tar",
    });

    const buildCall = mock.calls.find((c) => c.method === "build")!;
    expect(buildCall.args).toMatchObject({
      dockerfile: "Dockerfile.prod",
      target: "release",
      buildArgs: { NODE_ENV: "production" },
    });
  });

  it("surfaces a docker build failure as a rejected promise (never swallowed)", async () => {
    const mock = createMockCloudExecutor({ failDocker: true });
    const capability = createDockerBuildCapability(mock.executor);
    await expect(capability.run(ctx, { context: ".", into: "archive/x.tar" })).rejects.toThrow(/docker build failed/);
  });

  it("declares no rollback — a local build has no remote/mutable state to compensate", () => {
    const capability = createDockerBuildCapability(createMockCloudExecutor().executor);
    expect(capability.rollback).toBeUndefined();
  });
});

describe("docker-build -> BuildArchive manifest (#564)", () => {
  it("records the built image as a manifest entry, content-addressed by its digest", async () => {
    const mock = createMockCloudExecutor();
    const capability = createDockerBuildCapability(mock.executor);

    const output = await capability.run(ctx, { context: ".", into: "archive/search.tar" });

    expect(output.manifest.component).toBe("search-service");
    const entry = findArchiveEntry(output.manifest, "archive/search.tar");
    expect(entry).toMatchObject({ kind: "image", digest: output.digest });
    expect(output.manifest.manifestDigest).toMatch(/^sha256:/);
  });

  it("accumulates onto a manifest threaded through from a prior build/template step", async () => {
    const mock = createMockCloudExecutor();
    const capability = createDockerBuildCapability(mock.executor);

    const { manifest: templateManifest } = addArchiveTemplate({
      path: "search.template.json",
      content: JSON.stringify({ Resources: {} }),
    });
    const output = await capability.run(ctx, {
      context: ".",
      into: "archive/search.tar",
      manifest: templateManifest,
    });

    expect(output.manifest.contents.map((e) => e.kind).sort()).toEqual(["image", "template"]);
    expect(output.manifest.contents).toHaveLength(2);
  });

  it("two builds from identical inputs produce the same manifest digest (content-addressed, not build-order-addressed)", async () => {
    const mockA = createMockCloudExecutor();
    const mockB = createMockCloudExecutor();
    const outputA = await createDockerBuildCapability(mockA.executor).run(ctx, {
      context: ".",
      into: "archive/search.tar",
    });
    const outputB = await createDockerBuildCapability(mockB.executor).run(ctx, {
      context: ".",
      into: "archive/search.tar",
    });
    expect(outputA.digest).toBe(outputB.digest);
    expect(outputA.manifest.manifestDigest).toBe(outputB.manifest.manifestDigest);
  });

  it("defaults to best-effort reproducibility, per #614 — an externally-built image, not chant's own synthesis", async () => {
    const mock = createMockCloudExecutor();
    const capability = createDockerBuildCapability(mock.executor);
    const output = await capability.run(ctx, { context: ".", into: "archive/search.tar" });
    expect(findArchiveEntry(output.manifest, "archive/search.tar")!.reproducibility).toEqual({ basis: "best-effort" });
  });

  it("records a provenance link when sourceRef is given (#614)", async () => {
    const mock = createMockCloudExecutor();
    const capability = createDockerBuildCapability(mock.executor);
    const output = await capability.run(ctx, { context: ".", into: "archive/search.tar", sourceRef: "deadbeef" });
    expect(findArchiveEntry(output.manifest, "archive/search.tar")!.provenance).toEqual({
      sourceRef: "deadbeef",
      artifactDigest: output.digest,
    });
  });

  it("records no provenance link when sourceRef is omitted", async () => {
    const mock = createMockCloudExecutor();
    const capability = createDockerBuildCapability(mock.executor);
    const output = await capability.run(ctx, { context: ".", into: "archive/search.tar" });
    expect(findArchiveEntry(output.manifest, "archive/search.tar")!.provenance).toBeUndefined();
  });
});

describe("addArchiveTemplate (#564)", () => {
  it("adds a template entry whose digest depends only on content", () => {
    const a = addArchiveTemplate({ path: "x.template.json", content: '{"a":1}' });
    const b = addArchiveTemplate({ path: "x.template.json", content: '{"a":1}' });
    const c = addArchiveTemplate({ path: "x.template.json", content: '{"a":2}' });

    expect(a.digest).toBe(b.digest);
    expect(a.digest).not.toBe(c.digest);
    expect(findArchiveEntry(a.manifest, "x.template.json")).toMatchObject({ kind: "template", digest: a.digest });
  });

  it("defaults to deterministic-synthesis reproducibility, per #614", () => {
    const { manifest } = addArchiveTemplate({ path: "x.template.json", content: '{"a":1}' });
    expect(findArchiveEntry(manifest, "x.template.json")!.reproducibility).toEqual({
      basis: "deterministic-synthesis",
      verifyBy: "re-synth",
    });
  });

  it("records a provenance link when sourceRef is given (#614)", () => {
    const { manifest, digest } = addArchiveTemplate({
      path: "x.template.json",
      content: '{"a":1}',
      sourceRef: "abc123def",
    });
    expect(findArchiveEntry(manifest, "x.template.json")!.provenance).toEqual({
      sourceRef: "abc123def",
      artifactDigest: digest,
    });
  });

  it("records no provenance link when sourceRef is omitted", () => {
    const { manifest } = addArchiveTemplate({ path: "x.template.json", content: '{"a":1}' });
    expect(findArchiveEntry(manifest, "x.template.json")!.provenance).toBeUndefined();
  });
});
