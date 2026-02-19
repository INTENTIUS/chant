/**
 * Helper script for import-aws-samples.sh
 * Reads a CF/SAM template file, parses it, and generates TS output.
 * Exit 0 on success, 1 on failure.
 *
 * Usage: bun run scripts/roundtrip-helper.ts <template-file>
 */
import { readFileSync } from "fs";
import { CFParser } from "../src/import/parser";
import { CFGenerator } from "../src/import/generator";

if (import.meta.main) {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: bun run roundtrip-helper.ts <template-file>");
    process.exit(1);
  }

  try {
    const content = readFileSync(file, "utf-8");
    const parser = new CFParser();
    const generator = new CFGenerator();

    const ir = parser.parse(content);
    const files = generator.generate(ir);

    if (files.length === 0) {
      console.error(`No files generated for ${file}`);
      process.exit(1);
    }

    if (process.env.VERBOSE) {
      console.log(`OK: ${files.length} file(s) generated`);
    }
    process.exit(0);
  } catch (err) {
    if (process.env.VERBOSE) {
      console.error(`FAIL: ${(err as Error).message}`);
    }
    process.exit(1);
  }
}
