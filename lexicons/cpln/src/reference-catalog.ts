/**
 * How observed cpln resources reference each other, so `chant graph --live` can
 * rebuild the topology from a bag of nodes.
 *
 * Control Plane addresses resources by **link string**
 * (`//gvc/prod/identity/api`), and edge reconstruction matches identifiers
 * exactly, so a raw link never equals the `name` it points at. Rather than add
 * an enrichment pass, `describeResources` resolves each link down to the bare
 * name it ends in and files it under a stable attribute — `refs.identity`,
 * `refs.gvc`, `refs.pullSecrets` — and the rules below read those. See
 * {@link referenceAttributes} in `describe-resources.ts`.
 *
 * Names are unique per kind within an org (per GVC for the GVC-scoped kinds),
 * so `name` is the identity for every kind and `targetKind` disambiguates the
 * cases where two kinds could hold the same name.
 *
 * Containment vs reference matters for the picture: "this workload is in this
 * GVC" is a boundary the renderer draws as a box, not a line from every
 * resource to its GVC. It still declares `viaAttr` so a traversal can walk it —
 * "which GVCs have no workloads" is a containment question.
 */

import type { ReferenceCatalog } from "@intentius/chant/lexicon";
import { KINDS, kindByName } from "./kinds";

const typeOf = (kind: string): string => kindByName(kind)!.typeName;

export const cplnReferenceCatalog: ReferenceCatalog = {
  identities: KINDS.map((kind) => ({ kind: kind.typeName, ids: ["name"] })),

  refs: [
    // Every GVC-scoped resource lives inside its GVC — a boundary, not a line.
    ...KINDS.filter((kind) => kind.gvcScoped).map((kind) => ({
      from: kind.typeName,
      path: "refs.gvc",
      targetKind: typeOf("gvc"),
      relation: "containment" as const,
      label: "in GVC",
      viaAttr: "gvc",
    })),

    // A workload runs as one identity.
    {
      from: typeOf("workload"),
      path: "refs.identity",
      targetKind: typeOf("identity"),
      relation: "reference",
      label: "identity",
      viaAttr: "identityLink",
    },

    // A GVC pulls private images with org-scoped secrets.
    {
      from: typeOf("gvc"),
      path: "refs.pullSecrets[]",
      targetKind: typeOf("secret"),
      relation: "reference",
      label: "pull secret",
      viaAttr: "pullSecretLinks",
    },

    // A domain routes into a GVC, or straight at a stateful workload.
    {
      from: typeOf("domain"),
      path: "refs.gvc",
      targetKind: typeOf("gvc"),
      relation: "reference",
      label: "routes to",
      viaAttr: "gvcLink",
    },
    {
      from: typeOf("domain"),
      path: "refs.workloads[]",
      targetKind: typeOf("workload"),
      relation: "reference",
      label: "routes to",
      viaAttr: "workloadLink",
    },

    // A policy's explicit target links.
    {
      from: typeOf("policy"),
      path: "refs.targets[]",
      targetKind: typeOf("secret"),
      relation: "reference",
      label: "grants on",
      viaAttr: "targetLinks",
    },

    // An IP set fronts the workload it is bound to.
    {
      from: typeOf("ipset"),
      path: "refs.workloads[]",
      targetKind: typeOf("workload"),
      relation: "reference",
      label: "fronts",
      viaAttr: "link",
    },

    // A workload mounts volume sets.
    {
      from: typeOf("workload"),
      path: "refs.volumeSets[]",
      targetKind: typeOf("volumeset"),
      relation: "reference",
      label: "mounts",
      viaAttr: "volumes",
    },
  ],
};
