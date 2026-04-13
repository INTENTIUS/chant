/**
 * Temporal infrastructure — namespace + search attributes.
 *
 * Build: npm run build:temporal  →  dist/temporal-setup.sh
 * Apply: npm run temporal:setup  →  registers namespace + search attrs in Temporal Cloud
 *
 * Why this is in chant source (not a README step):
 *   • Namespace configuration is version-controlled and PR-reviewable
 *   • Repeatable setup across environments (no manual Temporal Cloud UI steps)
 *   • TypeScript enforces the shape — a misspelled retention period is a lint error
 */

import { TemporalCloudStack } from "@intentius/chant-lexicon-temporal";

export const { ns, searchAttributes } = TemporalCloudStack({
  namespace: "crdb-deploy",
  retention: "30d",
  description: "CockroachDB multi-region deployment orchestration namespace",
  searchAttributes: [
    // GCP context — filterable from the Temporal Cloud UI workflow list
    { name: "GcpProject",   type: "Keyword" },
    { name: "CrdbDomain",   type: "Keyword" },
    // Deployment progress — updated by the workflow at each phase transition
    // Filter: "show me all workflows currently in WAIT_DNS_DELEGATION"
    { name: "DeployPhase",  type: "Keyword" },
    // Active region — updated during parallel regional deploys
    // Filter: "show me all workflows currently deploying the east region"
    { name: "DeployRegion", type: "Keyword" },
  ],
});
