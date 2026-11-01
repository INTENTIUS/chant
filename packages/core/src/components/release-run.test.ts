/**
 * A run of a release's own artifacts (#4694): build steps out, a handed image
 * into `release-image` and in place of a publish, refusals before anything runs.
 */
import { describe, test, expect } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { releaseRunComponents } from "./release-run";
import { releaseImageCapability } from "./verbs/release-image";
import type { DriverComponent } from "./driver";
import type { ReleaseArtifact } from "../lifecycle/release-store";

const IMAGE = `registry.fly.io/control@sha256:${"b".repeat(64)}`;
const handed: ReleaseArtifact = { component: "control", kind: "image", path: "", digest: `sha256:${"b".repeat(64)}`, ref: IMAGE };
const release = (artifactDigests: ReleaseArtifact[]) => ({ releaseDigest: "jcs1-sha256:r", artifactDigests });

const control: DriverComponent = {
  name: "control",
  dependsOn: [],
  deploy: [
    { phase: "Approve", steps: [{ kind: "gate", gate: "prod-release" }] },
    { phase: "Image", steps: [{ kind: "release-image" }] },
    { phase: "Release", steps: [{ kind: "fly-release", plan: "dist/fly.json", image: "@Image.uri", digest: "@Image.digest" }] },
  ],
};

const api: DriverComponent = {
  name: "api",
  dependsOn: [],
  deploy: [
    { phase: "Build", steps: [{ kind: "docker-build", context: "api", into: "out/api.tar" }] },
    { phase: "Publish", steps: [{ kind: "publish-image", from: "archive:out/api.tar", to: "r.io/api" }] },
    { phase: "Apply", steps: [{ kind: "ecs-update-service", image: "@Publish.uri" }] },
  ],
};

const plain: DriverComponent = { name: "db", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "cfn-deploy", template: "db.json" }] }] };

describe("releaseRunComponents", () => {
  test("a release-image step gets the image handed to the cut, and the gate and deploy steps stay", () => {
    const result = releaseRunComponents([control, plain], release([handed]), "/nowhere", "v1");
    expect("components" in result).toBe(true);
    if (!("components" in result)) return;
    expect(result.components[0].deploy).toEqual([
      control.deploy[0],
      { phase: "Image", steps: [{ kind: "release-image", uri: IMAGE, digest: handed.digest }] },
      control.deploy[2],
    ]);
    expect(result.components[1]).toBe(plain);
    expect(result.notes).toEqual([{ component: "control", removed: [], image: IMAGE }]);
  });

  test("fly-release's images for the plan's other Machines can wire the same image, and are left as written (#4696)", async () => {
    const withCron: DriverComponent = {
      ...control,
      deploy: [
        control.deploy[1],
        { phase: "Release", steps: [{ kind: "fly-release", plan: "dist/fly.json", image: "@Image.uri", images: { controlCron: "@Image.uri" }, digest: "@Image.digest" }] },
      ],
    };
    const result = releaseRunComponents([withCron], release([handed]), "/nowhere");
    if (!("components" in result)) throw new Error(JSON.stringify(result));
    expect(result.components[0].deploy[1]).toEqual(withCron.deploy[1]);
    const { resolveStepInput } = await import("./driver");
    const step = withCron.deploy[1].steps[0] as Record<string, unknown>;
    expect(resolveStepInput({ image: step.image, images: step.images }, { Image: { uri: IMAGE, digest: handed.digest } }, {})).toEqual({ image: IMAGE, images: { controlCron: IMAGE } });
  });

  test("a handed image replaces the build and the publish, so @Publish.uri reads the image", () => {
    const result = releaseRunComponents([api], release([{ ...handed, component: "api" }]), "/nowhere");
    if (!("components" in result)) throw new Error(JSON.stringify(result));
    expect(result.components[0].deploy).toEqual([
      { phase: "Publish", steps: [{ kind: "release-image", uri: IMAGE, digest: handed.digest, replaces: "publish-image" }] },
      api.deploy[2],
    ]);
    expect(result.notes[0].removed).toEqual(["docker-build"]);
  });

  test("an archive the cut built is published from where the cut wrote it, without building", async () => {
    await withTestDir(async (dir) => {
      const built: ReleaseArtifact = { component: "api", kind: "image", path: "out/api.tar", digest: `sha256:${"a".repeat(64)}` };
      const missing = releaseRunComponents([api], release([built]), dir, "v1");
      expect(missing).toEqual({ errors: [expect.stringMatching(/release v1 built out\/api\.tar, which is not here/)] });

      mkdirSync(join(dir, "out"));
      writeFileSync(join(dir, "out", "api.tar"), "tar");
      const result = releaseRunComponents([api], release([built]), dir, "v1");
      if (!("components" in result)) throw new Error(JSON.stringify(result));
      expect(result.components[0].deploy).toEqual([api.deploy[1], api.deploy[2]]);
    });
  });

  test("refuses a component whose artifact or image the release did not record, naming each", () => {
    const result = releaseRunComponents([control, api, plain], release([]), "/nowhere", "v1");
    expect(result).toEqual({
      errors: [
        expect.stringMatching(/"control" runs the image release v1 recorded for it .* recorded none; .*--image control=/),
        expect.stringMatching(/"api" builds an artifact, and release v1 recorded none for it, so the run would build it again/),
      ],
    });
  });

  test("refuses a step that reads the output of a build step the run takes out", () => {
    const reads: DriverComponent = {
      name: "api",
      dependsOn: [],
      deploy: [
        { phase: "Build", steps: [{ kind: "docker-build", context: "api", into: "out/api.tar" }] },
        { phase: "Apply", steps: [{ kind: "ecs-update-service", image: "@Build.imageRef" }] },
      ],
    };
    expect(releaseRunComponents([reads], release([{ ...handed, component: "api" }]), "/nowhere")).toEqual({
      errors: [expect.stringMatching(/reads "@Build\.imageRef", an output of a build step a run under a release does not run/)],
    });
  });
});

describe("release-image", () => {
  const ctx = { env: "prod", component: "control" };
  test("hands on the image a run under a release filled in", async () => {
    expect(await releaseImageCapability.run(ctx, { uri: IMAGE, digest: handed.digest })).toEqual({ uri: IMAGE, digest: handed.digest });
  });
  test("fails a run that names no release", async () => {
    await expect(releaseImageCapability.run(ctx, {})).rejects.toThrow(/--release <label>/);
  });
});
