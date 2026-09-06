import { createResource } from "../runtime";

/**
 * The Declarable resource backing an Op definition.
 * entityType: "Chant::Op", lexicon: "chant"
 * Discovered automatically alongside infra files — no pipeline changes needed.
 *
 * An Op is chant's own verb, not a runtime's (#2118, epic #2114): the model,
 * the executor and the ledger all live in core, and a lexicon that hosts runs
 * is one runtime among several. The entity type says so.
 */
export const OP_ENTITY_TYPE = "Chant::Op";

export const OpResource = createResource(OP_ENTITY_TYPE, "chant", {});

/**
 * Is this entity an Op declaration?
 *
 * Duck-typed on `entityType` rather than `instanceof OpResource` for the same
 * reason `../build.ts`'s dependency inference is: an entity can be built
 * against a different copy of core (a linked lexicon, a child project) and
 * still be the same declaration.
 */
export function isOpEntity(entity: unknown): boolean {
  return (entity as { entityType?: string } | null)?.entityType === OP_ENTITY_TYPE;
}
