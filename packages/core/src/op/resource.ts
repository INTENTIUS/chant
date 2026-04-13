import { createResource } from "../runtime";

/**
 * The Declarable resource backing an Op definition.
 * entityType: "Temporal::Op", lexicon: "temporal"
 * Discovered automatically alongside infra files — no pipeline changes needed.
 */
export const OpResource = createResource("Temporal::Op", "temporal", {});
