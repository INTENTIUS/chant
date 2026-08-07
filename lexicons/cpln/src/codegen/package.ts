/**
 * Package the cpln lexicon into the distributable bundle under `dist/`.
 */

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { packagePipeline, collectSkills } from "@intentius/chant/codegen/package";
import { generate } from "./generate";
import { cplnPlugin } from "../plugin";

export async function packageLexicon(options?: { verbose?: boolean; force?: boolean }) {
  // This file is `src/codegen/package.ts`; rules and skills are collected
  // relative to `src/`, so srcDir is the parent of this directory. Pointing it
  // at `src/codegen` globs a directory that does not exist and silently ships
  // a bundle with zero rules and zero skills.
  const srcDir = dirname(dirname(fileURLToPath(import.meta.url)));
  const pkgJson = JSON.parse(readFileSync(join(srcDir, "..", "package.json"), "utf-8"));

  const { spec, stats } = await packagePipeline({
    generate: (opts) => generate({ verbose: opts?.verbose, force: opts?.force }),
    buildManifest: () => ({
      name: "cpln",
      version: pkgJson.version ?? "0.0.0",
      chantVersion: ">=0.1.0",
      namespace: "Cpln",
    }),
    srcDir,
    collectSkills: () => collectSkills(cplnPlugin.skills?.() ?? []),
  });

  // Both callers (the plugin's `package()` and `package-cli`) print their own
  // summary — don't double-report here.
  return { spec, stats };
}
