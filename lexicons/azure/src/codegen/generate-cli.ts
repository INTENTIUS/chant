#!/usr/bin/env tsx
/**
 * Thin entry point for `npm run generate` in lexicon-azure.
 */
import { generate, writeGeneratedFiles } from "./generate";
import { dirname } from "path";
import { fileURLToPath } from "url";

const result = await generate({ verbose: true });
const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
writeGeneratedFiles(result, pkgDir);
console.error(
  `Generated ${result.resources} resources, ${result.properties} property types, ${result.enums} enums`,
);
