/**
 * chant#4558: the Azure Blob check. Four ARM reads (blob service properties,
 * the account's management policy, the account, the container), then
 * {@link evaluateAzure}, a port of choudoufu's
 * pkg/staterecord/azurecontract.go (CheckAzureContract).
 *
 * With an `endpoint` (an ARM emulator), the target must carry a bearer token
 * and every call is pinned to that endpoint; DefaultAzureCredential is never
 * used against it.
 */

import { resolveAzureToken, sdkCredentialChains, type CredentialChains } from "../cloud-lister/credentials";
import { jsonBody, type TlsOptions, type WireResponse } from "../cloud-lister/transport";
import { isReadError, type BucketFinding, type BucketReport, type ReadError } from "./types";
import { BucketCheckError, namespacePrefix, sendGet, type WireOptions } from "./wire";

export interface AzureBlobTarget {
  store: "azblob";
  subscriptionId: string;
  resourceGroup: string;
  account: string;
  container: string;
  /** An ARM emulator's base, e.g. `http://localhost:4580`. Requires `token`. */
  endpoint?: string;
  token?: string;
  tls?: TlsOptions;
}

const API_VERSION = "2023-05-01";

interface DateAfter {
  daysAfterModificationGreaterThan?: number;
  daysAfterCreationGreaterThan?: number;
  daysAfterLastAccessTimeGreaterThan?: number;
  daysAfterLastTierChangeGreaterThan?: number;
}

export interface AzureManagementPolicyRule {
  name?: string;
  enabled?: boolean;
  type?: string;
  definition?: {
    filters?: { blobTypes?: string[]; prefixMatch?: string[]; blobIndexMatch?: unknown[] };
    actions?: {
      baseBlob?: { delete?: DateAfter; tierToArchive?: DateAfter; tierToCool?: DateAfter };
      version?: { delete?: { daysAfterCreationGreaterThan?: number } };
      snapshot?: unknown;
    };
  };
}

/** The ARM documents the check reads, each as returned or as the read's error. */
export interface AzureInput {
  blobServices: { properties?: { isVersioningEnabled?: boolean } } | ReadError;
  managementPolicy: { properties?: { policy?: { rules?: AzureManagementPolicyRule[] } } } | ReadError;
  account: { properties?: { allowBlobPublicAccess?: boolean } } | ReadError;
  /** Read only to say whether a container is already public; its failure is ignored. */
  container?: { properties?: { publicAccess?: string } } | ReadError;
}

export interface AzureEvaluateOptions {
  account: string;
  resourceGroup: string;
  container: string;
  /** Blob-name prefixes inside the container. */
  namespaces?: readonly string[];
  recoveryDays?: number;
}

function readFailure(setting: BucketFinding["setting"], action: string, e: ReadError): BucketFinding {
  if (e.error.status !== 403) {
    throw new BucketCheckError(`azurerm: reading the storage account's ${setting} setting failed: ${e.error.code ?? `HTTP ${e.error.status ?? "?"}`}`);
  }
  return { setting, verdict: "unreadable", found: `${action} was denied`, unwaivable: false, fix: `Grant the identity ${action} on the storage account, or have someone who holds it confirm the setting.` };
}

const ruleName = (r: AzureManagementPolicyRule): string => (r.name ? r.name : "(unnamed rule)");
const enabled = (r: AzureManagementPolicyRule): boolean => r.enabled === undefined || r.enabled;
const filters = (r: AzureManagementPolicyRule) => r.definition?.filters ?? {};
const actions = (r: AzureManagementPolicyRule) => r.definition?.actions ?? {};

function touchesBlockBlobs(r: AzureManagementPolicyRule): boolean {
  const types = filters(r).blobTypes ?? [];
  return types.length === 0 || types.some((t) => t.toLowerCase() === "blockblob");
}

function dateAfter(d: DateAfter | undefined): string {
  if (!d) return "";
  const pairs: Array<[number | undefined, string]> = [
    [d.daysAfterModificationGreaterThan, "since last modification"],
    [d.daysAfterCreationGreaterThan, "since creation"],
    [d.daysAfterLastAccessTimeGreaterThan, "since last access"],
    [d.daysAfterLastTierChangeGreaterThan, "since the last tier change"],
  ];
  for (const [days, what] of pairs) if (days !== undefined) return `after ${days} day(s) ${what}`;
  return "";
}

function harmsCurrent(r: AzureManagementPolicyRule): string {
  const base = actions(r).baseBlob;
  if (!base) return "";
  const del = dateAfter(base.delete);
  if (del) return `deletes current blobs ${del}`;
  const arch = dateAfter(base.tierToArchive);
  if (arch) return `moves current blobs to the archive tier ${arch}, where a blob cannot be read until it is rehydrated`;
  return "";
}

function noncurrentDays(r: AzureManagementPolicyRule): number {
  const d = actions(r).version?.delete?.daysAfterCreationGreaterThan;
  return d === undefined ? 0 : Math.trunc(d);
}

function covers(r: AzureManagementPolicyRule, target: string): boolean {
  const prefixes = filters(r).prefixMatch ?? [];
  return prefixes.length === 0 || prefixes.some((p) => target.startsWith(p));
}

function mayReach(r: AzureManagementPolicyRule, targets: readonly string[]): boolean {
  const prefixes = filters(r).prefixMatch ?? [];
  if (prefixes.length === 0) return true;
  return prefixes.some((p) => targets.some((t) => t.startsWith(p) || p.startsWith(t)));
}

export function azureLifecycleFix(account: string, resourceGroup: string, container: string, namespaces: readonly string[], recoveryDays: number): string {
  const prefixMatch = (namespaces.length === 0 ? [""] : namespaces).map((ns) => `${container}/${namespacePrefix(ns)}`);
  const policy = {
    rules: [
      {
        name: "expire-previous-versions",
        enabled: true,
        type: "Lifecycle",
        definition: {
          filters: { blobTypes: ["blockBlob"], prefixMatch },
          actions: { version: { delete: { daysAfterCreationGreaterThan: recoveryDays } } },
        },
      },
    ],
  };
  return (
    `Write ${JSON.stringify(policy)} to policy.json, then: az storage account management-policy create --account-name ${account} --resource-group ${resourceGroup} --policy @policy.json ` +
    `(this replaces the account's lifecycle policy, so add this rule to any it already has; ${recoveryDays} days is how long a deleted or overwritten record stays recoverable)`
  );
}

export function evaluateAzure(input: AzureInput, options: AzureEvaluateOptions): BucketFinding[] {
  return [versioning(input, options), lifecycle(input, options), publicAccess(input, options)];
}

function versioning(input: AzureInput, o: AzureEvaluateOptions): BucketFinding {
  const b = input.blobServices;
  if (isReadError(b)) return readFailure("blob_versioning", "Microsoft.Storage/storageAccounts/blobServices/read", b);
  if (b.properties?.isVersioningEnabled === true) return { setting: "blob_versioning", verdict: "ok", found: "blob versioning is enabled", unwaivable: false };
  return {
    setting: "blob_versioning",
    verdict: "fail",
    found: "blob versioning is not enabled",
    unwaivable: false,
    fix: `az storage account blob-service-properties update --account-name ${o.account} --resource-group ${o.resourceGroup} --enable-versioning true`,
  };
}

function lifecycle(input: AzureInput, o: AzureEvaluateOptions): BucketFinding {
  const namespaces = o.namespaces ?? [];
  const fail = (found: string): BucketFinding => ({
    setting: "lifecycle_management",
    verdict: "fail",
    found,
    unwaivable: false,
    fix: azureLifecycleFix(o.account, o.resourceGroup, o.container, namespaces, o.recoveryDays ?? 30),
  });
  const p = input.managementPolicy;
  if (isReadError(p)) {
    if (p.error.status === 404) return fail("the storage account has no lifecycle management policy");
    return readFailure("lifecycle_management", "Microsoft.Storage/storageAccounts/managementPolicies/read", p);
  }
  const rules = p.properties?.policy?.rules ?? [];
  const targets = namespaces.length === 0 ? [`${o.container}/`] : namespaces.map((ns) => `${o.container}/${namespacePrefix(ns)}`);

  const deleting: string[] = [];
  for (const r of rules) {
    if (!enabled(r) || !touchesBlockBlobs(r)) continue;
    const what = harmsCurrent(r);
    if (what === "" || !mayReach(r, targets)) continue;
    deleting.push(`rule "${ruleName(r)}" ${what}, and a record is a current blob`);
  }
  if (deleting.length > 0) {
    return {
      setting: "lifecycle_management",
      verdict: "fail",
      found: deleting.join("; "),
      unwaivable: true,
      fix: "Remove the baseBlob delete or tierToArchive action from that rule, or limit the rule to a prefix outside these blobs. Only a version delete belongs on a rule that reaches them.",
    };
  }

  const near: string[] = [];
  const covering: AzureManagementPolicyRule[] = [];
  for (const r of rules) {
    if (noncurrentDays(r) <= 0) continue;
    if (!enabled(r)) near.push(`rule "${ruleName(r)}" deletes previous versions but is disabled`);
    else if (!touchesBlockBlobs(r)) near.push(`rule "${ruleName(r)}" deletes previous versions but not of block blobs, which is what a record is`);
    else if (filters(r).blobIndexMatch !== undefined) near.push(`rule "${ruleName(r)}" deletes previous versions but is filtered by blob index tag, which this check does not rely on`);
    else covering.push(r);
  }
  const used: string[] = [];
  const uncovered: string[] = [];
  for (const t of targets) {
    const hit = covering.find((r) => covers(r, t));
    if (hit) {
      const d = `rule "${ruleName(hit)}" deletes previous versions after ${noncurrentDays(hit)} day(s)`;
      if (!used.includes(d)) used.push(d);
    } else {
      uncovered.push(t);
    }
  }
  if (uncovered.length === 0 && covering.length > 0) return { setting: "lifecycle_management", verdict: "ok", found: used.join("; "), unwaivable: false };
  for (const r of covering) {
    const quoted = (filters(r).prefixMatch ?? []).map((x) => `"${x}"`).join(", ");
    for (const t of uncovered) near.push(`rule "${ruleName(r)}" deletes previous versions but only under ${quoted}, which does not contain "${t}"`);
  }
  if (near.length > 0) return fail(near.join("; "));
  if (rules.length === 0) return fail("the lifecycle management policy has no rules");
  return fail(`none of the lifecycle management policy's ${rules.length} rule(s) deletes previous versions`);
}

function publicAccess(input: AzureInput, o: AzureEvaluateOptions): BucketFinding {
  const a = input.account;
  if (isReadError(a)) return readFailure("public_access", "Microsoft.Storage/storageAccounts/read", a);
  const allow = a.properties?.allowBlobPublicAccess;
  if (allow === false) return { setting: "public_access", verdict: "ok", found: "the storage account disallows anonymous blob access", unwaivable: false };
  let found = allow === undefined ? "the storage account does not set allowBlobPublicAccess, which accounts created before 2023 read as allowed" : "the storage account allows anonymous blob access";
  const c = input.container;
  const level = c && !isReadError(c) ? c.properties?.publicAccess : undefined;
  if (level !== undefined && level !== "None") found += `, and container "${o.container}" is already readable anonymously at level "${level}"`;
  return {
    setting: "public_access",
    verdict: "fail",
    found,
    unwaivable: false,
    fix: `az storage account update --name ${o.account} --resource-group ${o.resourceGroup} --allow-blob-public-access false`,
  };
}

export interface AzureReadOptions extends WireOptions {
  chains?: CredentialChains;
}

export function azureUrls(target: AzureBlobTarget): { blobServices: string; managementPolicy: string; account: string; container: string } {
  const base = (target.endpoint ?? "https://management.azure.com").replace(/\/+$/, "");
  const acct = `${base}/subscriptions/${encodeURIComponent(target.subscriptionId)}/resourceGroups/${encodeURIComponent(target.resourceGroup)}/providers/Microsoft.Storage/storageAccounts/${encodeURIComponent(target.account)}`;
  const q = `?api-version=${API_VERSION}`;
  return {
    blobServices: `${acct}/blobServices/default${q}`,
    managementPolicy: `${acct}/managementPolicies/default${q}`,
    account: `${acct}${q}`,
    container: `${acct}/blobServices/default/containers/${encodeURIComponent(target.container)}${q}`,
  };
}

function asDoc<T>(res: WireResponse): T | ReadError {
  if (res.status >= 200 && res.status < 300) return (jsonBody(res) ?? {}) as T;
  const body = jsonBody(res) as { error?: { code?: string } } | undefined;
  return { error: { status: res.status, ...(body?.error?.code ? { code: body.error.code } : {}) } };
}

export async function readAzure(target: AzureBlobTarget, options: AzureReadOptions = {}): Promise<AzureInput> {
  const token = await resolveAzureToken(target, options.chains ?? sdkCredentialChains);
  const headers = { accept: "application/json", authorization: `Bearer ${token}` };
  const wire: WireOptions = { ...options, ...(target.tls ? { tls: target.tls } : {}) };
  const urls = azureUrls(target);
  const get = (url: string) => sendGet("azure", url, headers, target.endpoint, wire);
  const account = await get(urls.account);
  if (account.status === 404) throw new BucketCheckError(`azurerm: storage account ${target.account} in ${target.resourceGroup} does not exist; the check creates nothing`);
  const blobServices = await get(urls.blobServices);
  const managementPolicy = await get(urls.managementPolicy);
  let container: AzureInput["container"];
  try {
    container = asDoc(await get(urls.container));
  } catch {
    container = undefined;
  }
  return {
    blobServices: asDoc(blobServices),
    managementPolicy: asDoc(managementPolicy),
    account: asDoc(account),
    ...(container !== undefined ? { container } : {}),
  };
}

export async function checkAzureBlob(target: AzureBlobTarget, options: AzureReadOptions & { namespaces?: readonly string[]; recoveryDays?: number } = {}): Promise<BucketReport> {
  const input = await readAzure(target, options);
  const settings = evaluateAzure(input, {
    account: target.account,
    resourceGroup: target.resourceGroup,
    container: target.container,
    namespaces: options.namespaces ?? [],
    ...(options.recoveryDays !== undefined ? { recoveryDays: options.recoveryDays } : {}),
  });
  return {
    store: "azblob",
    bucket: `${target.account}/${target.container}`,
    namespaces: [...(options.namespaces ?? [])],
    correct: settings.every((f) => f.verdict === "ok"),
    settings,
  };
}
