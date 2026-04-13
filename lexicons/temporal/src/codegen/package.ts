/**
 * Temporal lexicon packaging — delegates to core packagePipeline.
 */

import { readFileSync } from "fs";
import { temporalPlugin } from "../plugin";
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
 * Package the Temporal lexicon into a distributable BundleSpec.
 */
export async function packageLexicon(opts: PackageOptions = {}): Promise<PackageResult> {
  const pkgJson = JSON.parse(readFileSync(join(pkgDir, "..", "package.json"), "utf-8"));

  return packagePipeline(
    {
      generate: (genOpts) => generate({ verbose: genOpts.verbose, force: genOpts.force }),

      buildManifest: (_genResult) => {
        return {
          name: "temporal",
          version: pkgJson.version ?? "0.0.1",
          chantVersion: ">=0.1.0",
          namespace: "Temporal",
          intrinsics: [],
          pseudoParameters: {},
        };
      },

      srcDir: pkgDir,

      collectSkills: () => {
        const skillDefs = temporalPlugin.skills?.() ?? [];
        return collectSkills(skillDefs);
      },

      version: pkgJson.version ?? "0.0.1",
    },
    opts,
  );
}
