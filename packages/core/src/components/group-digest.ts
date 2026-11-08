/**
 * The group digest of a capability group (ws-107), in a module of its own
 * so an op wave planned `together` (#4842) binds the same digest without
 * the wave-job runtime bundle loading `./groups.ts`.
 */

import { computePlanDigest } from "../lifecycle/plan-digest";

/**
 * The group digest (ws-107): over the capability's kind, each member's
 * component, change-set member and own plan digest, sorted, and the
 * capability's digest of the composition. One member more, or the same
 * members composed differently, moves it.
 */
export function groupDigest(kind: string, members: ReadonlyArray<{ component: string; member: string; planDigest: string }>, composition: string): string {
  const sorted = [...members]
    .map((m) => ({ component: m.component, member: m.member, planDigest: m.planDigest }))
    .sort((a, b) => a.component.localeCompare(b.component) || a.member.localeCompare(b.member));
  return computePlanDigest("capability-group", { kind, members: sorted, composition });
}
