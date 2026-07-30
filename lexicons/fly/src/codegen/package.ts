import { packagePipeline, collectSkills } from "@intentius/chant/codegen/package";
import { generate } from "./generate";
import { flyPlugin } from "../plugin";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

/**
 * Package the fly lexicon for distribution.
 */
export async function packageLexicon(options?: { verbose?: boolean; force?: boolean }) {
  // This file is src/codegen/package.ts — rules and skills are collected
  // relative to src/, so srcDir must be the parent of this directory.
  // Pointing it at src/codegen made collectRules glob a directory that does
  // not exist, and the bundle shipped zero rules alongside zero skills.
  const srcDir = dirname(dirname(fileURLToPath(import.meta.url)));
  const pkgJson = JSON.parse(readFileSync(join(srcDir, "..", "package.json"), "utf-8"));

  const { spec, stats } = await packagePipeline({
    generate: (opts) => generate({ verbose: opts?.verbose, force: opts?.force }),
    // chant #1067 — chantVersion/namespace/version were never populated here
    // (a hardcoded "0.0.1", never the real package version), so
    // `dist/manifest.json` shipped without a chantVersion at all. Matches
    // the shape every other lexicon's codegen/package.ts already uses.
    buildManifest: (_genResult) => ({
      name: "fly",
      version: pkgJson.version ?? "0.0.0",
      chantVersion: ">=0.1.0",
      namespace: "Fly",
    }),
    srcDir,
    collectSkills: () => collectSkills(flyPlugin.skills?.() ?? []),
  });

  // Both callers (the plugin's package() and package-cli) print their own
  // summary — don't double-report here.
  return { spec, stats };
}
