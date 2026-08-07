import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { readArray, readString } from "../../entity-props";
import { WORKLOAD, entitiesOfType, imageTag } from "./helpers";

/** A digest pin — `@sha256:…` — is reproducible regardless of tag. */
const DIGEST = /@sha\d+:[0-9a-f]+$/i;

/**
 * CPL040: an image reference that is not pinned.
 *
 * `:latest`, or no tag at all (which *means* `:latest`), makes what runs a
 * function of when the workload last happened to pull. On a serverless
 * workload that scales to zero and cold-starts, that can be several times a
 * day, so two replicas of "the same" deploy can be different builds.
 */
export const pinnedImageCheck: PostSynthCheck = {
  id: "CPL040",
  description: "Container images should be pinned to a specific tag or digest",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [name, entity] of entitiesOfType(ctx.entities, WORKLOAD)) {
      for (const container of readArray(entity, "spec", "containers")) {
        const containerName = readString(container, "name") ?? "?";
        const image = readString(container, "image");
        if (!image || DIGEST.test(image)) continue;

        const tag = imageTag(image);
        if (tag && tag !== "latest") continue;

        diagnostics.push({
          checkId: "CPL040",
          severity: "warning",
          message:
            `Workload "${name}" container "${containerName}" uses image "${image}", which is ` +
            (tag === "latest" ? `tagged \`latest\`` : `untagged (implicitly \`latest\`)`) +
            `. Pin a version or a digest — a scale-from-zero cold start re-pulls, so what runs can change ` +
            `without a deploy.`,
          entity: name,
          lexicon: "cpln",
        });
      }
    }

    return diagnostics;
  },
};
