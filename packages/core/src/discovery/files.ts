import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Recursively find all TypeScript infrastructure files in a directory
 * @param path - The directory path to search
 * @returns Array of file paths to .ts files (excluding test files)
 */
export async function findInfraFiles(path: string): Promise<string[]> {
  const files: string[] = [];
  let sourceRoot: string | null = null;

  async function scanDirectory(dir: string): Promise<void> {
    let entries;

    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      // Skip directories we can't read
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      // Skip node_modules
      if (entry.isDirectory() && entry.name === "node_modules") {
        continue;
      }

      if (entry.isDirectory()) {
        // Child project boundary — a directory with its own barrel file is a
        // separate scope, but only if we've already found the project's own
        // source root (the first barrel directory). The project's own src/
        // with _.ts is the source root, not a child project.
        const barrelPath = join(fullPath, "_.ts");
        if (existsSync(barrelPath)) {
          if (sourceRoot === null) {
            sourceRoot = fullPath;
          } else {
            continue;
          }
        }
        await scanDirectory(fullPath);
      } else if (entry.isFile()) {
        // Include only .ts files, exclude test files
        if (
          entry.name.endsWith(".ts") &&
          !entry.name.endsWith(".test.ts") &&
          !entry.name.endsWith(".spec.ts")
        ) {
          files.push(fullPath);
        }
      }
    }
  }

  await scanDirectory(path);
  return files;
}
