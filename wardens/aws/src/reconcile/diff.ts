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
 * - identity-assignment: SSO permission sets by name (field-level diff,
 *   ownership-gated deletes) and account assignments keyed by
 *   set/account/principal. Assignments carry no tags, so the delete gate is
 *   scoping: only assignments under a config-declared permission set are
 *   managed. The break-glass grant is implicitly desired.
 * - audit-sink: the organization trail by bucket/multi-region. Never
 *   deleted — an undeclared trail is drift worth seeing, not removing.
 */

import { deepEqual, type ChangeSet, type ChangeSetEntry, type FieldChange } from "@intentius/chant/reconcile";
import type { AssignmentConfig, AwsGovernanceConfig, OuConfig } from "../config/types.js";
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

/** All desired grants: declared assignments plus the implicitly-desired break-glass. */
export function desiredAssignments(config: AwsGovernanceConfig): AssignmentConfig[] {
  const identity = config.identity;
  if (!identity) return [];
  return [...(identity.assignments ?? []), ...(identity.breakGlass ? [identity.breakGlass] : [])];
}

const assignmentKey = (permissionSet: string, account: string, type: string, principal: string): string =>
  `${permissionSet}/${account}/${type}:${principal}`;

export function diffIdentity(org: string, config: AwsGovernanceConfig, live: LiveOrgState): ChangeSet {
  const entries: ChangeSetEntry[] = [];
  const identity = config.identity;
  const liveIdentity = live.identity;
  // Selective-by-omission: no identity section declared → nothing managed.
  if (!identity || !liveIdentity) return { org, entries };

  const liveByName = new Map(liveIdentity.permissionSets.map((p) => [p.name, p]));
  for (const [name, def] of Object.entries(identity.permissionSets)) {
    const want = {
      description: def.description ?? "",
      sessionDuration: def.sessionDuration ?? "PT1H",
      managedPolicies: [...(def.managedPolicies ?? [])].sort(),
      inlinePolicy: def.inlinePolicy,
    };
    const livePs = liveByName.get(name);
    if (!livePs) {
      entries.push({ kind: "create", resourceType: "permission-set", key: name, after: want });
      continue;
    }
    const have = {
      description: livePs.description ?? "",
      sessionDuration: livePs.sessionDuration ?? "PT1H",
      managedPolicies: livePs.managedPolicies,
      inlinePolicy: livePs.inlinePolicy,
    };
    const fields: FieldChange[] = [];
    if (want.description !== have.description)
      fields.push({ field: "description", before: have.description, after: want.description });
    if (want.sessionDuration !== have.sessionDuration)
      fields.push({ field: "sessionDuration", before: have.sessionDuration, after: want.sessionDuration });
    if (!deepEqual(want.managedPolicies, have.managedPolicies))
      fields.push({ field: "managedPolicies", before: have.managedPolicies, after: want.managedPolicies });
    if (!deepEqual(want.inlinePolicy, have.inlinePolicy))
      fields.push({ field: "inlinePolicy", before: have.inlinePolicy, after: want.inlinePolicy });
    if (fields.length)
      entries.push({ kind: "update", resourceType: "permission-set", key: name, before: have, after: want, fields });
  }
  for (const livePs of liveIdentity.permissionSets) {
    if (Object.prototype.hasOwnProperty.call(identity.permissionSets, livePs.name)) continue;
    if (!livePs.owned) continue; // ownership-gated delete
    entries.push({ kind: "delete", resourceType: "permission-set", key: livePs.name, before: { arn: livePs.arn, name: livePs.name } });
  }

  const desired = new Map<string, { principal: string; principalType: "GROUP" | "USER"; permissionSet: string; account: string }>();
  for (const a of desiredAssignments(config)) {
    for (const account of a.accounts) {
      desired.set(assignmentKey(a.permissionSet, account, a.principalType, a.principal), {
        principal: a.principal,
        principalType: a.principalType,
        permissionSet: a.permissionSet,
        account,
      });
    }
  }
  const liveKeys = new Set<string>();
  for (const la of liveIdentity.assignments) {
    liveKeys.add(assignmentKey(la.permissionSetName, la.accountName, la.principalType, la.principalName));
  }
  for (const [key, want] of desired) {
    if (!liveKeys.has(key)) entries.push({ kind: "create", resourceType: "assignment", key, after: want });
  }
  for (const la of liveIdentity.assignments) {
    // Only assignments under a config-declared permission set are managed
    // (assignments carry no tags; scoping is the ownership analog).
    if (!Object.prototype.hasOwnProperty.call(identity.permissionSets, la.permissionSetName)) continue;
    const key = assignmentKey(la.permissionSetName, la.accountName, la.principalType, la.principalName);
    if (!desired.has(key)) entries.push({ kind: "delete", resourceType: "assignment", key, before: la });
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
  if (live.identity) entries.push(...diffIdentity(org, config, live).entries);
  if (live.trails) entries.push(...diffAuditSinks(org, config, live).entries);
  return { org, entries };
}
