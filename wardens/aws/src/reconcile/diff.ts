/**
 * Desired-vs-live diffs for the AWS governance cycles. Selective-by-omission
 * with ownership-gated deletes, on the shared change-set model:
 *
 * - org-unit: OUs by path. Creates for declared-but-absent; deletes only for
 *   absent-but-live OUs carrying the ownership tag. Accounts diff as
 *   placement only: an account in the wrong OU is an update (MoveAccount is
 *   safe); account creation/closure is deliberately out of scope and
 *   surfaces as a create entry `apply` refuses with instructions.
 * - policy-guardrail: SCPs by name. Field-level diff over document /
 *   description / target paths; deletes gated on ownership; AWS-managed
 *   policies are never touched.
 * - audit-sink: the organization trail by bucket/multi-region. Never
 *   deleted — an undeclared trail is drift worth seeing, not removing.
 */

import { deepEqual, type ChangeSet, type ChangeSetEntry } from "@intentius/chant/reconcile";
import type { AwsGovernanceConfig, OuConfig } from "../config/types.js";
import type { LiveOrgState } from "./live.js";

export interface DesiredOu {
  path: string;
  name: string;
  parentPath: string;
  scps: string[];
}

export interface DesiredAccount {
  name: string;
  email: string;
  ouPath: string;
}

/** Flatten the config's OU tree into path-keyed rows. */
export function flattenDesired(config: AwsGovernanceConfig): { ous: DesiredOu[]; accounts: DesiredAccount[] } {
  const ous: DesiredOu[] = [];
  const accounts: DesiredAccount[] = [];
  const walk = (tree: Record<string, OuConfig>, parentPath: string): void => {
    for (const [name, node] of Object.entries(tree)) {
      const path = parentPath ? `${parentPath}/${name}` : name;
      ous.push({ path, name, parentPath, scps: node.scps ?? [] });
      for (const a of node.accounts ?? []) accounts.push({ name: a.name, email: a.email, ouPath: path });
      if (node.children) walk(node.children, path);
    }
  };
  walk(config.ous, "");
  return { ous, accounts };
}

/** SCP name -> the set of paths ("" = root) the config attaches it to. */
export function desiredScpTargets(config: AwsGovernanceConfig): Map<string, string[]> {
  const targets = new Map<string, string[]>();
  const add = (name: string, path: string): void => {
    targets.set(name, [...(targets.get(name) ?? []), path]);
  };
  for (const name of config.organization.scps ?? []) add(name, "");
  for (const ou of flattenDesired(config).ous) for (const name of ou.scps) add(name, ou.path);
  return targets;
}

export function diffOrgUnits(org: string, config: AwsGovernanceConfig, live: LiveOrgState): ChangeSet {
  const entries: ChangeSetEntry[] = [];
  const { ous: desiredOus, accounts: desiredAccounts } = flattenDesired(config);
  const livePaths = new Map((live.ous ?? []).map((o) => [o.path, o]));
  const desiredPaths = new Set(desiredOus.map((o) => o.path));

  for (const ou of desiredOus) {
    if (!livePaths.has(ou.path)) {
      entries.push({ kind: "create", resourceType: "ou", key: ou.path, after: { name: ou.name } });
    }
  }
  for (const liveOu of live.ous ?? []) {
    // Selective-by-omission: only subtrees the config declares at the top
    // level are managed; an undeclared live top-level OU is out of scope.
    const topLevel = liveOu.path.split("/")[0];
    if (!Object.prototype.hasOwnProperty.call(config.ous, topLevel)) continue;
    if (!desiredPaths.has(liveOu.path)) {
      if (!liveOu.owned) continue; // ownership-gated delete
      entries.push({ kind: "delete", resourceType: "ou", key: liveOu.path, before: { id: liveOu.id } });
    }
  }

  const liveAccounts = new Map((live.accounts ?? []).map((a) => [a.name, a]));
  for (const acct of desiredAccounts) {
    const liveAcct = liveAccounts.get(acct.name);
    if (!liveAcct) {
      entries.push({ kind: "create", resourceType: "account", key: acct.name, after: acct });
    } else if (liveAcct.ouPath !== acct.ouPath) {
      entries.push({
        kind: "update",
        resourceType: "account",
        key: acct.name,
        before: { ouPath: liveAcct.ouPath },
        after: { ouPath: acct.ouPath },
        fields: [{ field: "ouPath", before: liveAcct.ouPath, after: acct.ouPath }],
      });
    }
  }
  // Accounts are never deleted: closure is not a reconcile action.

  return { org, entries };
}

export function diffScps(org: string, config: AwsGovernanceConfig, live: LiveOrgState): ChangeSet {
  const entries: ChangeSetEntry[] = [];
  const desired = desiredScpTargets(config);
  const liveByName = new Map((live.scps ?? []).map((s) => [s.name, s]));

  for (const [name, paths] of desired) {
    const def = config.scps[name];
    if (!def) continue; // authoring layer validates; tolerate here
    const liveScp = liveByName.get(name);
    const want = { document: def.document, description: def.description ?? "", targets: [...paths].sort() };
    if (!liveScp) {
      entries.push({ kind: "create", resourceType: "scp", key: name, after: want });
      continue;
    }
    const liveTargets = liveScp.targetIds
      .map((id) => (live.pathById ?? {})[id])
      .filter((p): p is string => p !== undefined)
      .sort();
    const have = { document: liveScp.document, description: liveScp.description ?? "", targets: liveTargets };
    const fields = [];
    if (!deepEqual(want.document, have.document)) fields.push({ field: "document", before: have.document, after: want.document });
    if (want.description !== have.description) fields.push({ field: "description", before: have.description, after: want.description });
    if (!deepEqual(want.targets, have.targets)) fields.push({ field: "targets", before: have.targets, after: want.targets });
    if (fields.length) entries.push({ kind: "update", resourceType: "scp", key: name, before: have, after: want, fields });
  }

  for (const liveScp of live.scps ?? []) {
    if (liveScp.awsManaged || desired.has(liveScp.name)) continue;
    if (!liveScp.owned) continue; // ownership-gated delete
    entries.push({ kind: "delete", resourceType: "scp", key: liveScp.name, before: { id: liveScp.id } });
  }

  return { org, entries };
}

export function diffAuditSinks(org: string, config: AwsGovernanceConfig, live: LiveOrgState): ChangeSet {
  const entries: ChangeSetEntry[] = [];
  const want = config.auditSinks?.cloudtrail;
  if (want) {
    const orgTrail = (live.trails ?? []).find((t) => t.isOrganizationTrail);
    if (!orgTrail) {
      entries.push({ kind: "create", resourceType: "trail", key: "organization-trail", after: want });
    } else {
      const fields = [];
      if (orgTrail.bucket !== want.bucket) fields.push({ field: "bucket", before: orgTrail.bucket, after: want.bucket });
      if (orgTrail.multiRegion !== want.multiRegion)
        fields.push({ field: "multiRegion", before: orgTrail.multiRegion, after: want.multiRegion });
      if (fields.length)
        entries.push({ kind: "update", resourceType: "trail", key: orgTrail.name, before: orgTrail, after: want, fields });
    }
  }
  // Trails are never deleted by reconcile: an undeclared trail is visible
  // drift for the audit tier (#793), not something to remove.
  return { org, entries };
}

/**
 * The shared diff the runner hands to every cycle: emits entries only for
 * the live parts the cycle fetched.
 */
export function diff(org: string, config: AwsGovernanceConfig, live: LiveOrgState): ChangeSet {
  const entries: ChangeSetEntry[] = [];
  if (live.ous) entries.push(...diffOrgUnits(org, config, live).entries);
  if (live.scps) entries.push(...diffScps(org, config, live).entries);
  if (live.trails) entries.push(...diffAuditSinks(org, config, live).entries);
  return { org, entries };
}
