/**
 * RBAC verb constants for batch API group resources.
 */

import { StandardVerbs } from "./core";

export const JobActions = { ...StandardVerbs } as const;

export const CronJobActions = { ...StandardVerbs } as const;
