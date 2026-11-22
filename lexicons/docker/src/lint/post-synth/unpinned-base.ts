/**
 * DKRD021: FROM names a base by tag, not by digest
 *
 * A base named by tag (`FROM node:22`) is whatever the registry serves
 * under that tag on the day of the build. Pinned by digest
 * (`FROM node:22@sha256:<digest>`) it is the same image every time. A FROM
 * that names an earlier stage, `scratch`, or an ARG declared before the
 * first FROM with a pinned default passes.
 *
 * Opt-in: the lexicon's `recommended` preset leaves it out, and a project
 * turns it on with `lint.presets: { docker: "all" }` or `lint.rules:
 * { DKRD021: "warning" }`. chant's `supply-chain` workspace check runs the
 * same rule on the Dockerfiles `release.images` names.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { eachDockerfile, stageLabel } from "./docker-helpers";

/** A reference pinned by digest: `<name>[:tag]@sha256:<64 hex>`. */
const DIGEST_PINNED = /@sha256:[0-9a-f]{64}$/;

/** `$NAME`, `${NAME}` and `${NAME:-default}` replaced from `values`; null when one has no value. */
function substitute(image: string, values: ReadonlyMap<string, string>): string | null {
  let missing = false;
  const out = image.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?-([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_all, braced: string | undefined, fallback: string | undefined, bare: string | undefined) => {
    const v = values.get((braced ?? bare)!) ?? fallback;
    if (v === undefined || v === "") missing = true;
    return v ?? "";
  });
  return missing ? null : out;
}

export const dkrd021: PostSynthCheck = {
  id: "DKRD021",
  description: "FROM names a base image by tag, not pinned by digest",
  auditOptIn: true,

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const { fileName, parsed } of eachDockerfile(ctx.outputs)) {
      const values = new Map<string, string>();
      for (const arg of parsed.globalArgs) {
        for (const decl of arg.value.split(/\s+/).filter(Boolean)) {
          const eq = decl.indexOf("=");
          if (eq > 0) values.set(decl.slice(0, eq), decl.slice(eq + 1).replace(/^["']|["']$/g, ""));
        }
      }
      const earlier = new Set<string>();
      for (const stage of parsed.stages) {
        const image = stage.from;
        const resolved = image.includes("$") ? substitute(image, values) : image;
        const pinned =
          image === "" ||
          image.toLowerCase() === "scratch" ||
          earlier.has(image.toLowerCase()) ||
          (resolved !== null && (resolved.toLowerCase() === "scratch" || earlier.has(resolved.toLowerCase()) || DIGEST_PINNED.test(resolved)));
        if (stage.as) earlier.add(stage.as.toLowerCase());
        if (pinned) continue;
        diagnostics.push({
          checkId: "DKRD021",
          severity: "warning",
          message:
            resolved === null
              ? `${fileName} ${stageLabel(stage)}: FROM ${image} names a build argument with no default before the first FROM, so nothing in the file pins the base. Give the ARG a default pinned by digest.`
              : `${fileName} ${stageLabel(stage)}: FROM ${image}${resolved !== image ? ` (${resolved})` : ""} names the base by tag, so a later build can start from a different image. Pin it as name:tag@sha256:<digest>.`,
          lexicon: "docker",
        });
      }
    }

    return diagnostics;
  },
};
