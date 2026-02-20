/**
 * Helper script for import-aws-samples.sh
 * Reads a CF/SAM template file, parses it, generates TS output,
 * writes it to a temp directory, and imports it to verify the
 * generated code actually works (classes exist, constructors run, etc.).
 *
 * Exit 0 on success, 1 on failure.
 *
 * Usage: bun run scripts/roundtrip-helper.ts <template-file>
 */
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join, dirname } from "path";
import { CFParser } from "../src/import/parser";
import { CFGenerator } from "../src/import/generator";

if (import.meta.main) {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: bun run roundtrip-helper.ts <template-file>");
    process.exit(1);
  }

  const scriptDir = dirname(new URL(import.meta.url).pathname);
  let dir: string | undefined;
  let exitCode = 0;

  try {
    const content = readFileSync(file, "utf-8");
    const parser = new CFParser();
    const generator = new CFGenerator();

    const ir = parser.parse(content);
    const files = generator.generate(ir);

    if (files.length === 0) {
      console.error(`No files generated for ${file}`);
      exitCode = 1;
    } else {
      // Write generated files to a temp dir inside the monorepo so workspace packages resolve
      dir = mkdtempSync(join(scriptDir, "../.roundtrip-tmp-"));
      const srcDir = join(dir, "src");
      mkdirSync(srcDir);

      // Write each generated file as-is (direct imports)
      for (const f of files) {
        writeFileSync(join(srcDir, f.path), f.content);
      }

      // Import the generated main module — this proves the code actually works
      const mainPath = join(srcDir, "main.ts");
      const mod = await import(mainPath);

      // Verify we got at least one export
      const exportNames = Object.keys(mod);
      if (exportNames.length === 0) {
        console.error(`No exports from generated module for ${file}`);
        exitCode = 1;
      } else if (process.env.VERBOSE) {
        console.log(`OK: ${files.length} file(s) generated, ${exportNames.length} export(s) resolved`);
      }
    }
  } catch (err) {
    if (process.env.VERBOSE) {
      console.error(`FAIL: ${(err as Error).message}`);
    }
    exitCode = 1;
  } finally {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  process.exit(exitCode);
}
