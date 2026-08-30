import { packagePipeline, collectSkills } from "@intentius/chant/codegen/package";
import { generate } from "./generate";
import { renderPlugin } from "../plugin";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

/**
 * Package the render lexicon for distribution.
 */
export async function packageLexicon(options?: { verbose?: boolean; force?: boolean }) {
  // This file is src/codegen/package.ts — rules and skills are collected
  // relative to src/, so srcDir must be the parent of this directory.
  const srcDir = dirname(dirname(fileURLToPath(import.meta.url)));
  const pkgJson = JSON.parse(readFileSync(join(srcDir, "..", "package.json"), "utf-8"));

  const { spec, stats } = await packagePipeline({
    generate: (opts) => generate({ verbose: opts?.verbose, force: opts?.force }),
    buildManifest: (_genResult) => ({
      name: "render",
      version: pkgJson.version ?? "0.0.0",
      chantVersion: ">=0.1.0",
      namespace: "Render",
    }),
    srcDir,
    collectSkills: () => collectSkills(renderPlugin.skills?.() ?? []),
  });

  return { spec, stats };
}
