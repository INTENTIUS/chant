import { describe, expect, it } from "vitest";
import {
  createLoadImageOnHostCapability,
  createPublishImageCapability,
  createPublishArtifactCapability,
  loadImageOnHostCapability as loadImageOnHost,
  publishImageCapability as publishImage,
  selectPublishBackend,
} from "./publish";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createDockerBuildCapability } from "./build";
import { createMockCloudExecutor } from "./__tests__/mock-cloud-executor";
import { createMockProcessRunner } from "./__tests__/mock-process-runner";

const ctx = { env: "dev", component: "search-service" };

describe("publish-image (#557)", () => {
  it("loads the archived tarball, tags for the destination registry, logs in, and pushes — promoting by digest", async () => {
    const mock = createMockCloudExecutor();
    const capability = createPublishImageCapability(mock.executor);

    const output = await capability.run(ctx, { from: "archive/search.tar", to: "123.dkr.ecr.us-east-1.amazonaws.com/search" });

    expect(output.digest).toMatch(/^sha256:/);
    expect(output.uri).toBe(`123.dkr.ecr.us-east-1.amazonaws.com/search@${output.digest}`);
    expect(mock.calls.map((c) => c.method)).toEqual(["load", "tag", "login", "push"]);
    const loginCall = mock.calls.find((c) => c.method === "login")!;
    expect(loginCall.args).toBe("123.dkr.ecr.us-east-1.amazonaws.com");
  });

  it("pushes additional tags alongside the digest", async () => {
    const mock = createMockCloudExecutor();
    const capability = createPublishImageCapability(mock.executor);

    await capability.run(ctx, {
      from: "archive/search.tar",
      to: "123.dkr.ecr.us-east-1.amazonaws.com/search",
      tags: ["latest", "v1.2.3"],
    });

    const pushCalls = mock.calls.filter((c) => c.method === "push");
    // one push for the digest-qualified reference, one per extra tag
    expect(pushCalls).toHaveLength(3);
    const pushedImages = pushCalls.map((c) => (c.args as { image: string }).image);
    expect(pushedImages.some((i) => i.endsWith(":latest"))).toBe(true);
    expect(pushedImages.some((i) => i.endsWith(":v1.2.3"))).toBe(true);
  });

  it("surfaces a push failure (e.g. registry auth/network) as a rejected promise", async () => {
    const mock = createMockCloudExecutor({ failDocker: true });
    const capability = createPublishImageCapability(mock.executor);
    await expect(
      capability.run(ctx, { from: "archive/search.tar", to: "123.dkr.ecr.us-east-1.amazonaws.com/search" }),
    ).rejects.toThrow(/docker push failed/);
  });

  it("declares no rollback — an already-pushed, content-addressed image is not itself something to undo", () => {
    const capability = createPublishImageCapability(createMockCloudExecutor().executor);
    expect(capability.rollback).toBeUndefined();
  });

  it("accepts an archive: wiring reference the same way cfn-deploy's template field does", async () => {
    const mock = createMockCloudExecutor();
    const capability = createPublishImageCapability(mock.executor);
    await capability.run(ctx, { from: "archive:search.tar", to: "123.dkr.ecr.us-east-1.amazonaws.com/search" });
    const loadCall = mock.calls.find((c) => c.method === "load")!;
    expect(loadCall.args).toMatchObject({ inFile: "search.tar" });
  });

  it("requires to — throws a clear error rather than silently no-op-ing when the env forgot to configure a registry", async () => {
    const mock = createMockCloudExecutor();
    const capability = createPublishImageCapability(mock.executor);
    await expect(capability.run(ctx, { from: "archive/search.tar" })).rejects.toThrow(/"to".*is required/);
  });
});

describe("publish-image — SBOM/component-BOM referrer attach (#610)", () => {
  it("does nothing (no oras call at all) when neither sbom nor componentBom is supplied", async () => {
    const cloud = createMockCloudExecutor();
    const proc = createMockProcessRunner();
    const capability = createPublishImageCapability(cloud.executor, proc.runner);

    const output = await capability.run(ctx, { from: "archive/search.tar", to: "123.dkr.ecr.us-east-1.amazonaws.com/search" });

    expect(output.referrerAttach).toBeUndefined();
    expect(proc.calls).toHaveLength(0);
  });

  it("attaches the SBOM as an OCI referrer on the pushed digest via oras attach", async () => {
    const cloud = createMockCloudExecutor();
    const proc = createMockProcessRunner();
    const capability = createPublishImageCapability(cloud.executor, proc.runner);

    const output = await capability.run(ctx, {
      from: "archive/search.tar",
      to: "123.dkr.ecr.us-east-1.amazonaws.com/search",
      sbom: { bytes: '{"fake":"sbom"}', mediaType: "application/spdx+json" },
    });

    expect(output.referrerAttach).toEqual({ attached: true });
    const attachCall = proc.calls.find((c) => c.command.startsWith("oras attach"))!;
    expect(attachCall.command).toContain("--artifact-type 'application/spdx+json'");
    expect(attachCall.command).toContain(`123.dkr.ecr.us-east-1.amazonaws.com/search@${output.digest}`);
  });

  it("attaches both the SBOM and the component BOM when both are supplied", async () => {
    const cloud = createMockCloudExecutor();
    const proc = createMockProcessRunner();
    const capability = createPublishImageCapability(cloud.executor, proc.runner);

    await capability.run(ctx, {
      from: "archive/search.tar",
      to: "123.dkr.ecr.us-east-1.amazonaws.com/search",
      sbom: { bytes: '{"fake":"sbom"}', mediaType: "application/spdx+json" },
      componentBom: { bytes: '{"fake":"bom"}', mediaType: "application/vnd.cyclonedx+json" },
    });

    const attachCalls = proc.calls.filter((c) => c.command.startsWith("oras attach"));
    expect(attachCalls).toHaveLength(2);
    expect(attachCalls.some((c) => c.command.includes("application/spdx+json"))).toBe(true);
    expect(attachCalls.some((c) => c.command.includes("application/vnd.cyclonedx+json"))).toBe(true);
  });

  it("reports attached: false with a reason, and does not fail the publish, when oras is not installed", async () => {
    const cloud = createMockCloudExecutor();
    const proc = createMockProcessRunner({ tools: { oras: false } });
    const capability = createPublishImageCapability(cloud.executor, proc.runner);

    const output = await capability.run(ctx, {
      from: "archive/search.tar",
      to: "123.dkr.ecr.us-east-1.amazonaws.com/search",
      sbom: { bytes: '{"fake":"sbom"}', mediaType: "application/spdx+json" },
    });

    expect(output.digest).toMatch(/^sha256:/); // the image itself still published successfully.
    expect(output.referrerAttach?.attached).toBe(false);
    expect(output.referrerAttach?.reason).toMatch(/oras.*not installed/);
    expect(proc.calls.some((c) => c.command.startsWith("oras attach"))).toBe(false);
  });

  it("reports attached: false with a reason, and does not fail the publish, when oras attach itself fails", async () => {
    const cloud = createMockCloudExecutor();
    const proc = createMockProcessRunner({ failures: { "oras attach": "oras: unauthorized" } });
    const capability = createPublishImageCapability(cloud.executor, proc.runner);

    const output = await capability.run(ctx, {
      from: "archive/search.tar",
      to: "123.dkr.ecr.us-east-1.amazonaws.com/search",
      sbom: { bytes: '{"fake":"sbom"}', mediaType: "application/spdx+json" },
    });

    expect(output.digest).toMatch(/^sha256:/);
    expect(output.referrerAttach).toEqual({ attached: false, reason: "oras: unauthorized" });
  });

  it("load-image-on-host never attempts a referrer attach — registry-less, nothing to attach to", async () => {
    const cloud = createMockCloudExecutor();
    const proc = createMockProcessRunner();
    const capability = createLoadImageOnHostCapability(cloud.executor);

    const output = await capability.run(ctx, {
      from: "archive/search.tar",
      host: "i-abc",
      sbom: { bytes: '{"fake":"sbom"}', mediaType: "application/spdx+json" },
    });

    expect(output.referrerAttach).toBeUndefined();
    expect(proc.calls).toHaveLength(0);
  });
});

describe("load-image-on-host (#564 — registry-less backend)", () => {
  it("copies the archived tarball to the host and docker-loads it there, with no registry/ECR calls at all", async () => {
    const mock = createMockCloudExecutor();
    const capability = createLoadImageOnHostCapability(mock.executor);

    const output = await capability.run(ctx, { from: "archive/search.tar", host: "i-0123456789abcdef0" });

    expect(output.digest).toMatch(/^sha256:/);
    expect(output.uri).toBe(`host:i-0123456789abcdef0#${output.digest}`);
    expect(mock.calls.map((c) => `${c.client}.${c.method}`)).toEqual(["host.copyFile", "host.dockerLoad"]);
    expect(mock.calls.some((c) => c.client === "ecr" || c.client === "docker")).toBe(false);
  });

  it("defaults the on-host path to the archive path's basename under /tmp/chant-archive", async () => {
    const mock = createMockCloudExecutor();
    const capability = createLoadImageOnHostCapability(mock.executor);
    await capability.run(ctx, { from: "archive/search.tar", host: "i-abc" });
    const copyCall = mock.calls.find((c) => c.method === "copyFile")!;
    expect(copyCall.args).toMatchObject({ to: "/tmp/chant-archive/search.tar" });
  });

  it("accepts an archive: wiring reference and an explicit destination path", async () => {
    const mock = createMockCloudExecutor();
    const capability = createLoadImageOnHostCapability(mock.executor);
    await capability.run(ctx, { from: "archive:search.tar", host: "i-abc", hostPath: "/opt/images/search.tar" });
    const copyCall = mock.calls.find((c) => c.method === "copyFile")!;
    expect(copyCall.args).toMatchObject({ from: "search.tar", to: "/opt/images/search.tar" });
  });

  it("requires host — throws a clear error rather than silently no-op-ing when the env forgot to configure one", async () => {
    const mock = createMockCloudExecutor();
    const capability = createLoadImageOnHostCapability(mock.executor);
    await expect(capability.run(ctx, { from: "archive/search.tar" })).rejects.toThrow(/"host" is required/);
  });

  it("surfaces a host copy/load failure (unreachable host) as a rejected promise", async () => {
    const mock = createMockCloudExecutor({ failHost: true });
    const capability = createLoadImageOnHostCapability(mock.executor);
    await expect(capability.run(ctx, { from: "archive/search.tar", host: "i-abc" })).rejects.toThrow(
      /host copy failed/,
    );
  });

  it("declares no rollback — an already-loaded, content-addressed image on the host is not itself something to undo", () => {
    const capability = createLoadImageOnHostCapability(createMockCloudExecutor().executor);
    expect(capability.rollback).toBeUndefined();
  });
});

describe("promote by digest — deferred publish never rebuilds per environment (#564 acceptance criterion)", () => {
  it("one docker-build's archived image promotes to two environments (registry + host-load) from the same archive, with no second build", async () => {
    // One archive/executor shared across build + both env promotions — the
    // same archive the build produced is what each environment's publish
    // step reads from, never a fresh build.
    const mock = createMockCloudExecutor();
    const { archivePath } = await createDockerBuildCapability(mock.executor).run(ctx, {
      context: ".",
      into: "archive/search.tar",
    });
    expect(mock.calls.filter((c) => c.method === "build")).toHaveLength(1);

    // dev: env config selects the registry backend.
    const devBackend = selectPublishBackend("publish-image", {
      "publish-image": createPublishImageCapability(mock.executor),
      "load-image-on-host": createLoadImageOnHostCapability(mock.executor),
    });
    const devOutput = await devBackend.run(
      { env: "dev", component: "search-service" },
      { from: archivePath, to: "123.dkr.ecr.us-east-1.amazonaws.com/search" },
    );

    // prod: env config selects the registry-less host backend for the *same archive path* — no rebuild.
    const prodBackend = selectPublishBackend("load-image-on-host", {
      "publish-image": createPublishImageCapability(mock.executor),
      "load-image-on-host": createLoadImageOnHostCapability(mock.executor),
    });
    const prodOutput = await prodBackend.run(
      { env: "prod", component: "search-service" },
      { from: archivePath, host: "i-prodhost" },
    );

    // Exactly one build happened for the whole scenario — both environment
    // promotions read the same archived tarball rather than triggering a
    // second `docker build`. `publish-image` reads it via `docker.load`;
    // `load-image-on-host` reads the very same path via `host.copyFile`
    // instead — two different backends, one unrebuilt archive.
    expect(mock.calls.filter((c) => c.method === "build")).toHaveLength(1);
    expect(mock.calls.find((c) => c.method === "load")?.args).toMatchObject({ inFile: archivePath });
    expect(mock.calls.find((c) => c.method === "copyFile")?.args).toMatchObject({ from: archivePath });
    expect(devOutput.digest).toMatch(/^sha256:/);
    expect(prodOutput.digest).toMatch(/^sha256:/);
  });

  it("selectPublishBackend defaults to the two starter-set backends and throws on an unknown kind", () => {
    expect(selectPublishBackend("publish-image")).toBe(publishImage);
    expect(selectPublishBackend("load-image-on-host")).toBe(loadImageOnHost);
    expect(() =>
      selectPublishBackend(
        // @ts-expect-error deliberately invalid kind to exercise the error path
        "something-else",
      ),
    ).toThrow(/no publish backend registered/);
  });
});

describe("publish-artifact (#557)", () => {
  it("uploads the archive file to S3 and returns its uri + content digest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-pa-"));
    const file = join(dir, "app.jar");
    writeFileSync(file, "JAR-BYTES");
    const expectedDigest = `sha256:${createHash("sha256").update("JAR-BYTES").digest("hex")}`;
    const mock = createMockCloudExecutor();

    const out = await createPublishArtifactCapability(mock.executor).run(
      { env: "dev", component: "jar-lib" },
      { from: file, to: "s3://artifacts/jars/" },
    );

    expect(out.digest).toBe(expectedDigest);
    expect(out.uri).toBe("s3://artifacts/jars/app.jar"); // trailing-slash `to` appends the basename
    expect(mock.calls).toEqual([
      { client: "s3", method: "cp", args: { from: file, to: "s3://artifacts/jars/app.jar" } },
    ]);
  });

  it("strips an archive: prefix and uses `to` verbatim when it is a full key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-pa-"));
    const file = join(dir, "asset.bin");
    writeFileSync(file, "X");
    const mock = createMockCloudExecutor();

    const out = await createPublishArtifactCapability(mock.executor).run(
      { env: "dev", component: "c" },
      { from: `archive:${file}`, to: "s3://b/exact-key" },
    );

    expect(out.uri).toBe("s3://b/exact-key");
    expect(mock.calls[0]!.args).toEqual({ from: file, to: "s3://b/exact-key" });
  });

  it("declares no rollback", () => {
    expect(createPublishArtifactCapability(createMockCloudExecutor().executor).rollback).toBeUndefined();
  });
});
