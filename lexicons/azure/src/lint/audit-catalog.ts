/**
 * The azure lexicon's `chant audit` catalog — metadata for the AZR* ARM
 * post-synth rules. Contributed via `azurePlugin.auditCatalog()` (#687).
 */
import { auditRule, type RuleMeta, type Authority } from "@intentius/chant/audit/catalog";

const AZ_SEC: Authority = { name: "Microsoft Cloud Security Benchmark", url: "https://learn.microsoft.com/en-us/security/benchmark/azure/" };

export const azureAuditCatalog: Record<string, RuleMeta> = {
  AZR010: auditRule("AZR010", "report-only", "guidance", "Redundant dependsOn", "Remove dependsOn already implied by reference()/resourceId().", { category: "best-practice" }),
  AZR011: auditRule("AZR011", "merge-worthy", "guidance", "Missing or invalid apiVersion", "Set a valid YYYY-MM-DD apiVersion on every resource.", { category: "correctness" }),
  AZR012: auditRule("AZR012", "report-only", "guidance", "Deprecated API version", "Move to a current apiVersion.", { category: "best-practice" }),
  AZR013: auditRule("AZR013", "merge-worthy", "guidance", "Resource missing location", "Add the required location property.", { category: "correctness" }),
  AZR014: auditRule("AZR014", "merge-worthy", "guidance", "Storage account allows public blob access", "Set allowBlobPublicAccess to false.", { authority: [AZ_SEC] }),
  AZR015: auditRule("AZR015", "merge-worthy", "guidance", "Storage account missing encryption", "Enable encryption services for data at rest.", { authority: [AZ_SEC] }),
  AZR016: auditRule("AZR016", "report-only", "guidance", "Key Vault soft-delete not enabled", "Enable soft-delete.", { category: "best-practice" }),
  AZR017: auditRule("AZR017", "report-only", "guidance", "Key Vault purge protection not enabled", "Enable purge protection.", { category: "best-practice" }),
  AZR018: auditRule("AZR018", "report-only", "guidance", "SQL Server missing auditing", "Enable auditing for compliance and threat detection.", { category: "best-practice" }),
  AZR019: auditRule("AZR019", "merge-worthy", "guidance", "SQL database missing TDE", "Enable Transparent Data Encryption.", { authority: [AZ_SEC] }),
  AZR020: auditRule("AZR020", "report-only", "guidance", "App Service missing managed identity", "Enable a system- or user-assigned identity.", { category: "best-practice" }),
  AZR021: auditRule("AZR021", "merge-worthy", "guidance", "App Service not HTTPS-only", "Set httpsOnly to true.", { authority: [AZ_SEC] }),
  AZR022: auditRule("AZR022", "merge-worthy", "guidance", "App Service min TLS below 1.2", "Set minTlsVersion to 1.2+.", { authority: [AZ_SEC] }),
  AZR023: auditRule("AZR023", "report-only", "guidance", "VM not using a managed disk", "Use a managed disk.", { category: "best-practice" }),
  AZR024: auditRule("AZR024", "report-only", "guidance", "VM missing boot diagnostics", "Enable boot diagnostics.", { category: "best-practice" }),
  AZR025: auditRule("AZR025", "report-only", "guidance", "AKS cluster missing RBAC", "Enable Kubernetes RBAC.", { category: "best-practice" }),
  AZR026: auditRule("AZR026", "report-only", "guidance", "AKS cluster missing network policy", "Configure a networkPolicy.", { category: "best-practice" }),
  AZR027: auditRule("AZR027", "merge-worthy", "guidance", "Container Registry admin user enabled", "Disable the admin user; use Azure AD / service principals.", { authority: [AZ_SEC] }),
  AZR028: auditRule("AZR028", "report-only", "guidance", "Network interface missing NSG", "Associate an NSG to control traffic.", { category: "best-practice" }),
  AZR029: auditRule("AZR029", "merge-worthy", "guidance", "Managed disk missing encryption", "Enable encryption for data at rest.", { authority: [AZ_SEC] }),
  AZR030: auditRule("AZR030", "merge-worthy", "guidance", "Resource at unsupported template scope", "Move the resource to a project deployed at a scope its schema supports.", { category: "correctness" }),
};
