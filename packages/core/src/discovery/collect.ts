import { basename, dirname, relative, resolve } from "node:path";
import { isDeclarable, type Declarable } from "../declarable";
import { isCompositeInstance, expandComposite } from "../composite";
import { isLexiconOutput } from "../lexicon-output";
import { DiscoveryError } from "../errors";
import { setProvenance, type EntityProvenance } from "../provenance";

/**
 * The entity key for an export. `export default` is per-module — the `Op` pattern
 * (`export default op`) uses it, and two op files must not collide on the literal
 * name "default". Key a default export by the file's basename so distinct files
 * stay distinct; named exports keep their name. (Serializers that care about the
 * declared name — e.g. the Op serializer — read it from the entity, not this key.)
 */
function exportKey(rawName: string, file: string): string {
  if (rawName !== "default") return rawName;
  return basename(file).replace(/\.ts$/, "").replace(/\.op$/, "");
}

/**
 * A stable, CloudFormation-valid prefix identifying the stack directory a file
 * belongs to, relative to the build root. Used to disambiguate an entity name
 * that legitimately repeats across sibling stack directories (see
 * {@link collectEntities}). Derived from the path *relative to the build root*
 * (not the absolute path) so the resulting key — and therefore any build digest
 * that hashes it — is portable across machines and checkouts. Punctuation
 * (`/`, `-`, `.`) is dropped and each segment PascalCased, keeping the key
 * within CloudFormation's `^[A-Za-z0-9]+$` logical-id grammar.
 */
function stackPrefix(file: string, buildRoot: string | undefined): string {
  const dir = dirname(file);
  const rel = buildRoot ? relative(resolve(buildRoot), resolve(dir)) : dir;
  const segments = rel.split(/[^A-Za-z0-9]+/).filter((s) => s.length > 0);
  return segments.map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join("");
}

/** One entity to be placed into the map, produced by {@link enumerateEntries}. */
interface PendingEntry {
  /** The un-disambiguated map key this entity would take (export name, indexed
   * array name, or composite-expanded member name). */
  bareKey: string;
  value: Declarable;
  file: string;
  provenance: EntityProvenance;
}

/**
 * Flatten every module's exports into the ordered list of entities they
 * contribute — declarables directly, arrays element-by-element (indexed names),
 * composite instances expanded into members, and LexiconOutputs. `modules`
 * order (one discovered file after another) is preserved so downstream
 * serializers emit resources in a stable, file-discovery-order sequence.
 *
 * Within one module, exports are visited in ascending name order rather than
 * `Object.entries()`'s own — a real ECMAScript Module namespace object
 * already enumerates its (non-default) string keys this way per spec
 * (`[[OwnPropertyKeys]]`, sorted), regardless of source declaration order;
 * sorting here just makes that the case EXPLICITLY, so this doesn't quietly
 * depend on whichever loader imported the file preserving (or not) that spec
 * behavior — chant #1045 Phase 2 found `vite-node` (vitest's own in-process
 * transform) does NOT sort, unlike plain Node, which made comparing an
 * in-process build against a real-subprocess one (its differential's whole
 * point) spuriously "drift" on multi-export-per-file modules whenever the
 * in-process side ran under vitest.
 */
function enumerateEntries(
  modules: Array<{ file: string; exports: Record<string, unknown> }>,
): PendingEntry[] {
  const entries: PendingEntry[] = [];

  for (const { file, exports } of modules) {
    const sortedExports = Object.entries(exports).sort(([a], [b]) => a.localeCompare(b));
    for (const [rawName, value] of sortedExports) {
      const name = exportKey(rawName, file);
      if (isDeclarable(value)) {
        entries.push({ bareKey: name, value, file, provenance: { sourceFile: file } });
      } else if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          const item = value[i];
          if (isDeclarable(item)) {
            entries.push({ bareKey: `${name}_${i}`, value: item, file, provenance: { sourceFile: file } });
          } else if (isCompositeInstance(item)) {
            const indexedName = `${name}_${i}`;
            for (const [expandedName, entity] of expandComposite(indexedName, item)) {
              entries.push({
                bareKey: expandedName,
                value: entity,
                file,
                provenance: { sourceFile: file, compositeInstance: indexedName },
              });
            }
          }
        }
      } else if (isCompositeInstance(value)) {
        for (const [expandedName, entity] of expandComposite(name, value)) {
          entries.push({
            bareKey: expandedName,
            value: entity,
            file,
            provenance: { sourceFile: file, compositeInstance: name },
          });
        }
      } else if (isLexiconOutput(value)) {
        // LexiconOutput is not a Declarable but build() expects to find them in
        // the entities map so it can collect and pass them to serializers.
        entries.push({ bareKey: name, value: value as unknown as Declarable, file, provenance: { sourceFile: file } });
      }
    }
  }

  return entries;
}

/**
 * Collects all declarable entities from imported modules.
 * CompositeInstance exports are expanded into individual entities
 * with `{exportName}_{memberName}` naming.
 * LexiconOutput exports are also collected so that build() can
 * extract them and pass them to the serializer.
 *
 * A bare entity name must be unique *within a single stack directory*, not
 * across the whole project. A multi-stack project (independently-deployed
 * sibling stacks under one root — e.g. `src/loom-backend/`, `src/loom-agents/`)
 * legitimately reuses conventional cross-stack `Parameter` names like
 * `pArtifactBucket`/`pImageUri` across siblings, because each directory is its
 * own CloudFormation template where that name is the real, deployed logical id.
 * When the same bare name is declared (as distinct objects) in two different
 * directories, each is disambiguated by a stack prefix derived from its
 * directory ({@link stackPrefix}) rather than throwing — so an unscoped
 * whole-project build / `chant lifecycle snapshot|diff` no longer collides
 * (#932). A per-stack scoped build (`chant build <dir>`) has a single directory
 * relative to its root, so nothing is prefixed and the deployed logical ids are
 * unchanged. A genuine *same-directory* duplicate is still an error.
 *
 * @param modules - Array of module records with their exports
 * @param buildRoot - The build root the discovery ran against; stack prefixes
 *   are derived relative to it so keys stay portable across machines.
 * @returns Map of export name to Declarable entity
 * @throws {DiscoveryError} with type "resolution" if a name is duplicated within one directory
 */
export function collectEntities(
  modules: Array<{ file: string; exports: Record<string, unknown> }>,
  buildRoot?: string,
): Map<string, Declarable> {
  const entries = enumerateEntries(modules);

  // Which bare keys collide across more than one directory (as distinct
  // objects)? Those — and only those — get a stack prefix. A bare key that
  // resolves to a single object (even one re-exported from several files) keeps
  // its raw name, so single-stack projects are unaffected.
  const dirsByKey = new Map<string, Map<string, Set<Declarable>>>();
  for (const { bareKey, value, file } of entries) {
    const dir = dirname(file);
    let byDir = dirsByKey.get(bareKey);
    if (!byDir) {
      byDir = new Map();
      dirsByKey.set(bareKey, byDir);
    }
    let objs = byDir.get(dir);
    if (!objs) {
      objs = new Set();
      byDir.set(dir, objs);
    }
    objs.add(value);
  }
  const crossDirKeys = new Set<string>();
  for (const [bareKey, byDir] of dirsByKey) {
    const dirsWithObjects = [...byDir.values()].filter((objs) => objs.size > 0).length;
    const distinctObjects = new Set<Declarable>();
    for (const objs of byDir.values()) for (const o of objs) distinctObjects.add(o);
    if (dirsWithObjects > 1 && distinctObjects.size > 1) crossDirKeys.add(bareKey);
  }

  const entities = new Map<string, Declarable>();
  // Per bare key, the object already claimed for each directory — a second,
  // *different* object in the same directory is a genuine duplicate.
  const claimedByDir = new Map<string, Map<string, Declarable>>();

  for (const { bareKey, value, file, provenance } of entries) {
    const dir = dirname(file);
    let perDir = claimedByDir.get(bareKey);
    if (!perDir) {
      perDir = new Map();
      claimedByDir.set(bareKey, perDir);
    }
    const claimed = perDir.get(dir);
    if (claimed !== undefined && claimed !== value) {
      // Same name, same directory, different object → a real collision.
      throw new DiscoveryError(file, `Duplicate export name "${bareKey}" found`, "resolution");
    }
    perDir.set(dir, value);

    const key = crossDirKeys.has(bareKey) ? `${stackPrefix(file, buildRoot)}${bareKey}` : bareKey;
    const existing = entities.get(key);
    if (existing !== undefined) {
      // Same object re-exported (possibly from multiple files) is fine; a
      // different object landing on the same disambiguated key would only
      // happen if two directories produced an identical stack prefix.
      if (existing !== value) {
        throw new DiscoveryError(file, `Duplicate export name "${bareKey}" found`, "resolution");
      }
      continue;
    }
    setProvenance(value, provenance);
    entities.set(key, value);
  }

  return entities;
}
