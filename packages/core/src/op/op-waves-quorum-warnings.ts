/**
 * Findings for an Op waves spec's approval rules (#5349): a count plain
 * `chant approve` lines can meet, and a rule that needs proof on a wave where
 * nothing can prove an approver. Kept apart from `./op-waves.ts`, so the
 * gate-decision bundle stays small.
 */

import { quorumRuleSites, ruleNeedsProof, targetGlobMatch, type GateQuorumRule } from "./gate-quorum";
import type { GateApprovalSource, OpWave, OpWavesSpec } from "./op-waves";

/**
 * Whether a rule that needs proof on a wave nothing can prove an approver
 * for refuses the spec (#5349). False in the release that adds the check:
 * the generator warns and writes the pipeline. The next release sets it to
 * true, and `generateOpWavesPipeline` then refuses the spec with the same
 * lines.
 */
export const UNPROVABLE_QUORUM_REFUSED = false;

/** What can prove an approver where the spec is built (#5349). */
export interface OpWavesProofSources {
  /** The signers file the trust policy names, such as `.chant/allowed_signers`. */
  signersPath: string;
  /** Whether that file, or `.chant/trust.json`'s passkeys, names at least one signer. */
  signersNamed: boolean;
}

/** The rules a wave takes, each with where `approvals.quorum` writes it (#5354: inside groups too). A wave with no runs listed yet takes every rule. */
function rulesOf(rules: ReadonlyArray<{ rule: GateQuorumRule; at: string }>, wave: OpWave): Array<[GateQuorumRule, string]> {
  const targets = (wave.runs ?? []).map((r) => r.target);
  return rules
    .map(({ rule, at }) => [rule, at] as [GateQuorumRule, string])
    .filter(([rule]) => rule.targets === undefined || targets.length === 0 || rule.targets.some((g) => targets.some((t) => targetGlobMatch(g, t))));
}

/** What a rule needs proof for, in words: `roles`, `notAuthor`, `proven`. */
function proofNeeds(rule: GateQuorumRule): string {
  return [rule.roles?.length ? "`roles`" : "", rule.notAuthor ? "`notAuthor`" : "", rule.proven ? "`proven`" : ""].filter(Boolean).join(", ");
}

/**
 * Rules no approver can meet (#5349), one line each: a rule that needs a
 * proven approver (`roles`, `notAuthor` or `proven`) on a wave where
 * nothing can prove one. A seal proves its approver under every mode, so
 * only when the signers file names nobody; and `pr-review` proves the merged
 * pull request's reviewers (and a `reviewLedger`'s), so only on a wave under
 * another mode. A wave that asks a decision point is decided by the point.
 */
export function opWavesUnprovableQuorum(spec: Pick<OpWavesSpec, "waves" | "approvals" | "point">, proof: OpWavesProofSources): string[] {
  if (proof.signersNamed) return [];
  const rules = quorumRuleSites(spec.approvals?.quorum, "approvals.quorum");
  const out: string[] = [];
  spec.waves.forEach((wave, i) => {
    const mode = wave.approval ?? "ledger";
    if (mode === "pr-review" || (wave.point ?? spec.point) !== undefined) return;
    for (const [rule, j] of rulesOf(rules, wave)) {
      if (!ruleNeedsProof(rule)) continue;
      out.push(
        `wave ${i + 1} (${wave.name}): ${j} needs a proven approver (${proofNeeds(rule)}), and nothing can prove one: ${proof.signersPath} names no signer, and \`${mode}\` reads no review. Add the approvers' keys to ${proof.signersPath} and approve with \`chant approve --sign\`, or set the wave's approval to \`pr-review\` so the merged pull request's review proves its reviewers`,
      );
    }
  });
  return out;
}

/** The findings for a spec (#5349): `refusals` stop the build, `warnings` are printed and the pipeline is written. */
export function opWavesQuorumFindings(
  spec: Pick<OpWavesSpec, "waves" | "approvals" | "point">,
  proof: OpWavesProofSources,
  refuseUnprovable: boolean = UNPROVABLE_QUORUM_REFUSED,
): { warnings: string[]; refusals: string[] } {
  const unprovable = opWavesUnprovableQuorum(spec, proof);
  return {
    warnings: [...opWavesQuorumWarnings(spec), ...(refuseUnprovable ? [] : unprovable)],
    refusals: refuseUnprovable ? unprovable : [],
  };
}

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
  const rules = quorumRuleSites(spec.approvals?.quorum, "approvals.quorum");
  const out: string[] = [];
  spec.waves.forEach((wave, i) => {
    const mode = wave.approval ?? "ledger";
    if (!PLAIN_APPROVAL_MODES.includes(mode) || (wave.point ?? spec.point) !== undefined) return;
    for (const [rule, j] of rulesOf(rules, wave)) {
      if (rule.count <= 1 || rule.proven === true || (rule.roles?.length ?? 0) > 0) continue;
      out.push(
        `wave ${i + 1} (${wave.name}): ${j} asks for ${rule.count} approvers under \`${mode}\`, which counts plain \`chant approve\` lines, so one person who can push to chant/lifecycle can meet it alone. Set \`proven: true\` on the rule to count only approvers a seal or a review proves, or use \`approval: "sealed"\``,
      );
    }
  });
  return out;
}
