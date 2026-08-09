import { packagePipeline, collectSkills } from "@intentius/chant/codegen/package";
import type { PackagePipelineConfig } from "@intentius/chant/codegen/package";
import { k3sPlugin } from "../plugin";
import { generate } from "./generate";
import { dirname } from "path";
import { fileURLToPath } from "url";

/**
 * Package the k3s lexicon for distribution.
 */
export async function packageLexicon(options?: { verbose?: boolean; force?: boolean }) {
  const srcDir = dirname(fileURLToPath(import.meta.url));

  const { spec, stats } = await packagePipeline({
    generate: (opts) => generate({ verbose: opts?.verbose, force: opts?.force }),
    buildManifest: () => ({
      name: "k3s",
      version: "0.0.1",
      chantVersion: ">=0.1.0",
      namespace: "K3s",
    }),
    srcDir,
    collectSkills: () => collectSkills(k3sPlugin.skills?.() ?? []),
  });

  console.error(`Packaged ${stats.resources} resources, ${stats.ruleCount} rules`);
  return { spec, stats };
}
