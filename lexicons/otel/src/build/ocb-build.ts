/**
 * `ocb-build`, the build verb for a custom collector (#3374): run the
 * OpenTelemetry Collector Builder over the `builder-config.yaml` a
 * `Distribution` writes, and hand the directory it generates on as a `dir`
 * artifact. That directory holds the generated sources and the binary, so a
 * `docker-build` step whose `context` is the directory (with a Dockerfile the
 * component provides) builds the collector image, and the rest of the
 * component's path (SBOM, sign, attest, publish by digest, deploy) is the
 * one any image takes.
 *
 * The output directory is the manifest's `dist.output_path`. ocb's own
 * default is a fresh temporary directory, which a later step could not name,
 * so a manifest without one is refused before ocb runs.
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import { load } from "js-yaml";
import type { Capability } from "@intentius/chant/components/capability";
import { defaultProcessRunner, q, requireTool, type ProcessRunner } from "@intentius/chant/components/verbs/process-runner";

export interface OcbBuildInput {
  /** The builder manifest, e.g. `dist/builder-config.yaml`. */
  config: string;
  /** The builder binary. Default: `ocb`. */
  ocb?: string;
  /** Generate the sources without compiling them (`--skip-compilation`). */
  skipCompilation?: boolean;
}

export interface OcbBuildOutput {
  /** The artifact kind: a directory, for `docker-build`'s `context`. */
  kind: "dir";
  /** The directory ocb wrote, the manifest's `dist.output_path` resolved against the manifest's directory. */
  dir: string;
  /** `sha256:` over the manifest's bytes: the same manifest names the same build. */
  manifestDigest: string;
}

/** The output directory a manifest names, resolved the way ocb resolves it: relative to the working directory ocb runs in. */
export function ocbOutputPath(manifestText: string, cwd: string): string | undefined {
  const doc = load(manifestText) as { dist?: { output_path?: unknown } } | undefined;
  const out = doc?.dist?.output_path;
  if (typeof out !== "string" || out.trim() === "") return undefined;
  return isAbsolute(out) ? out : resolve(cwd, out);
}

export function createOcbBuildCapability(runner: ProcessRunner = defaultProcessRunner()): Capability<OcbBuildInput, OcbBuildOutput> {
  return {
    kind: "ocb-build",
    async run(_ctx, input) {
      const text = readFileSync(input.config, "utf8");
      // ocb resolves output_path against its working directory; run it in the manifest's.
      const cwd = dirname(resolve(input.config));
      const dir = ocbOutputPath(text, cwd);
      if (!dir) {
        throw new Error(
          `ocb-build: ${input.config} sets no dist.output_path, so ocb would write to a temporary directory no later step can name. Set dist.output_path on the Distribution.`,
        );
      }
      const ocb = input.ocb ?? "ocb";
      await requireTool(runner, ocb, "build a custom collector from a Distribution");
      const flags = input.skipCompilation ? " --skip-compilation" : "";
      await runner.run(`${q(ocb)} --config ${q(resolve(input.config))}${flags}`, { cwd });
      const manifestDigest = `sha256:${createHash("sha256").update(text).digest("hex")}`;
      return { kind: "dir", dir, manifestDigest };
    },
  };
}

/** Default `ocb-build` capability, backed by the real process runner. */
export const ocbBuildCapability: Capability<OcbBuildInput, OcbBuildOutput> = createOcbBuildCapability();
