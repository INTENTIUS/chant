/**
 * Warnings for an Op waves spec's approval rules (#5349). Kept apart from
 * `./op-waves.ts`, so the gate-decision bundle stays small.
 */

import { quorumRules, targetGlobMatch } from "./gate-quorum";
import type { GateApprovalSource, OpWavesSpec } from "./op-waves";

/** The approval modes that count a plain `chant approve` line of the digest, sealed or not (#5349). */
export const PLAIN_APPROVAL_MODES: readonly GateApprovalSource[] = ["ledger", "pr-review", "pull-request"];

/**
 * Warnings for a spec's approval rules (#5349), one line each: a rule whose
 * `count` is above 1, without `proven`, on a wave whose `approval` mode
 * takes plain `chant approve` lines. One person who can push to
 * `chant/lifecycle` can write those lines in two names, so the count does
 * not show two people approved. A rule with `roles` already counts only
 * proven approvers and is left out. `sealed` counts sealed approvals only.
 * A wave that asks a decision point is decided by the point. The spec is
 * not refused: the rule is valid and works as it did.
 */
export function opWavesQuorumWarnings(spec: Pick<OpWavesSpec, "waves" | "approvals" | "point">): string[] {
  const rules = quorumRules(spec.approvals?.quorum);
  const out: string[] = [];
  spec.waves.forEach((wave, i) => {
    const mode = wave.approval ?? "ledger";
    if (!PLAIN_APPROVAL_MODES.includes(mode) || (wave.point ?? spec.point) !== undefined) return;
    const targets = (wave.runs ?? []).map((r) => r.target);
    rules.forEach((rule, j) => {
      if (rule.count <= 1 || rule.proven === true || (rule.roles?.length ?? 0) > 0) return;
      if (rule.targets !== undefined && targets.length > 0 && !rule.targets.some((g) => targets.some((t) => targetGlobMatch(g, t)))) return;
      out.push(
        `wave ${i + 1} (${wave.name}): approvals.quorum[${j}] asks for ${rule.count} approvers under \`${mode}\`, which counts plain \`chant approve\` lines, so one person who can push to chant/lifecycle can meet it alone. Set \`proven: true\` on the rule to count only approvers a seal or a review proves, or use \`approval: "sealed"\``,
      );
    });
  });
  return out;
}
