/**
 * What `approvals.preview` compares (plywood#55): the resources a pull
 * request's plan changed, and only those.
 *
 * A wave's set digest covers every run's whole plan. Two pull requests that
 * change different resources of one stack, merged one after the other, never
 * share a set digest: the second merge plans with the first one's change in
 * it, either still waiting to apply (the plan holds that step) or applied
 * (the plan holds that resource's new inputs where the pull request saw the
 * old ones). Comparing the set refused the second merge's wave although
 * nothing it previewed had moved.
 *
 * The record a pull request's head keeps (`HeadPlanWave.members`) holds, for
 * each run, the digest of each resource its plan changes. The merged wave
 * compares those resources with the ones it plans now:
 *
 * - a resource the pull request changed that the merge plans with another
 *   digest, or no longer changes, has moved;
 * - a resource the merge changes that the pull request did not is another
 *   change's, which that change's own preview and gate answer for, and is not
 *   compared;
 * - a run recorded with no resource digests (its plan command gave none) is
 *   compared whole, by its plan digest, unless its plan changed nothing;
 * - a run the pull request's plan changed that the wave no longer plans has
 *   moved.
 *
 * The wave's gate still reads the plans the merge made, so a destructive
 * change the merge adds waits for its approval whoever previewed it.
 */
import type { HeadPlanMember } from "../lifecycle/wave-plans";
import { samePlanDigest } from "../lifecycle/plan-digest";

/** What the wave plans now for one run, as far as the comparison reads it. */
export interface PlannedRunDigests {
  member: string;
  planDigest: string;
  resources?: Record<string, string>;
}

/** A resource address as a person reads it: a Pulumi URN is its type and name. */
export function shortAddress(address: string): string {
  if (!address.startsWith("urn:pulumi:")) return address;
  const parts = address.split("::");
  return parts.length >= 3 ? parts.slice(-2).join("::") : address;
}

/**
 * The runs and resources of the pull request's plan that the wave's plans now
 * disagree with, as sentences naming each. Empty: nothing the pull request
 * previewed has moved.
 */
export function movedSincePreview(recorded: readonly HeadPlanMember[], now: readonly PlannedRunDigests[]): string[] {
  const byMember = new Map(now.map((m) => [m.member, m]));
  const moved: string[] = [];
  for (const before of recorded) {
    const fresh = byMember.get(before.member);
    if (before.resources && fresh?.resources) {
      for (const [address, digest] of Object.entries(before.resources)) {
        const found = fresh.resources[address];
        if (found === undefined) moved.push(`${before.member}: ${shortAddress(address)} is no longer changed by the plans`);
        else if (!samePlanDigest(found, digest)) moved.push(`${before.member}: ${shortAddress(address)} is planned differently`);
      }
      continue;
    }
    if (before.empty === true) continue;
    if (!fresh) moved.push(`${before.member} is no longer in the wave`);
    else if (!samePlanDigest(before.planDigest, fresh.planDigest)) moved.push(`${before.member}: its plan is another digest`);
  }
  return moved;
}
