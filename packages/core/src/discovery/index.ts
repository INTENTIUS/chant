import type { Declarable } from "../declarable";
import type { DiscoveryError } from "../errors";
import type { IntrinsicDef } from "../lexicon";
import { findInfraFiles } from "./files";
import { importModule } from "./import";
import { collectEntities } from "./collect";
import { resolveAttrRefs } from "./resolve";
import { buildDependencyGraph } from "./graph";
import { tryFoldFile, planFoldTaint } from "./fold-import";

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
   * chant #1022/#1023 (epic #1019) — opt-in: for each source file, try to
   * fold it to `Declarable`/`CompositeInstance` entities statically (no
   * module execution) before falling back to importing/running it. Anything
   * the folder can't represent (a non-`new`, non-composite-call export, a
   * cross-file-only reference, …) falls back per-file — see
   * {@link planFoldTaint} for the one case where a file that WOULD fold in
   * isolation is still forced back to run, to keep fold and run from ever
   * disagreeing about a shared entity's identity. Default `false` — behavior
   * is unchanged unless requested.
   */
  fold?: boolean;

  /**
   * chant #1039 — lexicon-registered intrinsic tags (e.g. AWS's `Sub`) to
   * recognize while folding. Threaded down to `tryFoldFile`/the static
   * folder so a registered tagged template folds instead of falling back to
   * run. Only meaningful when {@link fold} is set; ignored otherwise.
   * Default: none (an intrinsic-using file still folds up to that point,
   * then falls back to run at the unregistered tag).
   */
  intrinsics?: IntrinsicDef[];
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

  // Fold path (#1022/#1023): try the static folder on EVERY file first,
  // independently, before committing any decision. A file that folds
  // successfully in isolation must still be forced back to run if some
  // OTHER file that itself falls back to run imports it (directly or
  // transitively) — otherwise the run-fallback file's real re-import
  // produces a SECOND, non-identical copy of the same entities this file
  // already folded, and cross-file AttrRefs between them can never resolve
  // (see {@link planFoldTaint}'s doc for the full story). This is only
  // knowable after every file's fold has been attempted, hence the two
  // passes instead of committing per-file as they're visited.
  const foldAttempts = new Map<string, Awaited<ReturnType<typeof tryFoldFile>>>();
  if (options?.fold) {
    for (const file of files) {
      foldAttempts.set(file, await tryFoldFile(file, options.intrinsics));
    }
  }
  const taintedFiles = options?.fold
    ? await planFoldTaint(
        files,
        new Map(files.map((file) => [file, foldAttempts.get(file)?.ok === true])),
      )
    : new Set<string>();

  for (const file of files) {
    if (options?.fold) {
      const folded = foldAttempts.get(file)!;
      if (folded.ok && !taintedFiles.has(file)) {
        const exportsObj: Record<string, unknown> = {};
        for (const [name, value] of folded.entities) exportsObj[name] = value;
        modules.push({ file, exports: exportsObj });
        foldDecisions.push({ file, mode: "fold", resourceCount: folded.entities.length });
        continue;
      }
      const reason = !folded.ok
        ? folded.reason
        : `would fold in isolation, but a file that imports it (directly or transitively) falls back to run — folding independently would create a duplicate, non-identical instance`;
      foldDecisions.push({ file, mode: "run", reason });
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
