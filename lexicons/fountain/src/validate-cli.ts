#!/usr/bin/env tsx
import { validate } from "./validate";
import { printValidationResult } from "@intentius/chant/codegen/validate";

// `validate` takes an optional { basePath }; defaults to the lexicon root.
// printValidationResult throws on failure — the catch turns that into a
// nonzero exit so `npm run validate` (and prepack) actually gate on it.
try {
  printValidationResult(await validate());
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
