import type { Declarable } from "./declarable";
import type { Serializer, SerializerResult } from "./serializer";
import type { OwnershipMarker } from "./ownership";
import type { BuildError, DiscoveryErrorType } from "./errors";
import type { IntrinsicDef, BuildRootContribution, BuildRootContributor } from "./lexicon";
import type { BuildParamProvenance } from "./provenance";
import { DiscoveryError, BuildError as BuildErrorClass } from "./errors";
import { LexiconOutput, isLexiconOutput } from "./lexicon-output";
import { isSecretDeclaration } from "./secret-provenance";
import { splitReceiptEntities } from "./effect-receipt";
import { isScenario } from "./lifecycle/scenario";
import { AttrRef } from "./attrref";
import { isAttrRefLike } from "./utils";
import { isChildProject, type ChildProjectInstance } from "./child-project";
import { discover, type DiscoveryResult, type FoldDecision } from "./discovery/index";
import { decodeEntitySet, type DiscoveredEntitiesJson } from "./discovery/entity-wire";
import { buildDependencyGraph } from "./discovery/graph";
import { topologicalSort } from "./sort";
import { resolve } from "node:path";

/**
 * Build manifest describing cross-lexicon outputs and deployment order
 */
export interface BuildManifest {
  lexicons: string[];
  outputs: Record<
    string,
    { source: string; entity: string; attribute: string }
  >;
  deployOrder: string[];
  /** Cross-stack apply-ordering graph (see {@link computeStackGraph}). */
  stackGraph: StackGraph;
}

/**
 * The cross-stack (cross-lexicon) apply-ordering graph chant already computes
 * while resolving cross-lexicon references — surfaced as tool-agnostic data for
 * an orchestrator to consume. chant exposes the order; it does not drive the
 * apply.
 */
export interface StackGraph {
  /** Stacks (lexicon partitions) in the build. */
  nodes: string[];
  /**
   * Consumer→producer edges: `from` imports a value `to` exports, so `to` must
   * apply before `from`. Inferred from cross-lexicon references.
   */
  edges: Array<{ from: string; to: string }>;
  /** A flat applicable sequence — every producer before its consumers. */
  order: string[];
  /**
   * Levels: stacks in the same wave have no inter-dependency and may apply
   * concurrently. `order` flattened with parallelism made explicit.
   */
  waves: string[][];
  /** Dependency cycles, if any (each a list of stacks). Normally empty. */
  cycles: string[][];
}

/**
 * Compute the cross-stack apply-ordering graph from resolved entities. Edges are
 * inferred from cross-lexicon attribute references (a resource in lexicon A
 * referencing an attribute of a resource in lexicon B ⇒ A depends on B). Returns
 * the edge set plus a topological order, parallel-safe waves, and any cycles.
 */
export function computeStackGraph(
  entities: Map<string, Declarable>,
  lexiconNames: string[],
): StackGraph {
  const edges: Array<{ from: string; to: string }> = [];
  const edgeSet = new Set<string>();
  const addEdge = (from: string, to: string): void => {
    if (from === to) return;
    const key = `${from}\0${to}`;
    if (edgeSet.has(key)) return;
    edgeSet.add(key);
    edges.push({ from, to });
  };

  const walk = (value: unknown, consumer: string, visited: Set<unknown>): void => {
    if (value === null || value === undefined || typeof value !== "object") return;
    if (visited.has(value)) return;
    visited.add(value);
    // Duck-type, not `instanceof` (chant #1137): a lexicon built against a
    // separate copy of `@intentius/chant` produces AttrRefs that fail
    // `instanceof AttrRef` here but carry the same shape. Without this, a
    // real cross-stack dependency silently falls through to the generic
    // object walk below instead of producing an edge, which can misorder —
    // or entirely drop — the apply order this graph exists to compute.
    if (isAttrRefLike(value)) {
      const parent = value.parent.deref();
      const producer = parent ? (parent as Record<string, unknown>).lexicon : undefined;
      if (typeof producer === "string" && producer !== consumer) addEdge(consumer, producer);
      return;
    }
    if (isLexiconOutput(value)) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, consumer, visited);
      return;
    }
    for (const val of Object.values(value as Record<string, unknown>)) walk(val, consumer, visited);
  };

  for (const [, entity] of entities) {
    const consumer = entity.lexicon;
    const visited = new Set<unknown>();
    for (const val of Object.values(entity as unknown as Record<string, unknown>)) {
      walk(val, consumer, visited);
    }
    if ("props" in entity && typeof entity.props === "object" && entity.props !== null) {
      walk(entity.props, consumer, visited);
    }
  }

  // Dependency map: node → producers it depends on.
  const nodes = lexiconNames.length
    ? [...lexiconNames]
    : // Secret provenance declarations (#1828) and plan scenarios (#1292) never
      // form a stack — their pseudo-lexicon has no serializer and must not
      // appear in the manifest.
      [...new Set([...entities.values()].filter((e) => !isSecretDeclaration(e) && !isScenario(e)).map((e) => e.lexicon))];
  const deps = new Map<string, Set<string>>();
  for (const n of nodes) deps.set(n, new Set());
  for (const { from, to } of edges) {
    if (!deps.has(from)) deps.set(from, new Set());
    if (!deps.has(to)) deps.set(to, new Set());
    deps.get(from)!.add(to);
  }

  // Kahn layering: a node is ready once every producer it depends on is placed.
  const remaining = new Set(deps.keys());
  const waves: string[][] = [];
  const order: string[] = [];
  while (remaining.size > 0) {
    const wave = [...remaining]
      .filter((n) => [...deps.get(n)!].every((d) => !remaining.has(d)))
      .sort();
    if (wave.length === 0) break; // remaining nodes form a cycle
    for (const n of wave) {
      remaining.delete(n);
      order.push(n);
    }
    waves.push(wave);
  }
  const cycles: string[][] = remaining.size > 0 ? [[...remaining].sort()] : [];

  edges.sort((a, b) => `${a.from}\0${a.to}`.localeCompare(`${b.from}\0${b.to}`));
  return { nodes: [...nodes].sort(), edges, order, waves, cycles };
}

/**
 * Result of the build process
 */
/**
 * Optional inputs to the build pipeline.
 */
export interface BuildOptions {
  /**
   * When set, serializers stamp this ownership marker into each resource's
   * native metadata channel. Resolved from project config by the caller.
   */
  ownership?: OwnershipMarker;

  /**
   * The resolved project configuration, passed through to each serializer's
   * {@link SerializeContext} so a dialect can read its lexicon-scoped settings.
   */
  config?: Record<string, unknown>;

  /**
   * chant #1022 (epic #1019) — opt-in: fold source modules statically
   * instead of importing/running them, falling back to run per-file for
   * anything the folder can't represent. Default `false` (unchanged
   * behavior). See {@link DiscoveryOptions.fold} in `./discovery/index`.
   */
  fold?: boolean;

  /**
   * chant #1039 — lexicon-registered intrinsic tags (e.g. AWS's `Sub`) to
   * recognize while folding. Passed straight through to
   * {@link DiscoveryOptions.intrinsics}; ignored unless {@link fold} is set.
   * The CLI populates this from `options.plugins.flatMap(p => p.intrinsics?.() ?? [])`.
   */
  intrinsics?: IntrinsicDef[];

  /**
   * chant #1063 — the lexicon names loaded for this build. Passed straight
   * through to {@link DiscoveryOptions.lexicons} in `./discovery/index`;
   * ignored unless {@link fold} is set. The CLI populates this from
   * `options.plugins.map(p => p.name)`.
   */
  lexicons?: readonly string[];

  /**
   * chant #1442 — lexicon name → the version of the plugin that served it.
   * Recorded on {@link BuildResult.lexiconVersions} so a build digest can say
   * WHAT interpreted the declarations, not only what was declared. The CLI
   * populates this from `options.plugins`; `build()` only carries it.
   */
  lexiconVersions?: Readonly<Record<string, string>>;

  /**
   * chant #1045 Phase 2 — opt-in: run-fallback files (or, when {@link fold}
   * isn't set, every file) execute together, isolated, in one sandboxed
   * child process instead of in-process. Passed straight through to
   * {@link DiscoveryOptions.sandbox} in `./discovery/index`. Default `false`
   * (unchanged behavior/performance).
   */
  sandbox?: boolean;

  /**
   * chant #1064 — this build's resolved build-time parameter values (see
   * ./build-params.ts's `resolveBuildParams`, driven by the CLI's
   * `--param`/`--params-file`/declared `env` mapping/`chant.config.ts`
   * `buildParams` defaults). Threaded through to `discover()`, which
   * populates `./params.ts`'s shared `params` object before any project file
   * is imported or folded, and into the fold session so a `params.<name>`
   * reference resolves to a literal. Passed through verbatim onto
   * {@link BuildResult.buildParams} — `build()` itself does no
   * declaration/validation (that's the CLI/config layer's job); it only
   * carries the already-resolved records for provenance.
   */
  buildParams?: BuildParamProvenance[];

  /**
   * chant #1548 piece 3 — lexicon-contributed build roots: closures the CLI
   * binds from each configured plugin's `buildRoots(ctx)` hook (see
   * `collectBuildRootContributors` in ./cli/plugins.ts), each rendering a
   * non-chant-source root (a kustomize overlay dir) into entities. Run once,
   * at the TOP-LEVEL build only (never repeated for nested child projects),
   * after discovery and before partitioning — so contributed entities are
   * serialized, ownership-stamped, post-synth-checked and observed exactly
   * like discovered ones. A contributor that throws becomes a build error
   * carrying its message (the k8s hook's missing-binary refusal names the
   * binaries); a contributed name colliding with a discovered entity is a
   * build error, never a silent overwrite.
   */
  buildRoots?: BuildRootContributor[];
}

export interface BuildResult {
  /** Map of lexicon name to serialized output (string or multi-file result) */
  outputs: Map<string, string | SerializerResult>;
  /** Map of entity name to Declarable entity */
  entities: Map<string, Declarable>;
  /** Resource-level dependency graph from discovery */
  dependencies: Map<string, Set<string>>;
  /** Array of warnings encountered during the build */
  warnings: string[];
  /** Array of errors encountered during discovery and build */
  errors: Array<DiscoveryError | BuildError>;
  /** Build manifest with cross-lexicon dependency info */
  manifest: BuildManifest;
  /** Number of source files processed */
  sourceFileCount: number;
  /**
   * Per-file fold-vs-run decisions (#1022). Empty unless
   * {@link BuildOptions.fold} was set.
   */
  foldDecisions: FoldDecision[];

  /**
   * chant #1442 — lexicon name → the version of the plugin that served this
   * build, passed through verbatim from {@link BuildOptions.lexiconVersions}.
   *
   * The other half of what a build digest needs. `hashProps` fingerprints the
   * declaration; this records what turned it into output. A lexicon is a
   * generated artifact pinned to an upstream spec, so a bump can change
   * emitted output with no source change at all — and without this the two
   * builds are indistinguishable.
   *
   * Empty when the caller supplied no plugins (`build()` used as a library,
   * and most tests).
   */
  lexiconVersions: Record<string, string>;

  /**
   * This build's resolved build-time parameters (#1064) — the build
   * provenance record for `params.<name>` values, alongside the existing
   * entity-level provenance (./provenance.ts). Passed through verbatim from
   * {@link BuildOptions.buildParams}; empty when the project declares/
   * supplies none.
   */
  buildParams: BuildParamProvenance[];
}

/**
 * Partitions entities by their lexicon field.
 * Property-kind Declarables are included in the same partition as their parent
 * (they get inlined during serialization).
 *
 * @param entities - Map of entity name to Declarable
 * @returns Map of lexicon name to Map of entity name to Declarable
 */
export function partitionByLexicon(
  entities: Map<string, Declarable>
): Map<string, Map<string, Declarable>> {
  const partitions = new Map<string, Map<string, Declarable>>();

  for (const [name, entity] of entities) {
    // LexiconOutput instances are collected separately; skip them here
    if (isLexiconOutput(entity)) continue;
    // Secret provenance declarations (#1828) are serializer-neutral: data
    // that lint and lexicons read from the entity map, never output. Keeping
    // them out of every partition means no serializer sees them and no
    // "No serializer found" warning fires for their pseudo-lexicon.
    if (isSecretDeclaration(entity)) continue;
    // Plan scenarios (#1292) are serializer-neutral the same way: a checkable
    // expectation the CLI reads off the entity map, never output.
    if (isScenario(entity)) continue;
    const lexicon = entity.lexicon;
    if (!partitions.has(lexicon)) {
      partitions.set(lexicon, new Map());
    }
    partitions.get(lexicon)!.set(name, entity);
  }

  return partitions;
}

/**
 * Collect LexiconOutput instances from all entity property trees.
 * Walks entity properties recursively to find LexiconOutput values.
 */
export function collectLexiconOutputs(
  entities: Map<string, Declarable>
): LexiconOutput[] {
  const outputs: LexiconOutput[] = [];
  const visited = new Set<unknown>();

  function walk(value: unknown): void {
    if (value === null || value === undefined || typeof value !== "object") {
      return;
    }
    if (visited.has(value)) return;
    visited.add(value);

    if (isLexiconOutput(value)) {
      outputs.push(value);
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item);
      }
      return;
    }

    for (const val of Object.values(value as Record<string, unknown>)) {
      walk(val);
    }
  }

  for (const [name, entity] of entities) {
    if (isLexiconOutput(entity as unknown)) {
      const lexiconOutput = entity as unknown as LexiconOutput;
      // A literal-valued output (chant #1121) has no source entity at all —
      // it isn't a reference to anything, so it must not fall back to the
      // output's OWN map key the way an AttrRef whose parent didn't resolve
      // would. Leaving `sourceEntity` empty keeps `getOutputValue()`'s
      // (never-reached, for a literal) `Fn::GetAtt` fallback from ever being
      // handed a bogus source, and keeps consumers that read `sourceEntity`
      // directly (e.g. `graph-ir.ts`'s cross-stack export, the build
      // manifest) from reporting the output as its own source.
      if (lexiconOutput._literalValue === null) {
        // Resolve source entity name from the WeakRef parent identity
        const parent = lexiconOutput._sourceParent?.deref();
        let sourceName = name;
        if (parent) {
          for (const [entityName, e] of entities) {
            if (e === parent) {
              sourceName = entityName;
              break;
            }
          }
        }
        lexiconOutput._setSourceEntity(sourceName);
      }
      outputs.push(lexiconOutput);
      continue;
    }

    if ("props" in entity && typeof entity.props === "object" && entity.props !== null) {
      // Set source entity name for any LexiconOutputs found in props
      const prevLength = outputs.length;
      walk(entity.props);
      for (let i = prevLength; i < outputs.length; i++) {
        // Same #1121 guard as above — a literal has no source entity to name.
        if (!outputs[i].sourceEntity && outputs[i]._literalValue === null) {
          outputs[i]._setSourceEntity(name);
        }
      }
    }
  }

  return outputs;
}

/**
 * Detect cross-lexicon AttrRefs by walking each entity's property tree.
 * For each AttrRef whose parent entity belongs to a different lexicon than
 * the consuming entity, auto-create a LexiconOutput.
 *
 * @param entities - Map of entity name to Declarable
 * @returns Array of auto-detected LexiconOutput instances
 */
export function detectCrossLexiconRefs(
  entities: Map<string, Declarable>
): LexiconOutput[] {
  const outputs: LexiconOutput[] = [];
  // Track by "sourceEntityName_attribute" to avoid duplicates
  const seen = new Set<string>();

  // Build a reverse lookup: object identity -> entity name
  const objectToName = new Map<object, string>();
  for (const [name, entity] of entities) {
    objectToName.set(entity as object, name);
  }

  function walk(
    value: unknown,
    consumingLexicon: string,
    visited: Set<unknown>
  ): void {
    if (value === null || value === undefined || typeof value !== "object") {
      return;
    }
    if (visited.has(value)) return;
    visited.add(value);

    // Duck-type, not `instanceof` (chant #1137): a lexicon built against a
    // separate copy of `@intentius/chant` produces AttrRefs that fail
    // `instanceof AttrRef` here but carry the same shape. Without this, a
    // real cross-lexicon reference silently falls through to the generic
    // object walk below instead of auto-creating a `LexiconOutput`, and the
    // whole `Outputs` entry for it vanishes (same failure shape as #1122).
    if (isAttrRefLike(value)) {
      const parent = value.parent.deref();
      if (!parent) return;

      const parentLexicon = (parent as Record<string, unknown>).lexicon;
      if (typeof parentLexicon !== "string") return;

      if (parentLexicon !== consumingLexicon) {
        // Find the parent's entity name
        const parentName = objectToName.get(parent);
        if (!parentName) return;

        const key = `${parentName}_${value.attribute}`;
        if (!seen.has(key)) {
          seen.add(key);
          outputs.push(LexiconOutput.auto(value, parentName));
        }
      }
      return;
    }

    // Skip LexiconOutput instances — these are explicit outputs
    if (isLexiconOutput(value)) return;

    // Do not descend into a whole resource entity (e.g. `Ref(bucket)` embeds
    // the resource object). Every resource instance carries a latent AttrRef
    // for *every* attribute in its spec (see runtime.ts) — most are never
    // referenced and, for config-gated attributes (S3 `WebsiteURL`,
    // `MetadataConfiguration.*`), don't exist at deploy time unless the
    // matching config block is set. Harvesting those as cross-lexicon outputs
    // emits `Fn::GetAtt` outputs for nonexistent attributes, which real
    // CloudFormation rejects (#959). Only an explicitly-accessed attribute
    // (a standalone AttrRef value, handled above) should produce an output.
    if (objectToName.has(value as object)) return;

    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item, consumingLexicon, visited);
      }
      return;
    }

    for (const val of Object.values(value as Record<string, unknown>)) {
      walk(val, consumingLexicon, visited);
    }
  }

  for (const [, entity] of entities) {
    const visited = new Set<unknown>();
    const consumingLexicon = entity.lexicon;

    // Walk entity-level properties (AttrRefs could be direct properties)
    for (const val of Object.values(entity as unknown as Record<string, unknown>)) {
      walk(val, consumingLexicon, visited);
    }

    // Walk props if present
    if (
      "props" in entity &&
      typeof entity.props === "object" &&
      entity.props !== null
    ) {
      walk(entity.props, consumingLexicon, visited);
    }
  }

  return outputs;
}

/**
 * Compute deploy order: source lexicons before consuming lexicons.
 */
function computeDeployOrder(
  lexiconNames: string[],
  lexiconOutputs: LexiconOutput[]
): string[] {
  // Build a dependency graph: consuming lexicons depend on source lexicons
  const deps = new Map<string, Set<string>>();
  for (const name of lexiconNames) {
    deps.set(name, new Set());
  }

  for (const output of lexiconOutputs) {
    // All lexicons other than the source lexicon implicitly depend on it
    for (const name of lexiconNames) {
      if (name !== output.sourceLexicon) {
        deps.get(name)?.add(output.sourceLexicon);
      }
    }
  }

  // Simple topological sort for deploy order
  const sorted: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(name: string): void {
    if (visited.has(name)) return;
    if (visiting.has(name)) return; // cycle, just skip
    visiting.add(name);
    for (const dep of deps.get(name) ?? []) {
      visit(dep);
    }
    visiting.delete(name);
    visited.add(name);
    sorted.push(name);
  }

  for (const name of lexiconNames) {
    visit(name);
  }

  return sorted;
}

/**
 * Generate the build manifest
 */
function generateManifest(
  lexiconNames: string[],
  lexiconOutputs: LexiconOutput[],
  entities: Map<string, Declarable>
): BuildManifest {
  const outputsRecord: Record<
    string,
    { source: string; entity: string; attribute: string }
  > = {};

  for (const output of lexiconOutputs) {
    outputsRecord[output.outputName] = {
      source: output.sourceLexicon,
      entity: output.sourceEntity,
      attribute: output.sourceAttribute ?? "",
    };
  }

  return {
    lexicons: lexiconNames,
    outputs: outputsRecord,
    deployOrder: computeDeployOrder(lexiconNames, lexiconOutputs),
    stackGraph: computeStackGraph(entities, lexiconNames),
  };
}

/** What merging build-root contributions produced: non-fatal render notes and
 * fatal messages (a failed contributor, a name collision). */
export interface BuildRootMergeResult {
  warnings: string[];
  errors: string[];
}

/**
 * Run each build-root contributor (#1548 piece 3) and merge its rendered
 * entities into `entities`, in place. THE one merge implementation — `build()`
 * uses it for step 4b, and the graph handler's discover-based paths reuse it
 * so a rendered kustomize root joins the graphed entity set under exactly the
 * rules the build applies (#1626):
 *
 * - a contributed name colliding with an existing entity is an error, never a
 *   silent overwrite;
 * - a contributor that throws becomes an error carrying its message (the k8s
 *   hook's missing-binary refusal names the binaries), not a stack trace.
 *
 * Errors come back as plain messages; each caller wraps them in its own error
 * vocabulary (`BuildErrorClass` in `build()`, the CLI's `formatError` on the
 * graph paths).
 */
export async function mergeBuildRootEntities(
  entities: Map<string, Declarable>,
  contributors: ReadonlyArray<BuildRootContributor>,
): Promise<BuildRootMergeResult> {
  const warnings: string[] = [];
  const errors: string[] = [];
  for (const contribute of contributors) {
    try {
      // The discovered set, read-only, so a contributor can react to what the
      // project DECLARED (a committed-encrypted `declareSecret()` naming a
      // ciphertext file to resolve). Contributors run in order, so this also
      // carries what earlier contributors added; the merge below is still the
      // only writer, which is what keeps the collision refusal meaningful.
      const contribution = await contribute({ entities });
      warnings.push(...(contribution.warnings ?? []));
      for (const [name, entity] of contribution.entities) {
        if (entities.has(name)) {
          errors.push(`Build-root entity "${name}" collides with a discovered entity of the same name`);
          continue;
        }
        entities.set(name, entity);
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { warnings, errors };
}

/**
 * Builds a lexicon specification by discovering entities, sorting them
 * topologically, and serializing them using the lexicon serializers.
 *
 * @param path - The directory path containing the specification files
 * @param serializers - The serializers to use for serialization
 * @returns BuildResult with outputs, entities, warnings, and errors
 */
export async function build(
  path: string,
  serializers: Serializer[],
  parentBuildStack?: Set<string>,
  options?: BuildOptions,
): Promise<BuildResult> {
  // Step 1: Discover entities and dependencies
  const discoveryResult = await discover(path, {
    fold: options?.fold,
    intrinsics: options?.intrinsics,
    lexicons: options?.lexicons,
    sandbox: options?.sandbox,
    buildParams: options?.buildParams,
  });

  return buildFromDiscoveryResult(discoveryResult, path, serializers, parentBuildStack, options);
}

/**
 * chant #1045 (Phase 1) — build from a discovery result produced OUTSIDE the
 * normal `discover(path)` call, i.e. decoded from {@link DiscoveredEntitiesJson}
 * (see {@link buildFromEntitiesJson}). Everything from here on (topological
 * sort, recursive child-project builds, partitioning, output detection,
 * serialization, manifest) is exactly what `build()` already does after its
 * own `discover()` call — extracted so the JSON path reuses it verbatim
 * instead of forking it.
 *
 * @param resolvedPathForChildStack - Used only to seed the circular-nested-
 *   stack detection (`buildStack`); the JSON path has no single directory a
 *   decoded entity set came from, so callers without one may pass any stable
 *   label (child projects aren't supported by the JSON boundary yet — see
 *   `discovery/entity-wire.ts` — so this is inert for that path today).
 */
async function buildFromDiscoveryResult(
  discoveryResult: DiscoveryResult,
  resolvedPathForChildStack: string,
  serializers: Serializer[],
  parentBuildStack?: Set<string>,
  options?: BuildOptions,
): Promise<BuildResult> {
  const warnings: string[] = [];
  const errors: Array<DiscoveryError | BuildError> = [];

  // Collect discovery errors
  errors.push(...discoveryResult.errors);

  // Step 2: Convert Map<string, Set<string>> to Record<string, string[]> for topologicalSort
  const dependenciesRecord: Record<string, string[]> = {};
  for (const [entityName, deps] of discoveryResult.dependencies) {
    dependenciesRecord[entityName] = Array.from(deps);
  }

  // Step 3: Perform topological sort
  try {
    topologicalSort(dependenciesRecord);
  } catch (error) {
    // BuildError from cycle detection
    if (error instanceof Error && error.name === "BuildError") {
      errors.push(error as BuildError);
    } else {
      // Unexpected error
      errors.push(
        new BuildErrorClass(
          "",
          error instanceof Error ? error.message : String(error)
        )
      );
    }
  }

  // Step 4: Recursively build child projects
  const resolvedPath = resolve(resolvedPathForChildStack);
  const buildStack = parentBuildStack
    ? new Set(parentBuildStack)
    : new Set<string>();
  buildStack.add(resolvedPath);

  for (const [name, entity] of discoveryResult.entities) {
    if (isChildProject(entity)) {
      const childPath = resolve(entity.projectPath);
      if (buildStack.has(childPath)) {
        errors.push(
          new BuildErrorClass(
            childPath,
            `Circular nested stack: ${[...buildStack].join(" → ")} → ${childPath}`,
          ),
        );
        continue;
      }
      const childResult = await build(childPath, serializers, buildStack, options);
      entity.buildResult = childResult;
      if (childResult.errors.length > 0) {
        for (const err of childResult.errors) {
          errors.push(err);
        }
      }
    }
  }

  // Step 4b (#1548 piece 3): lexicon-contributed build roots — rendered
  // non-source roots (kustomize dirs) joining the entity set before
  // partitioning, so everything downstream (serialization with ownership
  // stamping, post-synth checks, observation) treats them as declared.
  // Top-level build only: nested child builds receive the same options
  // object, and re-running the contributors there would duplicate every
  // contributed entity once per child.
  if (!parentBuildStack && options?.buildRoots) {
    const merged = await mergeBuildRootEntities(discoveryResult.entities, options.buildRoots);
    warnings.push(...merged.warnings);
    for (const message of merged.errors) {
      errors.push(new BuildErrorClass("", message));
    }
  }

  // Step 5: Partition entities by lexicon
  const partitions = partitionByLexicon(discoveryResult.entities);

  // Build a serializer lookup by name
  const serializersByName = new Map<string, Serializer>();
  for (const serializer of serializers) {
    serializersByName.set(serializer.name, serializer);
  }

  // Step 6: Collect explicit LexiconOutputs from all entities
  const explicitOutputs = collectLexiconOutputs(discoveryResult.entities);

  // Step 6b: Auto-detect cross-lexicon AttrRefs
  const autoOutputs = detectCrossLexiconRefs(discoveryResult.entities);

  // Merge: explicit outputs take precedence over auto-detected ones.
  // Match by parent object identity + attribute to detect collisions.
  const explicitRefs = explicitOutputs.map((o) => ({
    parent: o._sourceParent?.deref(),
    attribute: o.sourceAttribute,
  }));
  const lexiconOutputs = [
    ...explicitOutputs,
    ...autoOutputs.filter((auto) => {
      const autoParent = auto._sourceParent?.deref();
      return !explicitRefs.some(
        (e) => e.parent === autoParent && e.attribute === auto.sourceAttribute
      );
    }),
  ];

  // Group outputs by source lexicon.
  // Intrinsic-based outputs (sourceLexicon === "") have no source entity to derive a lexicon from,
  // so they are included in every lexicon's output list.
  const outputsByLexicon = new Map<string, LexiconOutput[]>();
  const unassignedOutputs: LexiconOutput[] = [];
  for (const output of lexiconOutputs) {
    if (!output.sourceLexicon) {
      unassignedOutputs.push(output);
      continue;
    }
    if (!outputsByLexicon.has(output.sourceLexicon)) {
      outputsByLexicon.set(output.sourceLexicon, []);
    }
    outputsByLexicon.get(output.sourceLexicon)!.push(output);
  }

  // Step 7: Serialize each lexicon's entities
  const outputs = new Map<string, string | SerializerResult>();
  for (const [lexiconName, lexiconEntities] of partitions) {
    const serializer = serializersByName.get(lexiconName);
    // #1832: effect receipts are withheld from the apply-bound entity set at
    // this seam — the narrowest choke point every applier's input flows
    // through, since appliers consume the serialized outputs assembled here.
    // Receipts ride `SerializeContext.receipts` instead, so a lexicon can
    // render them for visibility (#1835) without them ever entering the
    // document an applier writes (or prunes) from. The `effect()` step is the
    // sole receipt writer (epic #1703, decision 3).
    const { applyBound, receipts } = splitReceiptEntities(lexiconEntities);
    if (serializer) {
      const lexiconLexiconOutputs = [
        ...(outputsByLexicon.get(lexiconName) ?? []),
        ...unassignedOutputs,
      ];
      const serialized = serializer.serialize(applyBound, lexiconLexiconOutputs, {
        ownership: options?.ownership,
        config: options?.config,
        ...(receipts.size > 0 ? { receipts } : {}),
      });
      // Collect any non-fatal serializer diagnostics into the build warnings.
      if (typeof serialized !== "string" && serialized.warnings) {
        for (const w of serialized.warnings) warnings.push(w);
      }
      outputs.set(lexiconName, serialized);
    } else if (applyBound.size === 0 && receipts.size > 0) {
      // A partition holding only receipts (the core factory's "chant"
      // pseudo-lexicon) has nothing apply-bound to serialize; that is the
      // designed shape until a lexicon materializes the receipt (#1835), not
      // a missing-serializer problem.
    } else {
      warnings.push(`No serializer found for lexicon "${lexiconName}"`);
    }
  }

  // Step 8: Generate manifest
  const lexiconNames = Array.from(partitions.keys());
  const manifest = generateManifest(lexiconNames, lexiconOutputs, discoveryResult.entities);

  return {
    outputs,
    entities: discoveryResult.entities,
    dependencies: discoveryResult.dependencies,
    warnings,
    errors,
    manifest,
    sourceFileCount: discoveryResult.sourceFiles.length,
    foldDecisions: discoveryResult.foldDecisions,
    lexiconVersions: { ...(options?.lexiconVersions ?? {}) },
    buildParams: options?.buildParams ?? [],
  };
}

/**
 * chant #1045 (Phase 1) — build directly from a JSON-encoded discovery
 * result (see {@link discoverEntitySetJson} in `./discovery/entity-wire.ts`)
 * instead of pointing `build()` at a directory.
 *
 * Decodes the wire entity set back into a live entities map — see
 * `decodeEntitySet`'s doc for why the decoded entities are functionally
 * indistinguishable from what `discover()` produces in-process (real
 * `AttrRef` instances, whole-entity identity preserved by reference, not by
 * clone) — then runs the exact same post-discovery pipeline `build()` uses
 * ({@link buildFromDiscoveryResult}), so partitioning, output detection,
 * serialization, and the manifest are the SAME code path, not a fork of it.
 *
 * Dependencies aren't part of the wire format: unlike entities, a dependency
 * graph is plain name-to-name data with no identity problem, so it's cheaper
 * and more honest to recompute it from the decoded entities via the same
 * `buildDependencyGraph()` `discover()` itself uses than to carry a second,
 * redundant wire shape across the boundary.
 *
 * @param label - Used only to seed circular-nested-stack detection; a JSON
 *   entity set has no single source directory the way a `build(path, …)`
 *   call does. Inert today — child projects (`nestedStack()`) aren't
 *   supported by the JSON boundary yet (see `discovery/entity-wire.ts`).
 */
export async function buildFromEntitiesJson(
  json: DiscoveredEntitiesJson,
  serializers: Serializer[],
  label = "<json-entity-set>",
  parentBuildStack?: Set<string>,
  options?: BuildOptions,
): Promise<BuildResult> {
  const entities = decodeEntitySet(json.entitySet);
  const dependencies = buildDependencyGraph(entities);
  const errors: DiscoveryError[] = json.errors.map(
    (e) => new DiscoveryError(e.file, e.message, e.type as DiscoveryErrorType),
  );

  const discoveryResult: DiscoveryResult = {
    entities,
    dependencies,
    sourceFiles: json.sourceFiles,
    errors,
    foldDecisions: json.foldDecisions,
  };

  return buildFromDiscoveryResult(discoveryResult, label, serializers, parentBuildStack, options);
}
