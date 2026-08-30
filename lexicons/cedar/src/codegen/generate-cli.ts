#!/usr/bin/env tsx
/**
 * Entry point for `npm run generate` in lexicon-cedar.
 *
 * Generation reads the project's `.cedarschema` when there is one and the
 * schema bundled at `src/spec/default-schema.cedarschema` when there is not
 * (#1650), so this always has something to generate from and no longer needs
 * the scaffold's swallow-and-continue guard.
 *
 * This script is the package's own build step, so the project root is the
 * package root and the output is `src/generated/` (the monorepo case of
 * `resolveGeneratedDir`). A consumer runs `chant generate --lexicon cedar`
 * instead, which writes into the consumer's tree (#1696).
 */
import { generate, packageDir, resolveGeneratedDir, writeGeneratedFiles } from "./generate";

const pkgDir = packageDir();

const result = await generate({ verbose: true, projectRoot: pkgDir });
writeGeneratedFiles(result, resolveGeneratedDir({ projectRoot: pkgDir }));
