/**
 * Check evidence in an Op waves job (#4870).
 *
 * - `evidence.requires` in the spec at base names the checks whose current
 *   evidence a wave's commit needs before anything in it is planned or
 *   applied, such as `["plan", "policy"]`, which the pull request's plan
 *   note job signed for the head's tree. A commit without it is refused,
 *   and the refusal names each missing check. Read at base, so a change
 *   cannot drop the rule for its own apply.
 * - With a runner key in `CHANT_RUNNER_KEY`, the deciding job signs its own
 *   two named checks once the wave is planned: `plan:<wave>`, and
 *   `policy:<wave>` when `ci.policy` ran over the plans and denied nothing.
 *   They are attached under `refs/notes/chant/evidence` and pushed, where #4867's ref gate
 *   and a later wave read them.
 *
 * See ../workspace/trust/check-evidence.ts.
 */

import { execFileSync } from "node:child_process";
import type { OpRunPolicyRow } from "./runtime";
export { opWavesEvidenceProblems, type OpWavesEvidence } from "./op-waves-evidence-spec";
import { CHECK_EVIDENCE_KEY_ENV, missingCheckEvidence, recordChecks, runnerKeyEvidenceSigner, signChecks } from "../workspace/trust/check-evidence";

function top(cwd: string): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Why the wave's commit is refused for want of evidence, or null. */
export async function opWaveEvidenceRefusal(cwd: string, head: string, base: string, requires: readonly string[] | undefined): Promise<string | null> {
  if (!requires || requires.length === 0) return null;
  return missingCheckEvidence(top(cwd), head, base, requires);
}

/**
 * Sign the wave's plan and policy checks when the job holds a runner key.
 * Never fails the wave: a key the policy at base does not list, or a
 * notes push that does not land, is a line in the log.
 */
export async function signOpWaveChecks(input: { cwd: string; head: string; base: string; wave: string; planDigest?: string; policyRows: ReadonlyMap<string, OpRunPolicyRow>; log: (line: string) => void; env?: NodeJS.ProcessEnv; push?: boolean }): Promise<string[]> {
  const pem = (input.env ?? process.env)[CHECK_EVIDENCE_KEY_ENV];
  if (!pem) return [];
  try {
    const repo = top(input.cwd);
    const signer = runnerKeyEvidenceSigner(repo, input.base, pem);
    const rows = [...input.policyRows.values()];
    const checks: Array<{ check: string; claim?: string }> = [{ check: `plan:${input.wave}`, ...(input.planDigest ? { claim: input.planDigest } : {}) }];
    if (rows.length > 0 && rows.every((r) => r.result !== "denied")) checks.push({ check: `policy:${input.wave}`, claim: JSON.stringify(rows) });
    const signed = signChecks(repo, input.head, checks, signer);
    const pushed = await recordChecks(repo, signed, { push: input.push !== false });
    if (input.push !== false && !pushed.pushed && pushed.pushWarning) input.log(`wave ${input.wave}: ${pushed.pushWarning}`);
    input.log(`wave ${input.wave}: signed evidence for ${signed.map((s) => s.check).join(", ")} as ${signer.principal}`);
    return signed.map((s) => s.check);
  } catch (err) {
    input.log(`wave ${input.wave}: no check evidence signed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}
