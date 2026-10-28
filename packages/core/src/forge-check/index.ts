/**
 * chant#4608: the forge and trust-policy check in CI core, shared by
 * terragucci (`terragucci forge check`) and plywood (`plywood forge check`),
 * and run as `chant ci forge-check`.
 *
 * It reads the live forge and cloud setup against a contract of jobs and
 * identities (./contract.ts): each apply job's forge environment, runner
 * groups and GitLab protected runners and variables, branch protection and
 * required statuses, each AWS role's trust policy, each GCP workload
 * identity provider's condition, each Azure app's federated credentials,
 * and each Pulumi Cloud organization's OIDC issuer and its policies.
 * Read-only: every call goes through ./read-only.ts.
 *
 * Lifted from terragucci's `packages/terragucci/src/forge-check.ts`, which
 * terragucci#1282 deletes once it calls this.
 */

export * from "./types";
export * from "./contract";
export { assertReadOnly, readOnly, ReadOnlyError, READ_ACTIONS } from "./read-only";
export { read, readRepository, githubRows, gitlabRows, forgejoRows, statusReportedRows } from "./forge";
export {
  awsCredentials,
  awsRows,
  awsTrustPolicy,
  trustJobs,
  trustJob,
  issuerKey,
  compareTrust,
  rolesOf,
  gcpCondition,
  celTerms,
  celNarrowerOrEqual,
  gcpRows,
  federatedCredential,
  azureRows,
  AZURE_GRAPH_TOKEN_ENV,
  type TrustJob,
  type LiveValue,
  type FederatedCredential,
} from "./trust";
export { pulumiRows, policyGrants, PULUMI_TOKEN_ENV } from "./pulumi";
export { forgeCheck, forgeCheckExit, describeForgeCheck, countRows, forgeCheckCommand, forgeCheckSchema, forgeCheckTarget, uncheckedClouds, ForgeCheckTargetError, type ForgeCheckInput } from "./check";
