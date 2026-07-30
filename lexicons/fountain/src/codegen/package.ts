import { packagePipeline, collectSkills } from "@intentius/chant/codegen/package";
import { generate } from "./generate";
import { fountainPlugin } from "../plugin";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";

/**
 * Package the fountain lexicon for distribution.
 */
export async function packageLexicon(options?: { verbose?: boolean; force?: boolean }) {
  // This file is src/codegen/package.ts — rules and skills are collected
  // relative to src/, so srcDir must be the parent of this directory.
  const srcDir = dirname(dirname(fileURLToPath(import.meta.url)));
  const pkgJson = JSON.parse(readFileSync(join(srcDir, "..", "package.json"), "utf-8"));

  const { spec, stats } = await packagePipeline({
    generate: (opts) => generate({ verbose: opts?.verbose, force: opts?.force }),
    buildManifest: (_genResult) => ({
      name: "fountain",
      version: pkgJson.version ?? "0.0.0",
      chantVersion: ">=0.1.0",
      namespace: "Fountain",
    }),
    srcDir,
    collectSkills: () => collectSkills(fountainPlugin.skills?.() ?? []),
  });

  // Both callers (the plugin's package() and package-cli) print their own
  // summary — don't double-report here.
  return { spec, stats };
}
