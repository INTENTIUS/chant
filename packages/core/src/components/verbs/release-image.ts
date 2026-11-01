/**
 * `release-image`: the image a release recorded for this component (#4694).
 *
 * A component whose image is built elsewhere, as by a CI job with a toolchain
 * the deploy machine lacks, declares no build and no publish. The image is
 * handed to the cut by digest (`chant release cut --image
 * <component>=<repository>@sha256:<hex>`), and the step stands where a publish
 * step would, so the steps after it read the image as they would a publish's:
 *
 * ```ts
 * phase("Image", [{ kind: "release-image" }]),
 * phase("Release", [{ kind: "fly-release", plan: "dist/fly.json", image: "@Image.uri", digest: "@Image.digest" }]),
 * ```
 *
 * The step has nothing of its own to give. A run under a release
 * (`chant run --components <c> --env <e> --release <label>`) fills in the
 * image the release recorded (../release-run.ts), and a run of a release
 * that recorded none is refused before anything runs. Outside a release the
 * step fails, so a deploy never runs an image no release named.
 */

import type { Capability } from "../capability";

export interface ReleaseImageInput {
  /** The image, `<repository>@sha256:<hex>`. Filled in by a run under a release; not written by the component. */
  uri?: string;
  /** The image's digest. Filled in with `uri`. */
  digest?: string;
}

export interface ReleaseImageOutput {
  /** The image reference a deploy step runs. */
  uri: string;
  digest: string;
}

/** The kind of the step. */
export const RELEASE_IMAGE_KIND = "release-image";

export const releaseImageCapability: Capability<ReleaseImageInput, ReleaseImageOutput> = {
  kind: RELEASE_IMAGE_KIND,
  rollbackPolicy: "none-by-design",
  async run(ctx, input) {
    if (typeof input?.uri !== "string" || typeof input.digest !== "string") {
      throw new Error(
        `release-image: "${ctx.component}" deploys the image a release recorded for it, and this run names no release. ` +
          `Run it under one: chant run --components ${ctx.component} --env ${ctx.env} --release <label>`,
      );
    }
    return { uri: input.uri, digest: input.digest };
  },
};
