import type { ChantConfig } from "@intentius/chant";

// `ownership.stack` turns on cloud-side ownership marking: the AWS serializer
// stamps a chant marker (tags `chant:managed-by` / `chant:stack` / `chant:env`)
// onto every supported resource. That marker is what lets ReconcileOp/ApplyOp
// scope deletes to chant-owned resources only — a foreign resource is never
// auto-deleted.
export default {
  lexicons: ["aws", "temporal"],
  environments: ["prod"],
  ownership: { stack: "lifecycle-reconcile-aws", env: "prod" },
} satisfies ChantConfig;
