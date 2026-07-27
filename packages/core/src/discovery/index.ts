import type { Declarable } from "../declarable";
import type { DiscoveryError } from "../errors";
import type { IntrinsicDef } from "../lexicon";
import { findInfraFiles } from "./files";
import { importModule } from "./import";
import { collectEntities } from "./collect";
import { resolveAttrRefs } from "./resolve";
import { buildDependencyGraph } from "./graph";
import { tryFoldFile, planFoldTaint, createFoldSession } from "./fold-import";
import { getProvenance } from "../provenance";
import type { BuildParamProvenance } from "../provenance";
import { buildParamValues } from "../build-params";
import { setBuildParams } from "../params";

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

  /**
   * chant #1045 Phase 2 — opt-in: whatever would otherwise reach the
   * in-process `importModule` step (every file, when {@link fold} isn't set;
   * only the per-file run-fallback remainder, when it is) instead runs
   * together, isolated, in one sandboxed child process — see
   * `./sandbox/run.ts`. Folded files are unaffected: fold already executes
   * zero of a file's own top-level code, so it stays in this process exactly
   * as it does today. Default `false` — behavior, including performance
   * (no bundling, no child process, no IPC), is unchanged unless requested.
   */
  sandbox?: boolean;

  /**
   * chant #1064 — this build's resolved build-time parameter values (see
   * ../build-params.ts's `resolveBuildParams`, driven by the CLI's
   * `--param`/`--params-file`/declared `env` mapping/`chant.config.ts`
   * defaults). Populated into `../params.ts`'s shared `params` object
   * (`setBuildParams`, below) before any project file is imported or folded,
   * and threaded into the fold session so a `params.<name>` reference
   * resolves to a literal instead of an unresolved identifier. Default: none
   * — `params` stays empty, matching a project that declares no
   * `buildParams` at all.
   */
  buildParams?: BuildParamProvenance[];
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

  // chant #1064 — populate the shared build-time-parameters object BEFORE any
  // project file is imported or folded, so both paths observe the identical
  // values: the fold path substitutes them directly (see
  // fold-import.ts's `buildExternals`), and a run(-fallback) file that
  // imports "@intentius/chant/params" for real sees them too, since
  // `setBuildParams` mutates the shared object in place rather than
  // rebinding it. Unconditional (not just when `buildParams` is set) so a
  // stale value from a PRIOR `discover()` call in the same process (tests,
  // `--watch`) never leaks into a build that supplied none.
  const buildParamValuesMap = buildParamValues(options?.buildParams ?? []);
  setBuildParams(buildParamValuesMap);

  // Step 1: Scan for TypeScript files
  const files = await findInfraFiles(path);
  sourceFiles.push(...files);

  // Step 2: Import all modules
  const modules: Array<{ file: string; exports: Record<string, unknown> }> = [];
  // chant #1045 Phase 2 — files that would reach the in-process importModule()
  // call below are instead queued here when options.sandbox is set, and run
  // together afterward in one isolated child (see the merge step after
  // collectEntities).
  const sandboxFiles: string[] = [];

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
  // chant #1020 — ONE session, shared by every top-level `tryFoldFile` call
  // below AND by any cross-file reference one file's fold attempt makes into
  // another (see fold-import.ts's `FoldSession` doc): this is what guarantees
  // a project file imported by several others is folded exactly once, so
  // every referrer shares the identical constructed Declarable/
  // CompositeInstance objects rather than each building its own copy.
  const foldSession = options?.fold ? createFoldSession(options.intrinsics, buildParamValuesMap) : undefined;
  if (options?.fold) {
    for (const file of files) {
      foldAttempts.set(file, await tryFoldFile(file, options.intrinsics, foldSession));
    }
  }
  const taintedFiles = options?.fold
    ? await planFoldTaint(
        files,
        new Map(files.map((file) => [file, foldAttempts.get(file)?.ok === true])),
        // chant #1044 — which files' OBJECTS each successful fold captured,
        // so a file forced back to run also invalidates the folds that
        // already hold its instances (see planFoldTaint's doc).
        new Map(
          files.flatMap((file) => {
            const attempt = foldAttempts.get(file);
            return attempt?.ok === true ? [[file, attempt.liveSources] as const] : [];
          }),
        ),
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

    if (options?.sandbox) {
      sandboxFiles.push(file);
      continue;
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

  // chant #1045 Phase 2 — run the queued sandbox files together, isolated, in
  // one child process, and merge its already-named, already-ref-resolved
  // entities in. The child performs its OWN collectEntities/resolveAttrRefs
  // over just this subset (see ./sandbox/run.ts) rather than sharing live
  // objects with the fold-only `entities` map above — a real object can't
  // cross a process boundary, and `planFoldTaint` already guarantees no
  // folded file is ever referenced by a run-fallback one (or vice versa), so
  // the two subsets never share cross-references. A name collision between
  // them is therefore always a genuine duplicate (never the same object
  // legitimately re-exported), reported exactly like collectEntities' own
  // same-key check above rather than silently overwritten. (One narrower gap
  // than the single unified collectEntities call this replaces: cross-
  // directory stack-prefix disambiguation, #932, is computed separately for
  // each subset, so a bare-name collision that spans a folded directory and a
  // run-fallback directory won't be disambiguated the same way a single
  // combined call would. Not hit by any corpus entry today.)
  if (options?.sandbox && sandboxFiles.length > 0) {
    try {
      // Dynamic, not static — `./sandbox/run` imports `esbuild`, a large CJS
      // package with its own module-scope filesystem access (the same class
      // of thing `entity-wire.ts`'s split from `entity-wire-codec.ts` avoids
      // for `typescript`). `discover()` is re-exported from the package root
      // (`@intentius/chant`), and project source commonly imports that root
      // — a STATIC top-level import here would make `esbuild` transitively
      // reachable, and therefore BUNDLED AND EAGERLY EVALUATED, by every
      // project file the sandboxed child imports that happens to import
      // chant itself. A dynamic import is only ever actually reached here,
      // at runtime, when a caller opts into `sandbox: true` — never from
      // inside a bundled project file (project code never calls `discover()`
      // itself), so esbuild only ever bundles it as inert, un-evaluated code
      // when it's pulled in transitively.
      const { runFallbackFilesSandboxed } = await import("./sandbox/run");
      const sandboxResult = await runFallbackFilesSandboxed(sandboxFiles, path);
      errors.push(...sandboxResult.errors);
      for (const [name, entity] of sandboxResult.entities) {
        if (entities.has(name)) {
          const { DiscoveryError: DiscoveryErrorClass } = await import("../errors");
          const file = sandboxResult.provenanceByName[name] ?? path;
          errors.push(new DiscoveryErrorClass(file, `Duplicate export name "${name}" found`, "resolution"));
          continue;
        }
        entities.set(name, entity);
      }

      // Re-order the merged map to match original file discovery order.
      // Without this, every fold entity (inserted above via the parent's own
      // collectEntities call) sorts before every sandboxed entity (appended
      // by the loop just above) — a fold-block-then-run-block order, not the
      // per-file INTERLEAVED order a single unified collectEntities call
      // over `files` would produce. Several downstream consumers iterate the
      // entities map directly and are order-sensitive (e.g. a serializer's
      // auto-detected cross-lexicon `Parameters`), so this isn't cosmetic —
      // uncorrected, it's real, if harmless (still a valid template),
      // byte-level drift. Ordered by each entity's OWN provenance
      // (`../provenance.ts`) rather than by which loop produced it: a fold
      // entity's provenance is read directly (a live object, still in this
      // process); a sandboxed entity's provenance didn't survive the wire —
      // `encodeEntitySet` deliberately drops build metadata, not declared
      // configuration — so `sandboxResult.provenanceByName` (a side channel
      // the child computes for exactly this, see ./sandbox/run.ts) is used
      // instead. `Array.prototype.sort` is stable (guaranteed since ES2019),
      // so entities from the same file (already correctly ordered by
      // whichever collectEntities call produced them) keep their relative
      // order — only which FILE's block comes first changes.
      const fileOrder = new Map(files.map((file, i) => [file, i]));
      const withIndex = [...entities.entries()].map(([name, entity]) => {
        const sourceFile = getProvenance(entity)?.sourceFile ?? sandboxResult.provenanceByName[name];
        const index = sourceFile !== undefined ? fileOrder.get(sourceFile) : undefined;
        return { name, entity, index: index ?? Number.MAX_SAFE_INTEGER };
      });
      withIndex.sort((a, b) => a.index - b.index);
      entities = new Map(withIndex.map(({ name, entity }) => [name, entity]));
    } catch (error) {
      const { DiscoveryError: DiscoveryErrorClass } = await import("../errors");
      errors.push(
        new DiscoveryErrorClass(path, error instanceof Error ? error.message : String(error), "resolution"),
      );
    }
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
