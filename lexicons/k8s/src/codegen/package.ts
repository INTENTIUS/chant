/**
 * Kubernetes lexicon packaging — delegates to core packagePipeline
 * with K8s-specific manifest building and skill collection.
 */

import { createRequire } from "module";
import { readFileSync } from "fs";
const require = createRequire(import.meta.url);
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

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Package the Kubernetes lexicon into a distributable BundleSpec.
 */
export async function packageLexicon(opts: PackageOptions = {}): Promise<PackageResult> {
  const pkgJson = JSON.parse(readFileSync(join(pkgDir, "..", "package.json"), "utf-8"));

  return packagePipeline(
    {
      generate: (genOpts) => generate({ verbose: genOpts.verbose, force: genOpts.force }),

      buildManifest: (_genResult) => {
        return {
          name: "k8s",
          version: pkgJson.version ?? "0.0.0",
          chantVersion: ">=0.1.0",
          namespace: "K8s",
          intrinsics: [],
          pseudoParameters: {},
        };
      },

      srcDir: pkgDir,

      collectSkills: () => {
        const { k8sPlugin } = require("../plugin");
        const skillDefs = k8sPlugin.skills?.() ?? [];
        return collectSkills(skillDefs);
      },

      version: pkgJson.version ?? "0.0.0",
    },
    opts,
  );
}
