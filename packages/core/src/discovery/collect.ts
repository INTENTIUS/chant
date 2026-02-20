import { isDeclarable, type Declarable } from "../declarable";
import { isCompositeInstance, expandComposite } from "../composite";
import { isLexiconOutput } from "../lexicon-output";
import { DiscoveryError } from "../errors";

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
    for (const [name, value] of Object.entries(exports)) {
      if (isDeclarable(value)) {
        if (entities.has(name)) {
          // Same object re-exported from multiple files (e.g. barrel re-exports) is fine
          if (entities.get(name) !== value) {
            throw new DiscoveryError(
              file,
              `Duplicate export name "${name}" found`,
              "resolution"
            );
          }
        } else {
          entities.set(name, value);
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
