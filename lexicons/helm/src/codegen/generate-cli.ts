#!/usr/bin/env bun
/**
 * CLI entry point for Helm lexicon generation.
 */

import { dirname } from "path";
import { fileURLToPath } from "url";
import { generate, writeGeneratedFiles } from "./generate";

const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

async function main() {
  const verbose = process.argv.includes("--verbose") || process.argv.includes("-v");

  console.error("Generating Helm lexicon (static types)...");

  const result = await generate({ verbose });
  writeGeneratedFiles(result, pkgDir);

  console.error(
    `Generated ${result.resources} resources, ${result.properties} property types`,
  );
}

main().catch((err) => {
  console.error("Generation failed:", err);
  process.exit(1);
});
