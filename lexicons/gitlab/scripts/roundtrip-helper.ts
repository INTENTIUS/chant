/**
 * Helper script for import-gitlab-samples.sh
 * Reads a .gitlab-ci.yml file, parses it, generates TS output,
 * writes it to a temp directory, and optionally imports it to verify
 * the generated code actually works (classes exist, constructors run, etc.).
 *
 * Two-phase verification:
 *   Phase 1 (always): parse + generate, verify files and resources produced
 *   Phase 2 (if generated index is populated): dynamic import, verify exports
 *
 * Exit 0 on success, 1 on failure.
 *
 * Usage: bun run scripts/roundtrip-helper.ts <pipeline-file>
 */
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join, dirname } from "path";
import { GitLabParser } from "../src/import/parser";
import { GitLabGenerator } from "../src/import/generator";

if (import.meta.main) {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: bun run roundtrip-helper.ts <pipeline-file>");
    process.exit(1);
  }

  const scriptDir = dirname(new URL(import.meta.url).pathname);
  let dir: string | undefined;
  let exitCode = 0;

  try {
    const content = readFileSync(file, "utf-8");
    const parser = new GitLabParser();
    const generator = new GitLabGenerator();

    const ir = parser.parse(content);

    if (ir.resources.length === 0) {
      if (process.env.VERBOSE) {
        console.error(`No resources parsed from ${file}`);
      }
      exitCode = 1;
    } else {
      const files = generator.generate(ir);

      if (files.length === 0) {
        console.error(`No files generated for ${file}`);
        exitCode = 1;
      } else {
        // Check if generated index is populated (not just `export {};`)
        const indexPath = join(scriptDir, "../src/generated/index.ts");
        let hasGeneratedIndex = false;
        try {
          const indexContent = readFileSync(indexPath, "utf-8");
          hasGeneratedIndex = !indexContent.match(/^\s*export\s*\{\s*\}\s*;?\s*$/m) ||
            indexContent.includes("createResource") ||
            indexContent.includes("createProperty");
        } catch {
          // Generated files don't exist — phase 1 only
        }

        // Write generated files to a temp dir inside the monorepo so workspace packages resolve
        dir = mkdtempSync(join(scriptDir, "../.roundtrip-tmp-"));
        const srcDir = join(dir, "src");
        mkdirSync(srcDir);

        for (const f of files) {
          writeFileSync(join(srcDir, f.path), f.content);
        }

        if (hasGeneratedIndex) {
          // Phase 2: full roundtrip — dynamic import verifies constructors exist
          const mainPath = join(srcDir, "main.ts");
          const mod = await import(mainPath);

          const exportNames = Object.keys(mod);
          if (exportNames.length === 0) {
            console.error(`No exports from generated module for ${file}`);
            exitCode = 1;
          } else if (process.env.VERBOSE) {
            console.log(`OK: ${files.length} file(s) generated, ${exportNames.length} export(s) resolved`);
          }
        } else {
          // Phase 1 only: parse + generate succeeded
          if (process.env.VERBOSE) {
            console.log(`OK (parse-only): ${files.length} file(s) generated, ${ir.resources.length} resource(s) parsed`);
          }
        }
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
