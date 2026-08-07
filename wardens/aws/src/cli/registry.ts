/**
 * Cycle registry — maps `--cycles` names to their implementations. The key
 * MUST equal `cycle.name` so `--cycles` resolution and run output agree.
 */

import type { Cycle } from "../reconcile/runner.js";
import { orgUnitsCycle } from "../cycles/org-units.js";
import { scpsCycle } from "../cycles/scps.js";
import { identityCycle } from "../cycles/identity.js";
import { auditTrailCycle } from "../cycles/audit-trail.js";

export const CYCLE_REGISTRY: Record<string, Cycle> = {
  [orgUnitsCycle.name]: orgUnitsCycle,
  [scpsCycle.name]: scpsCycle,
  [identityCycle.name]: identityCycle,
  [auditTrailCycle.name]: auditTrailCycle,
};
