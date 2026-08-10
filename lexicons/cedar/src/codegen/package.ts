/**
 * Cedar lexicon packaging — delegates to core's packagePipeline.
 */

import { cedarPlugin } from "../plugin";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  collectSkills,
  packagePipeline,
  type PackageOptions,
  type PackageResult,
} from "@intentius/chant/codegen/package";
import { generate } from "./generate";

export type { PackageOptions, PackageResult };

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Package the Cedar lexicon into a distributable BundleSpec.
 */
export async function packageLexicon(opts: PackageOptions = {}): Promise<PackageResult> {
  const pkgJson = JSON.parse(readFileSync(join(pkgDir, "..", "package.json"), "utf-8")) as {
    version?: string;
  };

  return packagePipeline(
    {
      // Codegen reads this package's own directory as the project root, so
      // bundling produces the default-schema surface no matter where the
      // command is run from (#1650).
      generate: (genOpts) => generate({ ...genOpts, projectRoot: pkgDir }),

      buildManifest: () => ({
        name: "cedar",
        version: pkgJson.version ?? "0.0.0",
        chantVersion: ">=0.1.0",
        namespace: "Cedar",
        intrinsics: [],
        pseudoParameters: {},
      }),

      srcDir: pkgDir,

      collectSkills: () => collectSkills(cedarPlugin.skills?.() ?? []),

      version: pkgJson.version ?? "0.0.0",
    },
    opts,
  );
}
