/**
 * Prior art for these audit rules: the open-source tools whose checks cover the
 * same condition, credited per rule. See packages/core/src/audit/prior-art.ts for
 * the registry, the relation vocabulary, and why this is credit rather than
 * authority. Kept by hand; the prior-art sweep (scripts/prior-art-sweep.ts) reports
 * when a credited tool's index no longer lists a rule cited here.
 */
import type { Lineage } from "@intentius/chant/audit/catalog";

export const azureAuditLineage: Record<string, Lineage[]> = {
  AZR010: [
    { tool: "bicep-linter", rule: "no-unnecessary-dependson", url: "https://learn.microsoft.com/en-us/azure/azure-resource-manager/bicep/linter-rule-no-unnecessary-dependson", relation: "equivalent" },
  ],
  AZR011: [
    { tool: "arm-ttk", rule: "apiVersions-Should-Be-Recent", url: "https://github.com/Azure/arm-ttk/blob/master/arm-ttk/testcases/deploymentTemplate/apiVersions-Should-Be-Recent.test.ps1", relation: "overlaps" },
  ],
  AZR012: [
    { tool: "arm-ttk", rule: "apiVersions-Should-Be-Recent", url: "https://github.com/Azure/arm-ttk/blob/master/arm-ttk/testcases/deploymentTemplate/apiVersions-Should-Be-Recent.test.ps1", relation: "overlaps" },
    { tool: "bicep-linter", rule: "use-recent-api-versions", url: "https://learn.microsoft.com/en-us/azure/azure-resource-manager/bicep/linter-rule-use-recent-api-versions", relation: "overlaps" },
  ],
  AZR014: [
    { tool: "psrule-azure", rule: "Azure.Storage.BlobPublicAccess", url: "https://azure.github.io/PSRule.Rules.Azure/en/rules/Azure.Storage.BlobPublicAccess/", relation: "equivalent" },
    { tool: "checkov", rule: "CKV_AZURE_59", url: "https://www.checkov.io/5.Policy%20Index/arm.html", relation: "equivalent" },
  ],
  AZR016: [
    { tool: "psrule-azure", rule: "Azure.KeyVault.SoftDelete", url: "https://azure.github.io/PSRule.Rules.Azure/en/rules/Azure.KeyVault.SoftDelete/", relation: "equivalent" },
    { tool: "checkov", rule: "CKV_AZURE_111", url: "https://www.checkov.io/5.Policy%20Index/arm.html", relation: "equivalent" },
    { tool: "kics", rule: "Key Vault Not Recoverable", url: "https://docs.kics.io/latest/queries/azureresourcemanager-queries/azure/7c25f361-7c66-44bf-9b69-022acd5eb4bd/", relation: "overlaps" },
  ],
  AZR017: [
    { tool: "psrule-azure", rule: "Azure.KeyVault.PurgeProtect", url: "https://azure.github.io/PSRule.Rules.Azure/en/rules/Azure.KeyVault.PurgeProtect/", relation: "equivalent" },
    { tool: "checkov", rule: "CKV_AZURE_110", url: "https://www.checkov.io/5.Policy%20Index/arm.html", relation: "equivalent" },
    { tool: "kics", rule: "Key Vault Not Recoverable", url: "https://docs.kics.io/latest/queries/azureresourcemanager-queries/azure/7c25f361-7c66-44bf-9b69-022acd5eb4bd/", relation: "overlaps" },
  ],
  AZR018: [
    { tool: "psrule-azure", rule: "Azure.SQL.Auditing", url: "https://azure.github.io/PSRule.Rules.Azure/en/rules/Azure.SQL.Auditing/", relation: "equivalent" },
    { tool: "checkov", rule: "CKV_AZURE_23", url: "https://www.checkov.io/5.Policy%20Index/arm.html", relation: "equivalent" },
    { tool: "kics", rule: "SQL Server Database Without Auditing", url: "https://docs.kics.io/latest/queries/azureresourcemanager-queries/azure/e055285c-bc01-48b4-8aa5-8a54acdd29df/", relation: "equivalent" },
  ],
  AZR019: [
    { tool: "psrule-azure", rule: "Azure.SQL.TDE", url: "https://azure.github.io/PSRule.Rules.Azure/en/rules/Azure.SQL.TDE/", relation: "equivalent" },
  ],
  AZR020: [
    { tool: "psrule-azure", rule: "Azure.AppService.ManagedIdentity", url: "https://azure.github.io/PSRule.Rules.Azure/en/rules/Azure.AppService.ManagedIdentity/", relation: "equivalent" },
    { tool: "checkov", rule: "CKV_AZURE_71", url: "https://www.checkov.io/5.Policy%20Index/arm.html", relation: "equivalent" },
  ],
  AZR021: [
    { tool: "psrule-azure", rule: "Azure.AppService.UseHTTPS", url: "https://azure.github.io/PSRule.Rules.Azure/en/rules/Azure.AppService.UseHTTPS/", relation: "equivalent" },
    { tool: "checkov", rule: "CKV_AZURE_14", url: "https://www.checkov.io/5.Policy%20Index/arm.html", relation: "equivalent" },
    { tool: "kics", rule: "Website Not Forcing HTTPS", url: "https://docs.kics.io/latest/queries/azureresourcemanager-queries/azure/488847ff-6031-487c-bf42-98fd6ac5c9a0/", relation: "equivalent" },
  ],
  AZR022: [
    { tool: "psrule-azure", rule: "Azure.AppService.MinTLS", url: "https://azure.github.io/PSRule.Rules.Azure/en/rules/Azure.AppService.MinTLS/", relation: "equivalent" },
    { tool: "checkov", rule: "CKV_AZURE_15", url: "https://www.checkov.io/5.Policy%20Index/arm.html", relation: "equivalent" },
    { tool: "kics", rule: "Web App Not Using TLS Last Version", url: "https://docs.kics.io/latest/queries/azureresourcemanager-queries/azure/b5c851d5-00f1-43dc-a8de-3218fd6f71be/", relation: "equivalent" },
  ],
  AZR023: [
    { tool: "psrule-azure", rule: "Azure.VM.UseManagedDisks", url: "https://azure.github.io/PSRule.Rules.Azure/en/rules/Azure.VM.UseManagedDisks/", relation: "equivalent" },
    { tool: "checkov", rule: "CKV_AZURE_92", url: "https://www.checkov.io/5.Policy%20Index/arm.html", relation: "equivalent" },
  ],
  AZR025: [
    { tool: "psrule-azure", rule: "Azure.AKS.UseRBAC", url: "https://azure.github.io/PSRule.Rules.Azure/en/rules/Azure.AKS.UseRBAC/", relation: "equivalent" },
    { tool: "checkov", rule: "CKV_AZURE_5", url: "https://www.checkov.io/5.Policy%20Index/arm.html", relation: "equivalent" },
    { tool: "kics", rule: "AKS Cluster RBAC Disabled", url: "https://docs.kics.io/latest/queries/azureresourcemanager-queries/azure/9307a2ed-35c2-413d-94de-a1a0682c2158/", relation: "equivalent" },
  ],
  AZR026: [
    { tool: "psrule-azure", rule: "Azure.AKS.NetworkPolicy", url: "https://azure.github.io/PSRule.Rules.Azure/en/rules/Azure.AKS.NetworkPolicy/", relation: "equivalent" },
    { tool: "checkov", rule: "CKV_AZURE_7", url: "https://www.checkov.io/5.Policy%20Index/arm.html", relation: "equivalent" },
    { tool: "kics", rule: "AKS Cluster Network Policy Not Configured", url: "https://docs.kics.io/latest/queries/azureresourcemanager-queries/azure/25c0228e-4444-459b-a2df-93c7df40b7ed/", relation: "equivalent" },
  ],
  AZR027: [
    { tool: "psrule-azure", rule: "Azure.ACR.AdminUser", url: "https://azure.github.io/PSRule.Rules.Azure/en/rules/Azure.ACR.AdminUser/", relation: "equivalent" },
    { tool: "checkov", rule: "CKV_AZURE_137", url: "https://www.checkov.io/5.Policy%20Index/arm.html", relation: "equivalent" },
  ],
  AZR029: [
    { tool: "checkov", rule: "CKV_AZURE_2", url: "https://www.checkov.io/5.Policy%20Index/arm.html", relation: "equivalent" },
    { tool: "kics", rule: "Azure Managed Disk Without Encryption", url: "https://docs.kics.io/latest/queries/azureresourcemanager-queries/azure/350f3955-b5be-436f-afaa-3d2be2fa6cdd/", relation: "equivalent" },
    { tool: "psrule-azure", rule: "Azure.VM.ADE", url: "https://azure.github.io/PSRule.Rules.Azure/en/rules/Azure.VM.ADE/", relation: "overlaps" },
  ],
};
