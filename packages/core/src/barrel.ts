import { readdirSync, readFileSync } from "fs";
import { join } from "path";

export function barrel(dir: string): Record<string, unknown> {
  let allExports: Record<string, unknown> | null = null;

  function load(): Record<string, unknown> {
    if (allExports) return allExports;
    allExports = {};

    const files = readdirSync(dir)
      .filter(
        (f) =>
          f.endsWith(".ts") &&
          !f.startsWith("_") &&
          !f.endsWith(".test.ts") &&
          !f.endsWith(".spec.ts"),
      )
      .sort();

    // Identify files that reference the barrel (.$. or .$[) — these
    // may silently resolve cross-references to undefined if their
    // dependency files haven't loaded yet
    const barrelRefPattern = /\.\$[.\[]/;
    const usesBarrel = new Set<string>();
    for (const file of files) {
      const src = readFileSync(join(dir, file), "utf-8");
      if (barrelRefPattern.test(src)) {
        usesBarrel.add(file);
      }
    }

    function loadFile(file: string, overwrite = false): boolean {
      const fullPath = join(dir, file);
      try {
        const mod = require(fullPath);
        for (const [key, val] of Object.entries(mod)) {
          if (val !== undefined && (overwrite || !(key in allExports!))) {
            allExports![key] = val;
          }
        }
        return true;
      } catch {
        // Clear require cache so retry re-executes the file
        delete require.cache[require.resolve(fullPath)];
        return false;
      }
    }

    // First pass — load all files in alphabetical order
    const failed: string[] = [];
    for (const file of files) {
      if (!loadFile(file)) {
        failed.push(file);
      }
    }

    // Retry files that threw — their dependencies are now available
    for (const file of failed) {
      loadFile(file);
    }

    // Second pass — reload files that reference the barrel so
    // cross-references that silently resolved to undefined now
    // pick up the correct values. Files without barrel references
    // keep their original instances to preserve the reference graph.
    for (const file of files) {
      if (!usesBarrel.has(file)) continue;
      const fullPath = join(dir, file);
      try { delete require.cache[require.resolve(fullPath)]; } catch {}
    }
    for (const file of files) {
      if (!usesBarrel.has(file)) continue;
      loadFile(file, true);
    }

    return allExports;
  }

  return new Proxy<Record<string, unknown>>({}, {
    get(_, prop: string | symbol) {
      if (typeof prop === 'symbol') return undefined;
      return load()[prop];
    },
    has(_, prop: string | symbol) {
      if (typeof prop === 'symbol') return false;
      return prop in load();
    },
    ownKeys(_) {
      return Object.keys(load());
    },
    getOwnPropertyDescriptor(_, prop: string | symbol) {
      if (typeof prop === 'symbol') return undefined;
      const exports = load();
      if (prop in exports) {
        return { configurable: true, enumerable: true, value: exports[prop] };
      }
      return undefined;
    },
  });
}
