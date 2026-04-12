/**
 * Full roundtrip helper script.
 * Reads a K8s manifest, parses it, generates TS, dynamically imports it,
 * serializes back to YAML, and verifies structural equivalence.
 *
 * Three-phase verification:
 *   Phase 1 (always): parse + generate, verify files and resources produced
 *   Phase 2 (if generated index is populated): dynamic import, verify exports
 *   Phase 3 (if --serialize): serialize back to YAML, compare resource-level structure
 *
 * Exit 0 on success, 1 on failure.
 *
 * Usage: npx tsx scripts/full-roundtrip-helper.ts [--skip-serialize] <manifest-file>
 */
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join, dirname } from "path";
import { K8sParser } from "../src/import/parser";
import { K8sGenerator } from "../src/import/generator";
import { isDeclarable } from "@intentius/chant/declarable";
import type { Declarable } from "@intentius/chant/declarable";

if (import.meta.main) {
  const args = process.argv.slice(2);
  let skipSerialize = false;
  let file: string | undefined;

  for (const arg of args) {
    if (arg === "--skip-serialize") {
      skipSerialize = true;
    } else if (!arg.startsWith("-")) {
      file = arg;
    }
  }

  if (!file) {
    console.error("Usage: npx tsx full-roundtrip-helper.ts [--skip-serialize] <manifest-file>");
    process.exit(1);
  }

  const scriptDir = dirname(new URL(import.meta.url).pathname);
  let dir: string | undefined;
  let exitCode = 0;

  try {
    const content = readFileSync(file, "utf-8");
    const parser = new K8sParser();
    const generator = new K8sGenerator();

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
        const indexContent = readFileSync(indexPath, "utf-8");
        const hasGeneratedIndex = !indexContent.match(/^\s*export\s*\{\s*\}\s*;?\s*$/m) ||
          indexContent.includes("createResource") ||
          indexContent.includes("createProperty");

        // Write generated files to a temp dir inside the monorepo so workspace packages resolve
        dir = mkdtempSync(join(scriptDir, "../.roundtrip-tmp-"));
        const srcDir = join(dir, "src");
        mkdirSync(srcDir);

        for (const f of files) {
          writeFileSync(join(srcDir, f.path), f.content);
        }

        if (hasGeneratedIndex) {
          // Phase 2: dynamic import — verify constructors exist
          const mainPath = join(srcDir, "main.ts");
          const mod = await import(mainPath);

          const exportNames = Object.keys(mod);
          if (exportNames.length === 0) {
            console.error(`No exports from generated module for ${file}`);
            exitCode = 1;
          } else if (!skipSerialize) {
            // Phase 3: serialize back to YAML and compare structure
            exitCode = await verifySerialize(mod, ir, file);
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

/**
 * Phase 3: Collect Declarable exports, serialize to YAML, re-parse, and
 * compare resource-level structure (count + kinds match).
 */
async function verifySerialize(
  mod: Record<string, unknown>,
  originalIR: { resources: Array<{ kind: string }> },
  file: string,
): Promise<number> {
  // Lazily import serializer to avoid pulling it in when not needed
  const { k8sSerializer } = await import("../src/serializer");

  // Collect Declarable exports into a Map
  const entities = new Map<string, Declarable>();
  for (const [name, value] of Object.entries(mod)) {
    if (isDeclarable(value)) {
      entities.set(name, value);
    }
  }

  if (entities.size === 0) {
    if (process.env.VERBOSE) {
      console.error(`No Declarable exports found for ${file}`);
    }
    return 1;
  }

  // Serialize back to YAML
  const yamlOutput = k8sSerializer.serialize(entities);

  if (!yamlOutput || yamlOutput.trim().length === 0) {
    if (process.env.VERBOSE) {
      console.error(`Empty YAML output for ${file}`);
    }
    return 1;
  }

  // Verify each document has apiVersion + kind
  const docs = yamlOutput.split(/^---$/m).filter((d) => d.trim().length > 0);
  for (const doc of docs) {
    if (!doc.includes("apiVersion:") || !doc.includes("kind:")) {
      if (process.env.VERBOSE) {
        console.error(`Serialized YAML missing apiVersion/kind for ${file}`);
      }
      return 1;
    }
  }

  // Re-parse the serialized YAML and compare structure
  const parser = new K8sParser();
  const roundtrippedIR = parser.parse(yamlOutput);

  const originalKinds = originalIR.resources.map((r) => r.kind).sort();
  const roundtrippedKinds = roundtrippedIR.resources.map((r) => r.kind).sort();

  if (originalKinds.length !== roundtrippedKinds.length) {
    if (process.env.VERBOSE) {
      console.error(
        `Resource count mismatch for ${file}: original=${originalKinds.length}, roundtripped=${roundtrippedKinds.length}`,
      );
    }
    return 1;
  }

  for (let i = 0; i < originalKinds.length; i++) {
    if (originalKinds[i] !== roundtrippedKinds[i]) {
      if (process.env.VERBOSE) {
        console.error(
          `Kind mismatch for ${file}: original=${originalKinds[i]}, roundtripped=${roundtrippedKinds[i]}`,
        );
      }
      return 1;
    }
  }

  if (process.env.VERBOSE) {
    console.log(
      `OK (full roundtrip): ${entities.size} declarable(s), ${docs.length} YAML doc(s), ${roundtrippedKinds.length} resource(s) match`,
    );
  }

  // Write serialized YAML to stdout if EMIT_YAML is set (used by k3d-validate)
  if (process.env.EMIT_YAML) {
    process.stdout.write(yamlOutput);
  }

  return 0;
}
