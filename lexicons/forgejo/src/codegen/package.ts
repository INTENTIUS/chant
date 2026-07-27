/**
 * Forgejo lexicon packaging — delegates to core packagePipeline.
 *
 * Bundles what forgejo actually ships (its post-synth checks, its skill,
 * an empty resource catalog) into dist/manifest.json + dist/meta.json so
 * the lexicon has a real, versioned package manifest like every other
 * lexicon — see ./generate.ts for why the catalog itself is empty.
 */

import { readFileSync } from "fs";
import { forgejoPlugin } from "../plugin";
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
 * Package the Forgejo lexicon into a distributable BundleSpec.
 */
export async function packageLexicon(opts: PackageOptions = {}): Promise<PackageResult> {
  const pkgJson = JSON.parse(readFileSync(join(pkgDir, "..", "package.json"), "utf-8"));

  return packagePipeline(
    {
      generate: (genOpts) => generate({ verbose: genOpts.verbose, force: genOpts.force }),

      buildManifest: (_genResult) => {
        return {
          name: "forgejo",
          version: pkgJson.version ?? "0.0.1",
          chantVersion: ">=0.1.0",
          namespace: "Forgejo",
          intrinsics: [],
          pseudoParameters: {},
        };
      },

      srcDir: pkgDir,

      collectSkills: () => {
        const skillDefs = forgejoPlugin.skills?.() ?? [];
        return collectSkills(skillDefs);
      },

      version: pkgJson.version ?? "0.0.1",
    },
    opts,
  );
}
