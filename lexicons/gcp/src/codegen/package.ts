/**
 * GCP lexicon packaging — delegates to core packagePipeline
 * with GCP-specific manifest building and skill collection.
 */

import { createRequire } from "module";
import { readFileSync } from "fs";
const require = createRequire(import.meta.url);
import { dirname } from "path";
import { fileURLToPath } from "url";
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
 * Package the GCP lexicon into a distributable BundleSpec.
 */
export async function packageLexicon(opts: PackageOptions = {}): Promise<PackageResult> {
  const pkgJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8"));

  return packagePipeline(
    {
      generate: (genOpts) => generate({ verbose: genOpts.verbose, force: genOpts.force }),

      buildManifest: (_genResult) => {
        const { gcpPlugin } = require("../plugin");

        const pseudoParams: string[] = gcpPlugin.pseudoParameters?.() ?? [];
        const pseudoParameters: Record<string, string> = {};
        for (const p of pseudoParams) {
          const shortName = p.split("::").pop()!;
          pseudoParameters[shortName] = p;
        }

        return {
          name: "gcp",
          version: pkgJson.version ?? "0.0.0",
          chantVersion: ">=0.1.0",
          namespace: "GCP",
          intrinsics: [],
          pseudoParameters,
        };
      },

      srcDir: pkgDir,

      collectSkills: () => {
        const { gcpPlugin } = require("../plugin");
        const skillDefs = gcpPlugin.skills?.() ?? [];
        return collectSkills(skillDefs);
      },

      version: pkgJson.version ?? "0.0.0",
    },
    opts,
  );
}
