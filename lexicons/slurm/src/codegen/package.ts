/**
 * Slurm lexicon packaging — delegates to core packagePipeline.
 */

import { readFileSync } from "fs";
import { slurmPlugin } from "../plugin";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  packagePipeline,
  collectSkills,
  type PackageOptions,
  type PackageResult,
} from "@intentius/chant/codegen/package";
import { generate } from "./generate";

export type { PackageOptions, PackageResult };

// package.ts is at src/codegen/package.ts — 2 dirname calls reach src/
// then join(pkgDir, "..") is the package root where package.json lives
const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Package the Slurm lexicon into a distributable BundleSpec.
 */
export async function packageLexicon(opts: PackageOptions = {}): Promise<PackageResult> {
  const pkgJson = JSON.parse(readFileSync(join(pkgDir, "..", "package.json"), "utf-8"));

  return packagePipeline(
    {
      generate: (genOpts) => generate({ verbose: genOpts.verbose, force: genOpts.force }),

      buildManifest: (_genResult) => {
        return {
          name: "slurm",
          version: pkgJson.version ?? "0.0.1",
          chantVersion: ">=0.1.0",
          namespace: "Slurm",
          intrinsics: [],
          pseudoParameters: {},
        };
      },

      srcDir: pkgDir,

      collectSkills: () => {        const skillDefs = slurmPlugin.skills?.() ?? [];
        return collectSkills(skillDefs);
      },

      version: pkgJson.version ?? "0.0.1",
    },
    opts,
  );
}
