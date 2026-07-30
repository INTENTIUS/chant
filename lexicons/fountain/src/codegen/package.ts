import { packagePipeline } from "@intentius/chant/codegen/package";
import type { PackagePipelineConfig } from "@intentius/chant/codegen/package";
import { generate } from "./generate";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";

/**
 * Package the fountain lexicon for distribution.
 */
export async function packageLexicon(options?: { verbose?: boolean; force?: boolean }) {
  const srcDir = dirname(fileURLToPath(import.meta.url));
  const pkgJson = JSON.parse(readFileSync(join(srcDir, "..", "..", "package.json"), "utf-8"));

  const { spec, stats } = await packagePipeline({
    generate: (opts) => generate({ verbose: opts?.verbose, force: opts?.force }),
    buildManifest: (genResult) => ({
      name: "fountain",
      version: pkgJson.version ?? "0.0.0",
      chantVersion: ">=0.1.0",
      namespace: "Fountain",
    }),
    srcDir,
    collectSkills: () => new Map(),
  });

  console.error(`Packaged ${stats.resources} resources, ${stats.ruleCount} rules`);
  return { spec, stats };
}
