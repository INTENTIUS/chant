import { packagePipeline } from "@intentius/chant/codegen/package";
import type { PackagePipelineConfig } from "@intentius/chant/codegen/package";
import { generate } from "./generate";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

/**
 * Package the fly lexicon for distribution.
 */
export async function packageLexicon(options?: { verbose?: boolean; force?: boolean }) {
  const srcDir = dirname(fileURLToPath(import.meta.url));
  const pkgJson = JSON.parse(readFileSync(join(srcDir, "..", "..", "package.json"), "utf-8"));

  const { spec, stats } = await packagePipeline({
    generate: (opts) => generate({ verbose: opts?.verbose, force: opts?.force }),
    // chant #1067 — chantVersion/namespace/version were never populated here
    // (a hardcoded "0.0.1", never the real package version), so
    // `dist/manifest.json` shipped without a chantVersion at all. Matches
    // the shape every other lexicon's codegen/package.ts already uses.
    buildManifest: (genResult) => ({
      name: "fly",
      version: pkgJson.version ?? "0.0.0",
      chantVersion: ">=0.1.0",
      namespace: "Fly",
    }),
    srcDir,
    collectSkills: () => new Map(),
  });

  console.error(`Packaged ${stats.resources} resources, ${stats.ruleCount} rules`);
  return { spec, stats };
}
