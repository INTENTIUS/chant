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

      // Create barrel file
      writeFileSync(join(srcDir, "_.ts"), [
        `export * from "@intentius/chant-lexicon-aws";`,
        `import * as core from "@intentius/chant";`,
        `export const $ = core.barrel(import.meta.dir);`,
      ].join("\n"));

      // Rewrite imports to use barrel and write each generated file
      for (const f of files) {
        let code = f.content;

        // Extract symbols from the import statement
        const importMatch = code.match(/import\s*\{([^}]+)\}\s*from\s*"@intentius\/chant-lexicon-aws";/);
        if (importMatch) {
          const symbols = importMatch[1].split(",").map((s) => s.trim()).filter(Boolean);

          // Replace the import with barrel import
          code = code.replace(
            /import\s*\{[^}]+\}\s*from\s*"@intentius\/chant-lexicon-aws";/,
            `import * as _ from "./_";`,
          );

          // Prefix bare class usages with _.
          for (const sym of symbols) {
            code = code.replace(new RegExp(`\\bnew ${sym}\\(`, "g"), `new _.${sym}(`);
            // Also handle function calls like Sub`, If(, Join(, etc.
            code = code.replace(new RegExp(`(?<!\\.)\\b${sym}\``, "g"), `_.${sym}\``);
            code = code.replace(new RegExp(`(?<!\\.)\\b${sym}\\(`, "g"), `_.${sym}(`);
            // Handle property access like AWS.StackName
            code = code.replace(new RegExp(`(?<!\\.)\\b${sym}\\.`, "g"), `_.${sym}.`);
          }
        }

        writeFileSync(join(srcDir, f.path), code);
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
