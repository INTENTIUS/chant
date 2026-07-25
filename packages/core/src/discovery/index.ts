import type { Declarable } from "../declarable";
import type { DiscoveryError } from "../errors";
import { findInfraFiles } from "./files";
import { importModule } from "./import";
import { collectEntities } from "./collect";
import { resolveAttrRefs } from "./resolve";
import { buildDependencyGraph } from "./graph";
import { tryFoldFile } from "./fold-import";

/**
 * Per-file fold-vs-run outcome (chant #1022, epic #1019), populated only
 * when {@link DiscoveryOptions.fold} was requested. Lets a caller (`chant
 * build --fold`) report which files skipped module execution and which
 * fell back to the run path, and why.
 */
export interface FoldDecision {
  /** Absolute path of the source file this decision covers. */
  file: string;
  /** "fold" — folded statically, zero execution. "run" — imported/executed as before. */
  mode: "fold" | "run";
  /** Why the file fell back to run. Present only when `mode === "run"` and fold was requested. */
  reason?: string;
  /** Number of entities the fold produced. Present only when `mode === "fold"`. */
  resourceCount?: number;
}

/**
 * Optional inputs to {@link discover}.
 */
export interface DiscoveryOptions {
  /**
   * chant #1022 (epic #1019) — opt-in: for each source file, try to fold it
   * to `Declarable` entities statically (no module execution) before
   * falling back to importing/running it. Anything the folder can't
   * represent (composite factory calls, non-`new` exports, …) falls back
   * per-file. Default `false` — behavior is unchanged unless requested.
   */
  fold?: boolean;
}

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
  /**
   * Per-file fold-vs-run decisions (#1022). Empty unless
   * {@link DiscoveryOptions.fold} was set.
   */
  foldDecisions: FoldDecision[];
}

/**
 * Discovers all declarable entities in a directory by scanning files,
 * importing modules, collecting entities, resolving references, and building
 * a dependency graph.
 *
 * @param path - The directory path to discover entities in
 * @param options - Optional discovery behavior, e.g. {@link DiscoveryOptions.fold}
 * @returns DiscoveryResult with entities, dependencies, sourceFiles, and errors
 */
export async function discover(path: string, options?: DiscoveryOptions): Promise<DiscoveryResult> {
  const errors: DiscoveryError[] = [];
  const sourceFiles: string[] = [];
  const foldDecisions: FoldDecision[] = [];

  // Step 1: Scan for TypeScript files
  const files = await findInfraFiles(path);
  sourceFiles.push(...files);

  // Step 2: Import all modules
  const modules: Array<{ file: string; exports: Record<string, unknown> }> = [];

  for (const file of files) {
    // Fold path (#1022): try the static folder first. On success, the file
    // contributes its folded entities directly and `importModule` (which
    // would execute the file) is skipped entirely. On any construct the
    // folder can't represent, fall back to the exact run path used when
    // `fold` is off.
    if (options?.fold) {
      const folded = await tryFoldFile(file);
      if (folded.ok) {
        const exportsObj: Record<string, unknown> = {};
        for (const [name, value] of folded.entities) exportsObj[name] = value;
        modules.push({ file, exports: exportsObj });
        foldDecisions.push({ file, mode: "fold", resourceCount: folded.entities.length });
        continue;
      }
      foldDecisions.push({ file, mode: "run", reason: folded.reason });
    }

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
    entities = collectEntities(modules, path);
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
      foldDecisions,
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
    foldDecisions,
  };
}
