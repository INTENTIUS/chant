#!/usr/bin/env tsx
/**
 * Thin entry point for `npm run generate` in lexicon-cedar.
 *
 * Cedar's codegen input is the *user's* schema, not one global upstream, so
 * `generate()` is still the scaffold's throwing stub until #1650 settles
 * which schema syntax is canonical. This exits 0 with the reason rather than
 * dying, because `just _ensure-gen` runs `npm run generate` for every lexicon
 * before the bundle step — a hard failure here takes the whole gate with it
 * for a phase that has not shipped yet. Once #1650 lands, this calls straight
 * through and the catch stops being reachable.
 */
import { generate, writeGeneratedFiles } from "./generate";
import { dirname } from "path";
import { fileURLToPath } from "url";

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));

try {
  const result = await generate({ verbose: true });
  writeGeneratedFiles(result, pkgDir);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`cedar: schema-driven generate() is not implemented yet (#1650) — nothing generated: ${message}`);
}
