#!/usr/bin/env bun
/**
 * CLI entry point for Kubernetes lexicon generation.
 */

import { dirname } from "path";
import { fileURLToPath } from "url";
import { generate, writeGeneratedFiles } from "./generate";
import { K8S_SCHEMA_VERSION } from "../spec/fetch";

const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

async function main() {
  const verbose = process.argv.includes("--verbose") || process.argv.includes("-v");
  const force = process.argv.includes("--force") || process.argv.includes("-f");

  // Parse --schema-version <ref>
  const versionIdx = process.argv.indexOf("--schema-version");
  const schemaVersion = versionIdx !== -1 ? process.argv[versionIdx + 1] : undefined;

  console.error(`Generating Kubernetes lexicon (schema: ${schemaVersion ?? K8S_SCHEMA_VERSION})...`);

  const result = await generate({ verbose, force, schemaVersion });
  writeGeneratedFiles(result, pkgDir);

  console.error(
    `Generated ${result.resources} resources, ${result.properties} property types, ${result.enums} enums`,
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
