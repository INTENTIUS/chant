import type { Declarable } from "./declarable";
import type { Serializer, SerializerResult } from "./serializer";
import type { DiscoveryError, BuildError } from "./errors";
import { BuildError as BuildErrorClass } from "./errors";
import { LexiconOutput, isLexiconOutput } from "./lexicon-output";
import { AttrRef } from "./attrref";
import { isChildProject, type ChildProjectInstance } from "./child-project";
import { discover } from "./discovery/index";
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
}

/**
 * Result of the build process
 */
export interface BuildResult {
  /** Map of lexicon name to serialized output (string or multi-file result) */
  outputs: Map<string, string | SerializerResult>;
  /** Map of entity name to Declarable entity */
  entities: Map<string, Declarable>;
  /** Array of warnings encountered during the build */
  warnings: string[];
  /** Array of errors encountered during discovery and build */
  errors: Array<DiscoveryError | BuildError>;
  /** Build manifest with cross-lexicon dependency info */
  manifest: BuildManifest;
  /** Number of source files processed */
  sourceFileCount: number;
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
      // Resolve source entity name from the WeakRef parent identity
      const parent = lexiconOutput._sourceParent.deref();
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
      outputs.push(lexiconOutput);
      continue;
    }

    if ("props" in entity && typeof entity.props === "object" && entity.props !== null) {
      // Set source entity name for any LexiconOutputs found in props
      const prevLength = outputs.length;
      walk(entity.props);
      for (let i = prevLength; i < outputs.length; i++) {
        if (!outputs[i].sourceEntity) {
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

    if (value instanceof AttrRef) {
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
  lexiconOutputs: LexiconOutput[]
): BuildManifest {
  const outputsRecord: Record<
    string,
    { source: string; entity: string; attribute: string }
  > = {};

  for (const output of lexiconOutputs) {
    outputsRecord[output.outputName] = {
      source: output.sourceLexicon,
      entity: output.sourceEntity,
      attribute: output.sourceAttribute,
    };
  }

  return {
    lexicons: lexiconNames,
    outputs: outputsRecord,
    deployOrder: computeDeployOrder(lexiconNames, lexiconOutputs),
  };
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
): Promise<BuildResult> {
  const warnings: string[] = [];
  const errors: Array<DiscoveryError | BuildError> = [];

  // Step 1: Discover entities and dependencies
  const discoveryResult = await discover(path);

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
  const resolvedPath = resolve(path);
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
      const childResult = await build(childPath, serializers, buildStack);
      entity.buildResult = childResult;
      if (childResult.errors.length > 0) {
        for (const err of childResult.errors) {
          errors.push(err);
        }
      }
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
    parent: o._sourceParent.deref(),
    attribute: o.sourceAttribute,
  }));
  const lexiconOutputs = [
    ...explicitOutputs,
    ...autoOutputs.filter((auto) => {
      const autoParent = auto._sourceParent.deref();
      return !explicitRefs.some(
        (e) => e.parent === autoParent && e.attribute === auto.sourceAttribute
      );
    }),
  ];

  // Group outputs by source lexicon
  const outputsByLexicon = new Map<string, LexiconOutput[]>();
  for (const output of lexiconOutputs) {
    if (!outputsByLexicon.has(output.sourceLexicon)) {
      outputsByLexicon.set(output.sourceLexicon, []);
    }
    outputsByLexicon.get(output.sourceLexicon)!.push(output);
  }

  // Step 7: Serialize each lexicon's entities
  const outputs = new Map<string, string | SerializerResult>();
  for (const [lexiconName, lexiconEntities] of partitions) {
    const serializer = serializersByName.get(lexiconName);
    if (serializer) {
      const lexiconLexiconOutputs = outputsByLexicon.get(lexiconName) ?? [];
      outputs.set(lexiconName, serializer.serialize(lexiconEntities, lexiconLexiconOutputs));
    } else {
      warnings.push(`No serializer found for lexicon "${lexiconName}"`);
    }
  }

  // Step 8: Generate manifest
  const lexiconNames = Array.from(partitions.keys());
  const manifest = generateManifest(lexiconNames, lexiconOutputs);

  return {
    outputs,
    entities: discoveryResult.entities,
    warnings,
    errors,
    manifest,
    sourceFileCount: discoveryResult.sourceFiles.length,
  };
}
