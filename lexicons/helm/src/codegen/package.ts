/**
 * Helm lexicon packaging — delegates to core packagePipeline
 * with Helm-specific manifest building and skill collection.
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { helmPlugin } from "../plugin";
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
 * Package the Helm lexicon into a distributable BundleSpec.
 */
export async function packageLexicon(opts: PackageOptions = {}): Promise<PackageResult> {
  const pkgJson = JSON.parse(readFileSync(join(pkgDir, "..", "package.json"), "utf-8"));

  return packagePipeline(
    {
      generate: (genOpts) => generate({ verbose: genOpts.verbose, force: genOpts.force }),

      buildManifest: (_genResult) => {
        return {
          name: "helm",
          version: pkgJson.version ?? "0.0.0",
          chantVersion: ">=0.1.0",
          namespace: "Helm",
          // Derived from the plugin's own registration (chant #1067) — this
          // used to be a hand-maintained array of 7 entries, independent of
          // ../plugin.ts's real registration (which has grown to 22) and
          // never updated to match. That drift is exactly why an
          // independent second source of truth for the same data is
          // dangerous: the generated intrinsics doc page (chant #1062) was
          // silently reporting "7 intrinsic functions" for a lexicon that
          // ships 22.
          intrinsics: helmPlugin.intrinsics?.() ?? [],
          pseudoParameters: {},
        };
      },

      srcDir: pkgDir,

      collectSkills: () => {
        const skillDefs = helmPlugin.skills?.() ?? [];
        return collectSkills(skillDefs);
      },

      version: pkgJson.version ?? "0.0.0",
    },
    opts,
  );
}
