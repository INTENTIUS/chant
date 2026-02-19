import { packagePipeline } from "@intentius/chant/codegen/package";
import type { PackagePipelineConfig } from "@intentius/chant/codegen/package";
import { generate } from "./generate";
import { dirname } from "path";
import { fileURLToPath } from "url";

/**
 * Package the fixture lexicon for distribution.
 */
export async function packageLexicon(options?: { verbose?: boolean; force?: boolean }) {
  const srcDir = dirname(fileURLToPath(import.meta.url));

  const { spec, stats } = await packagePipeline({
    generate: (opts) => generate({ verbose: opts?.verbose, force: opts?.force }),
    buildManifest: (genResult) => ({
      name: "fixture",
      version: "0.0.1",
    }),
    srcDir,
    collectSkills: () => new Map(),
  });

  console.error(`Packaged ${stats.resources} resources, ${stats.ruleCount} rules`);
  return { spec, stats };
}
