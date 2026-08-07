import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { readArray, readString } from "../../entity-props";
import { WORKLOAD, entitiesOfType } from "./helpers";

/**
 * CPL041: registry prefixes Control Plane does not want in a workload spec.
 *
 * Two documented traps. `docker.io/` must never be added to a public image —
 * the exact string `nginx:latest` works and `docker.io/library/nginx:latest`
 * does not. And `<org>.registry.cpln.io/…` is the hostname for `docker login`
 * and `docker push` only; inside a workload spec the org's own images are
 * addressed as `//image/NAME:TAG`.
 */
export const imageReferenceFormCheck: PostSynthCheck = {
  id: "CPL041",
  description: "Image references must not use docker.io/ or the registry hostname form",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [name, entity] of entitiesOfType(ctx.entities, WORKLOAD)) {
      for (const container of readArray(entity, "spec", "containers")) {
        const containerName = readString(container, "name") ?? "?";
        const image = readString(container, "image");
        if (!image) continue;

        if (image.startsWith("docker.io/")) {
          const bare = image.replace(/^docker\.io\/(library\/)?/, "");
          diagnostics.push({
            checkId: "CPL041",
            severity: "error",
            message:
              `Workload "${name}" container "${containerName}" uses image "${image}". Control Plane rejects ` +
              `the docker.io/ prefix on public images — use "${bare}".`,
            entity: name,
            lexicon: "cpln",
          });
          continue;
        }

        const selfHosted = /^([a-z0-9-]+)\.registry\.cpln\.io\/(.+)$/.exec(image);
        if (selfHosted) {
          diagnostics.push({
            checkId: "CPL041",
            severity: "warning",
            message:
              `Workload "${name}" container "${containerName}" uses image "${image}". The ` +
              `<org>.registry.cpln.io hostname is for \`docker login\` and \`docker push\`; in a workload ` +
              `spec, an image in this org is "//image/${selfHosted[2]}". (A cross-org pull does use the ` +
              `hostname form — ignore this if "${selfHosted[1]}" is another org.)`,
            entity: name,
            lexicon: "cpln",
          });
        }
      }
    }

    return diagnostics;
  },
};
