import type { Declarable } from "../declarable";
import type { DiscoveryError } from "../errors";
import { findInfraFiles } from "./files";
import { importModule } from "./import";
import { collectEntities } from "./collect";
import { resolveAttrRefs } from "./resolve";
import { buildDependencyGraph } from "./graph";

/**
 * Result of the discovery process
 */
export interface DiscoveryResult {
  /** Map of entity name to Declarable entity */
  entities: Map<string, Declarable>;
  /** Map of entity name to set of entity names it depends on */
  dependencies: Map<string, Set<string>>;
  /** Array of source file paths that were processed */
  sourceFiles: string[];
  /** Array of errors encountered during discovery */
  errors: DiscoveryError[];
}

/**
 * Discovers all declarable entities in a directory by scanning files,
 * importing modules, collecting entities, resolving references, and building
 * a dependency graph.
 *
 * @param path - The directory path to discover entities in
 * @returns DiscoveryResult with entities, dependencies, sourceFiles, and errors
 */
export async function discover(path: string): Promise<DiscoveryResult> {
  const errors: DiscoveryError[] = [];
  const sourceFiles: string[] = [];

  // Step 1: Scan for TypeScript files
  const files = await findInfraFiles(path);
  sourceFiles.push(...files);

  // Step 2: Import all modules
  const modules: Array<{ file: string; exports: Record<string, unknown> }> = [];

  for (const file of files) {
    try {
      const exports = await importModule(file);
      modules.push({ file, exports });
    } catch (error) {
      // Collect import errors but continue processing other files
      if (error instanceof Error && error.name === "DiscoveryError") {
        errors.push(error as DiscoveryError);
      } else {
        // Convert unexpected errors to DiscoveryError
        const { DiscoveryError: DiscoveryErrorClass } = await import(
          "../errors"
        );
        errors.push(
          new DiscoveryErrorClass(
            file,
            error instanceof Error ? error.message : String(error),
            "import"
          )
        );
      }
    }
  }

  // Step 3: Collect entities from imported modules
  let entities = new Map<string, Declarable>();

  try {
    entities = collectEntities(modules);
  } catch (error) {
    // Collect resolution errors
    if (error instanceof Error && error.name === "DiscoveryError") {
      errors.push(error as DiscoveryError);
    } else {
      const { DiscoveryError: DiscoveryErrorClass } = await import("../errors");
      errors.push(
        new DiscoveryErrorClass(
          "",
          error instanceof Error ? error.message : String(error),
          "resolution"
        )
      );
    }
    // If collection fails, return early with empty results
    return {
      entities: new Map(),
      dependencies: new Map(),
      sourceFiles,
      errors,
    };
  }

  // Step 4: Resolve AttrRefs
  try {
    resolveAttrRefs(entities);
  } catch (error) {
    // Collect resolution errors but continue
    const { DiscoveryError: DiscoveryErrorClass } = await import("../errors");
    errors.push(
      new DiscoveryErrorClass(
        "",
        error instanceof Error ? error.message : String(error),
        "resolution"
      )
    );
  }

  // Step 5: Build dependency graph
  let dependencies = new Map<string, Set<string>>();

  try {
    dependencies = buildDependencyGraph(entities);
  } catch (error) {
    // Collect graph building errors
    const { DiscoveryError: DiscoveryErrorClass } = await import("../errors");
    errors.push(
      new DiscoveryErrorClass(
        "",
        error instanceof Error ? error.message : String(error),
        "resolution"
      )
    );
  }

  return {
    entities,
    dependencies,
    sourceFiles,
    errors,
  };
}
