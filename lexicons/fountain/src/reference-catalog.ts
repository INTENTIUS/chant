import type { ReferenceCatalog } from "@intentius/chant/lexicon";

/**
 * Fountain reference catalog — how observed fountain resources reference
 * each other, so `chant graph --live` reconstructs the topology.
 *
 * One relationship matters: an Agent runs in an Environment
 * (`environment_id`). `describeResources` puts `environment_id` in the
 * agent's observed attributes and indexes environments by `id` (their
 * physicalId), so the edge resolves with no enrichment pass.
 *
 * Vaults are deliberately edge-free here: vault↔agent binding is a
 * conversation-time choice (scoped by `allowed_vault_ids`), not standing
 * topology.
 */
export const fountainReferenceCatalog: ReferenceCatalog = {
  identities: [{ kind: "Fountain::V1::Environment", ids: ["id"] }],
  refs: [
    {
      from: "Fountain::V1::Agent",
      path: "environment_id",
      targetKind: "Fountain::V1::Environment",
      relation: "reference",
      label: "environment",
    },
  ],
};
