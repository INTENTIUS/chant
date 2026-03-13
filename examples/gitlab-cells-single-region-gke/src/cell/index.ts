import { createCell } from "./factory";
import { cells } from "../config";

const _cells = cells.map(c => createCell(c));

// Flatten cell factory results into separate resource arrays so the
// chant discovery system can find each resource type independently.
export const cellNamespaces = _cells.map(c => c.namespace);
export const cellResourceQuotas = _cells.map(c => c.resourceQuota);
export const cellLimitRanges = _cells.map(c => c.limitRange);
export const cellDefaultDenyPolicies = _cells.map(c => c.defaultDeny);
export const cellAllowSameNamespacePolicies = _cells.map(c => c.allowSameNamespace);
export const cellAllowIngressFromSystemPolicies = _cells.map(c => c.allowIngressFromSystem);
export const cellAllowEgressPolicies = _cells.map(c => c.allowEgress);
export const cellExternalSecrets = _cells.flatMap(c => c.externalSecrets);
export const cellRegistryStorageSecrets = _cells.map(c => c.registryStorageSecret);
export const cellK8sServiceAccounts = _cells.map(c => c.serviceAccount);
export const cellRunnerServiceAccounts = _cells.map(c => c.runnerServiceAccount);
export const cellRunnerConfigs = _cells.map(c => c.runnerConfig);
export const cellRunnerDeployments = _cells.map(c => c.runnerDeployment);
export const cellRunnerEgressPolicies = _cells.map(c => c.runnerAllowEgressToSystem);
