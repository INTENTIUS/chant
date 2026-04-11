/**
 * GitHub Actions lexicon packaging — delegates to core packagePipeline.
 */

import { readFileSync } from "fs";
import { githubPlugin } from "../plugin";
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
 * Package the GitHub Actions lexicon into a distributable BundleSpec.
 */
export async function packageLexicon(opts: PackageOptions = {}): Promise<PackageResult> {
  const pkgJson = JSON.parse(readFileSync(join(pkgDir, "..", "package.json"), "utf-8"));

  return packagePipeline(
    {
      generate: (genOpts) => generate({ verbose: genOpts.verbose, force: genOpts.force }),

      buildManifest: (_genResult) => {
        const intrinsics: IntrinsicDef[] = [
          {
            name: "expression",
            description: "${{ }} expression wrapper for GitHub Actions contexts",
            outputKey: "expression",
            isTag: false,
          },
        ];

        return {
          name: "github",
          version: pkgJson.version ?? "0.0.0",
          chantVersion: ">=0.1.0",
          namespace: "GitHub",
          intrinsics,
          pseudoParameters: {},
        };
      },

      srcDir: pkgDir,

      collectSkills: () => {        const skillDefs = githubPlugin.skills?.() ?? [];
        return collectSkills(skillDefs);
      },

      version: pkgJson.version ?? "0.0.0",
    },
    opts,
  );
}
