#!/usr/bin/env tsx
/**
 * Entry point for `npm run generate` in lexicon-cedar.
 *
 * Generation reads the project's `.cedarschema` when there is one and the
 * schema bundled at `src/spec/default-schema.cedarschema` when there is not
 * (#1650), so this always has something to generate from and no longer needs
 * the scaffold's swallow-and-continue guard.
 */
import { generate, writeGeneratedFiles } from "./generate";
import { dirname } from "path";
import { fileURLToPath } from "url";

// <pkg>/src/codegen/generate-cli.ts → three levels up is the package root.
const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const result = await generate({ verbose: true, projectRoot: pkgDir });
writeGeneratedFiles(result, pkgDir);
