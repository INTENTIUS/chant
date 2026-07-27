/**
 * Docker lexicon packaging — delegates to core packagePipeline.
 */

import { readFileSync } from "fs";
import { dockerPlugin } from "../plugin";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { IntrinsicDef } from "@intentius/chant/lexicon";
import {
  packagePipeline,
  collectSkills,
  type PackageOptions,
  type PackageResult,
} from "@intentius/chant/codegen/package";
import { generate } from "./generate";

export type { PackageOptions, PackageResult };

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Package the Docker lexicon into a distributable BundleSpec.
 */
export async function packageLexicon(opts: PackageOptions = {}): Promise<PackageResult> {
  const pkgJson = JSON.parse(readFileSync(join(pkgDir, "..", "package.json"), "utf-8"));

  return packagePipeline(
    {
      generate: (genOpts) => generate({ verbose: genOpts.verbose, force: genOpts.force }),

      buildManifest: (_genResult) => {
        // Derived from the plugin's own registration (chant #1067) — this
        // used to be a hand-maintained array independent of ../plugin.ts,
        // free to drift from the real registration without anything
        // noticing.
        const intrinsics: IntrinsicDef[] = dockerPlugin.intrinsics?.() ?? [];

        return {
          name: "docker",
          version: pkgJson.version ?? "0.0.0",
          chantVersion: ">=0.1.0",
          namespace: "Docker",
          intrinsics,
          pseudoParameters: {},
        };
      },

      srcDir: pkgDir,

      collectSkills: () => {        const skillDefs = dockerPlugin.skills?.() ?? [];
        return collectSkills(skillDefs);
      },

      version: pkgJson.version ?? "0.0.0",
    },
    opts,
  );
}
