import { packagePipeline, collectSkills } from "@intentius/chant/codegen/package";
import { generate } from "./generate";
import { prowSkills } from "../skills";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { moduleSourceDir } from "@intentius/chant/module-source";

/**
 * Package the prow lexicon for distribution.
 */
export async function packageLexicon(options?: { verbose?: boolean; force?: boolean }) {
  // This file is src/codegen/package.ts, and rules are collected relative to
  // src/, so srcDir is the parent of this directory.
  const srcDir = dirname(moduleSourceDir(import.meta.url));
  const pkgJson = JSON.parse(readFileSync(join(srcDir, "..", "package.json"), "utf-8")) as { version?: string };

  const { spec, stats } = await packagePipeline({
    generate: (opts) => generate({ verbose: opts?.verbose ?? options?.verbose, force: opts?.force ?? options?.force }),
    buildManifest: () => ({
      name: "prow",
      version: pkgJson.version ?? "0.0.0",
      chantVersion: ">=0.1.0",
      namespace: "Prow",
    }),
    srcDir,
    collectSkills: () => collectSkills(prowSkills),
  });

  return { spec, stats };
}
