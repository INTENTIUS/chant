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
          intrinsics: [
            { name: "values", description: "Proxy accessor for {{ .Values.x }} references" },
            { name: "Release", description: "Built-in Release object" },
            { name: "ChartRef", description: "Built-in Chart object" },
            { name: "include", description: "Include a named template" },
            { name: "If", description: "Conditional resource/value" },
            { name: "Range", description: "Range loop" },
            { name: "With", description: "With scope" },
          ],
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
