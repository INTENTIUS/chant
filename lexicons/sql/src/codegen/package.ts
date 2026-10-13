/**
 * sql lexicon packaging, delegating to core's packagePipeline.
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { packagePipeline, type PackageOptions, type PackageResult } from "@intentius/chant/codegen/package";
import { generate } from "./generate";

export type { PackageOptions, PackageResult };

// src/codegen/package.ts -> src/
const srcDir = dirname(dirname(fileURLToPath(import.meta.url)));

export async function packageLexicon(opts: PackageOptions = {}): Promise<PackageResult> {
  const pkgJson = JSON.parse(readFileSync(join(srcDir, "..", "package.json"), "utf-8"));
  return packagePipeline(
    {
      generate: (genOpts) => generate({ verbose: genOpts.verbose, force: genOpts.force }),
      buildManifest: () => ({
        name: "sql",
        version: pkgJson.version ?? "0.0.1",
        chantVersion: ">=0.1.0",
        namespace: "SQL",
        intrinsics: [],
        pseudoParameters: {},
      }),
      srcDir,
      // No skills yet; they arrive with chant #3211.
      collectSkills: () => new Map(),
      version: pkgJson.version ?? "0.0.1",
    },
    opts,
  );
}
