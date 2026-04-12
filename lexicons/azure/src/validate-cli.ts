#!/usr/bin/env tsx
/**
 * Thin entry point for `npm run validate` in lexicon-azure.
 */
import { validate } from "./validate";

const result = await validate();

for (const check of result.checks) {
  const status = check.ok ? "OK" : "FAIL";
  const msg = check.error ? ` — ${check.error}` : "";
  console.error(`  [${status}] ${check.name}${msg}`);
}

if (!result.success) {
  console.error("Validation failed");
  process.exit(1);
}
console.error("All validation checks passed.");
