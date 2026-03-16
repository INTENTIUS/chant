#!/usr/bin/env bun
/**
 * CLI entry point for Kubernetes lexicon packaging.
 */

import { packageLexicon } from "./codegen/package";
import { writeBundleSpec } from "@intentius/chant/codegen/package";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const pkgDir = dirname(fileURLToPath(import.meta.url));

async function main() {
  const verbose = process.argv.includes("--verbose") || process.argv.includes("-v");
  const force = process.argv.includes("--force") || process.argv.includes("-f");

  const { spec, stats } = await packageLexicon({ verbose, force });

  const distDir = join(pkgDir, "..", "dist");
  writeBundleSpec(spec, distDir);

  console.error(`Packaged ${stats.resources} resources, ${stats.ruleCount} rules, ${stats.skillCount} skills`);
}

main().catch((err) => {
  console.error("Packaging failed:", err);
  process.exit(1);
});
