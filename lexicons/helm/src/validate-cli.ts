#!/usr/bin/env bun
/**
 * CLI entry point for Helm lexicon validation.
 */

import { validate } from "./validate";
import { printValidationResult } from "@intentius/chant/codegen/validate";

async function main() {
  const result = await validate();
  printValidationResult(result);

  if (!result.success) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Validation failed:", err);
  process.exit(1);
});
