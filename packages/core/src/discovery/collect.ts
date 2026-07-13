import { basename } from "node:path";
import { isDeclarable, type Declarable } from "../declarable";
import { isCompositeInstance, expandComposite } from "../composite";
import { isLexiconOutput } from "../lexicon-output";
import { DiscoveryError } from "../errors";
import { setProvenance } from "../provenance";

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
 * Collects all declarable entities from imported modules.
 * CompositeInstance exports are expanded into individual entities
 * with `{exportName}_{memberName}` naming.
 * LexiconOutput exports are also collected so that build() can
 * extract them and pass them to the serializer.
 *
 * @param modules - Array of module records with their exports
 * @returns Map of export name to Declarable entity
 * @throws {DiscoveryError} with type "resolution" if duplicate export names are found
 */
export function collectEntities(
  modules: Array<{ file: string; exports: Record<string, unknown> }>
): Map<string, Declarable> {
  const entities = new Map<string, Declarable>();

  for (const { file, exports } of modules) {
    for (const [rawName, value] of Object.entries(exports)) {
      const name = exportKey(rawName, file);
      if (isDeclarable(value)) {
        if (entities.has(name)) {
          // Same object re-exported from multiple files (e.g. re-exports from multiple files) is fine
          if (entities.get(name) !== value) {
            throw new DiscoveryError(
              file,
              `Duplicate export name "${name}" found`,
              "resolution"
            );
          }
        } else {
          setProvenance(value, { sourceFile: file });
          entities.set(name, value);
        }
      } else if (Array.isArray(value)) {
        // Arrays of Declarables or CompositeInstances — each element gets an indexed name: exportName_0, ...
        for (let i = 0; i < value.length; i++) {
          const item = value[i];
          if (isDeclarable(item)) {
            const indexedName = `${name}_${i}`;
            if (entities.has(indexedName) && entities.get(indexedName) !== item) {
              throw new DiscoveryError(file, `Duplicate entity name "${indexedName}"`, "resolution");
            }
            setProvenance(item, { sourceFile: file });
            entities.set(indexedName, item);
          } else if (isCompositeInstance(item)) {
            const indexedName = `${name}_${i}`;
            const expanded = expandComposite(indexedName, item);
            for (const [expandedName, entity] of expanded) {
              if (entities.has(expandedName)) {
                throw new DiscoveryError(
                  file,
                  `Duplicate entity name "${expandedName}" from composite expansion of "${indexedName}"`,
                  "resolution",
                );
              }
              setProvenance(entity, { sourceFile: file, compositeInstance: indexedName });
              entities.set(expandedName, entity);
            }
          }
        }
      } else if (isCompositeInstance(value)) {
        const expanded = expandComposite(name, value);
        for (const [expandedName, entity] of expanded) {
          if (entities.has(expandedName)) {
            throw new DiscoveryError(
              file,
              `Duplicate entity name "${expandedName}" from composite expansion of "${name}"`,
              "resolution",
            );
          }
          setProvenance(entity, { sourceFile: file, compositeInstance: name });
          entities.set(expandedName, entity);
        }
      } else if (isLexiconOutput(value)) {
        // LexiconOutput is not a Declarable but build() expects to find them
        // in the entities map so it can collect and pass them to serializers
        entities.set(name, value as unknown as Declarable);
      }
    }
  }

  return entities;
}
