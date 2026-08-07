/**
 * Cloud-specific guardrails (#792), layered on the shared framework:
 *
 * - root-SCP floor: block a plan whose SCP deletes/detaches would leave the
 *   organization root with no SCP attached at all.
 * - deletion cap: OU deletes are capped (default 2 per run) — an org
 *   hierarchy typo must not cascade.
 * - break-glass admin: the named break-glass grant (config
 *   `identity.breakGlass`) may not be removed — neither its assignment nor
 *   the permission set backing it. Defense in depth over the diff treating
 *   it as implicitly desired.
 */

import type { ChangeSet, GuardrailDiagnostic, GuardrailResult } from "@intentius/chant/reconcile";
import type { AwsGovernanceConfig } from "../config/types.js";
import type { LiveOrgState } from "./live.js";

export const DEFAULT_OU_DELETE_CAP = 2;

export function rootScpFloor(changeSet: ChangeSet, live: LiveOrgState): GuardrailDiagnostic | null {
  const rootId = live.rootId;
  if (!rootId || !live.scps) return null;
  const rootAttached = new Set(live.scps.filter((s) => s.targetIds.includes(rootId)).map((s) => s.name));
  if (rootAttached.size === 0) return null; // nothing to protect yet
  for (const e of changeSet.entries) {
    if (e.resourceType !== "scp") continue;
    if (e.kind === "delete" && rootAttached.has(e.key)) rootAttached.delete(e.key);
    if (e.kind === "update") {
      const after = e.after as { targets?: string[] } | undefined;
      if (rootAttached.has(e.key) && after?.targets && !after.targets.includes("")) rootAttached.delete(e.key);
    }
  }
  if (rootAttached.size === 0) {
    return {
      guardrail: "rootScpFloor",
      message: "plan would leave the organization root with no SCP attached — refusing to drop the last root guardrail",
    };
  }
  return null;
}

export function ouDeletionCap(changeSet: ChangeSet, cap = DEFAULT_OU_DELETE_CAP): GuardrailDiagnostic | null {
  const deletes = changeSet.entries.filter((e) => e.resourceType === "ou" && e.kind === "delete").length;
  if (deletes > cap) {
    return {
      guardrail: "ouDeletionCap",
      message: `plan deletes ${deletes} OUs (cap ${cap}) — a hierarchy typo must not cascade; raise the cap deliberately if intended`,
    };
  }
  return null;
}

export function breakGlassAdmin(changeSet: ChangeSet, config?: AwsGovernanceConfig): GuardrailDiagnostic | null {
  const bg = config?.identity?.breakGlass;
  if (!bg) return null;
  for (const e of changeSet.entries) {
    if (e.kind !== "delete") continue;
    if (e.resourceType === "permission-set" && e.key === bg.permissionSet) {
      return {
        guardrail: "breakGlassAdmin",
        message:
          `plan deletes permission set "${bg.permissionSet}" backing the break-glass admin ` +
          `"${bg.principal}" — refusing to remove the break-glass path`,
      };
    }
    if (e.resourceType === "assignment") {
      const before = e.before as { permissionSetName?: string; principalName?: string; principalType?: string } | undefined;
      if (
        before?.permissionSetName === bg.permissionSet &&
        before.principalName === bg.principal &&
        before.principalType === bg.principalType
      ) {
        return {
          guardrail: "breakGlassAdmin",
          message: `plan removes the break-glass admin assignment "${e.key}" — refusing to remove the break-glass path`,
        };
      }
    }
  }
  return null;
}

export function runAwsGuardrails(
  changeSet: ChangeSet,
  live: LiveOrgState,
  config?: AwsGovernanceConfig,
): GuardrailResult {
  const diagnostics = [rootScpFloor(changeSet, live), ouDeletionCap(changeSet), breakGlassAdmin(changeSet, config)].filter(
    (d): d is GuardrailDiagnostic => d !== null,
  );
  return diagnostics.length ? { ok: false, diagnostics } : { ok: true };
}
