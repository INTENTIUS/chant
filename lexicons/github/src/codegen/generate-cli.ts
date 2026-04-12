#!/usr/bin/env tsx
/**
 * CLI entry point for GitHub Actions lexicon generation.
 */

import { dirname } from "path";
import { fileURLToPath } from "url";
import { generate, writeGeneratedFiles } from "./generate";

const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

async function main() {
  const verbose = process.argv.includes("--verbose") || process.argv.includes("-v");
  const force = process.argv.includes("--force") || process.argv.includes("-f");

  console.error("Generating GitHub Actions lexicon...");

  const result = await generate({ verbose, force });
  writeGeneratedFiles(result, pkgDir);

  console.error(
    `Generated ${result.resources} entities, ${result.properties} property types, ${result.enums} enums`,
  );

  if (result.warnings.length > 0) {
    console.error(`${result.warnings.length} warnings:`);
    for (const w of result.warnings) {
      console.error(`  ${w.file}: ${w.error}`);
    }
  }
}

main().catch((err) => {
  console.error("Generation failed:", err);
  process.exit(1);
});
