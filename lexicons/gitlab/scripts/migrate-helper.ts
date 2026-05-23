#!/usr/bin/env tsx
/**
 * Migration roundtrip helper — invoked once per .github/workflows/*.yml
 * sample by `migrate-samples.sh`. Exits 0 if the migration produces
 * no error-severity diagnostics; exits 1 otherwise.
 *
 * Usage: tsx migrate-helper.ts <path-to-workflow.yml>
 */

import { readFileSync } from "node:fs";
import { transform } from "../src/migrate/from-github/index";

const file = process.argv[2];
if (!file) {
  console.error("Usage: tsx migrate-helper.ts <path-to-workflow.yml>");
  process.exit(2);
}

const verbose = process.env.VERBOSE === "true";

async function main() {
  let content: string;
  try {
    content = readFileSync(file, "utf-8");
  } catch (err) {
    if (verbose) console.error(`  read failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  try {
    const result = await transform(content, { sourceFile: file });
    const errors = result.diagnostics.filter((d) => d.severity === "error");
    if (verbose) {
      console.error(`  ${file}: ${result.diagnostics.length} diagnostics (${errors.length} errors)`);
    }
    process.exit(errors.length === 0 ? 0 : 1);
  } catch (err) {
    if (verbose) console.error(`  transform threw: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

main();
