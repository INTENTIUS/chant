/**
 * Cycle registry — maps `--cycles` names to their implementations.
 *
 * Cycles add themselves here as they land (see the roadmap epic). The key MUST
 * equal `cycle.name` so `--cycles` resolution and run output agree.
 */

import type { Cycle } from "../reconcile/runner.js";
import { orgSettingsCycle } from "../cycles/org-settings.js";
import { membershipCycle } from "../cycles/membership.js";
import { teamsCycle } from "../cycles/teams.js";
import { repoSettingsCycle } from "../cycles/repo-settings.js";
import { branchProtectionCycle } from "../cycles/branch-protection.js";
import { repoBaselineCycle } from "../cycles/repo-baseline.js";
import { secretsVariablesCycle } from "../cycles/secrets-variables.js";
import { webhooksCycle } from "../cycles/webhooks.js";

export const CYCLE_REGISTRY: Record<string, Cycle> = {
  [orgSettingsCycle.name]: orgSettingsCycle,
  [membershipCycle.name]: membershipCycle,
  [teamsCycle.name]: teamsCycle,
  [repoSettingsCycle.name]: repoSettingsCycle,
  [branchProtectionCycle.name]: branchProtectionCycle,
  [repoBaselineCycle.name]: repoBaselineCycle,
  [secretsVariablesCycle.name]: secretsVariablesCycle,
  [webhooksCycle.name]: webhooksCycle,
};
