/**
 * Docker lexicon docs generation.
 *
 * The docker site is hand-authored under docs/src/content/docs/, unlike every
 * other lexicon's generated Starlight site. The rules table is the exception:
 * a hand-maintained one can fall behind the rules in src/lint/ without anything
 * catching it, so it is generated from source here (#1312).
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { writeFileSync } from "fs";
import { generateRulesPage, type DocsConfig } from "@intentius/chant/codegen/docs";

export async function generateDocs(opts?: { verbose?: boolean }): Promise<void> {
  const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

  if (opts?.verbose) {
    console.error("Generating Docker lexicon docs...");
  }

  const config = {
    name: "docker",
    displayName: "Docker",
    description: "Typed constructors for Docker Compose files and Dockerfiles",
    distDir: join(pkgDir, "dist"),
    outDir: join(pkgDir, "docs"),
  } as DocsConfig;

  const rules = generateRulesPage(config, join(pkgDir, "src"));
  if (rules) {
    const out = join(pkgDir, "docs", "src", "content", "docs", "rules.mdx");
    writeFileSync(out, rules);
    if (opts?.verbose) {
      console.error(`Wrote ${out}`);
    }
  }

  // Every other page is hand-authored in docs/src/content/docs/.
  // Future: auto-generate entity reference pages from lexicon-docker.json
  console.error("Docker docs: rules.mdx generated; prose pages are hand-authored");
}
