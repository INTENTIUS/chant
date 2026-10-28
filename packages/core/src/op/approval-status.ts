/**
 * The approval status before merge (#4630): under `approval: pr-review`,
 * `<product>/approval` on an open pull request's head says whether the
 * waves its merge will run wait for an approval.
 *
 * - `pending` while a wave whose gate the plan will hold has no approving
 *   review of that head, by a writer other than its author.
 * - `success` once one has, or when no wave's gate holds the plan.
 *
 * Which waves the gate holds is read the way the wave job reads it after the
 * merge: each `pr-review` wave's policy from the spec at the pull request's
 * base (`readOpWavePolicy`), applied to the facts the head's plans record
 * (`chant run wave --record-plans`, `../lifecycle/wave-plans.ts`): whether a
 * run changes anything and whether a plan is destructive. A head whose plans
 * are not recorded yet is pending, since nothing says its waves pass.
 *
 * The status job reads only: the pull request, its reviews and
 * `chant/lifecycle`. It writes the one commit status. On GitHub and Forgejo
 * it runs after the record-plans job and on every review; on GitLab, whose
 * approvals start no pipeline, a scheduled pipeline of the target branch
 * posts it for every open merge request (`--open`). The status advises: the
 * gate after the merge decides, from the ledger and the merged review.
 */

import { activeProductWords, productStatusContext, type CiProductWords } from "../ci-product-words";
import type { HeadPlans } from "../lifecycle/wave-plans";
import type { PrApproverFilter, PrForge } from "../pr-forge";
import type { OpWaveGatePolicy, OpWavesSpec } from "./op-waves";
import type { OpWaveShowAtBase } from "./op-waves-run";

/** What the status says. */
export interface ApprovalStatus {
  state: "pending" | "success";
  description: string;
  /** The waves whose gate the plan will hold, by number. */
  waits: number[];
  /** Who approved the head, when someone did. */
  approvers: string[];
}

export interface ApprovalStatusInput {
  spec: OpWavesSpec;
  /** The spec's path, which the policy is read from at `base`. */
  specFile: string;
  forge: Pick<PrForge, "prApproved" | "kind">;
  pr: number;
  /** The pull request's head commit. */
  head: string;
  /** The pull request's base commit, which the policy is read at. */
  base: string;
  cwd?: string;
  /** The head's recorded plans. Default: `chant/lifecycle` at `cwd`. */
  readPlans?: (name: string, head: string) => Promise<HeadPlans | null>;
  /** How the spec is read at base. Default `git show`. */
  show?: OpWaveShowAtBase;
  /** Who may approve, as the forge's requires check takes it. */
  approvers?: PrApproverFilter;
}

/** Whether `policy` holds a wave with these facts. A record with no facts reads as changing, so it holds under `always`. */
export function headWaveHolds(policy: OpWaveGatePolicy, facts: { changes?: boolean; destructive?: boolean }): boolean {
  if (policy === "never") return false;
  if (facts.changes === false) return false;
  if (policy === "on-destructive") return facts.destructive === true;
  return true;
}

const short = (sha: string): string => sha.slice(0, 8);
const cut = (text: string): string => (text.length > 135 ? `${text.slice(0, 132)}...` : text);

/** The status for one pull request's head. Throws only when the spec cannot be read at base. */
export async function approvalStatusOf(input: ApprovalStatusInput): Promise<ApprovalStatus> {
  const cwd = input.cwd ?? process.cwd();
  const { readOpWavePolicy } = await import("./op-waves-run");
  const reviewed = input.spec.waves
    .map((w, i) => ({ k: i + 1, wave: w }))
    .filter(({ wave }) => readOpWavePolicy(input.specFile, wave.name, input.base, cwd, ...(input.show ? [input.show] : [])).approval === "pr-review");
  if (reviewed.length === 0) return { state: "success", description: "no wave takes its approval from the pull request's review", waits: [], approvers: [] };
  const plans = await (input.readPlans ?? ((name, head) => ledgerHeadPlans(name, head, cwd)))(input.spec.name, input.head);
  if (!plans) {
    return { state: "pending", description: cut(`the plans of ${short(input.head)} are not recorded yet, so every wave may wait`), waits: reviewed.map((r) => r.k), approvers: [] };
  }
  const waits = reviewed
    .filter(({ k, wave }) => {
      const policy = readOpWavePolicy(input.specFile, wave.name, input.base, cwd, ...(input.show ? [input.show] : [])).policy;
      const facts = plans.waves.find((w) => w.wave === k) ?? {};
      return headWaveHolds(policy, facts);
    })
    .map((r) => r.k);
  if (waits.length === 0) return { state: "success", description: cut(`no wave waits for an approval at ${short(input.head)}`), waits, approvers: [] };
  const which = `wave${waits.length === 1 ? "" : "s"} ${waits.join(", ")}`;
  if (!input.forge.prApproved) return { state: "pending", description: cut(`${which} wait: ${input.forge.kind} cannot say who approved the head`), waits, approvers: [] };
  const approved = await input.forge.prApproved(input.pr, input.head, input.approvers);
  if (approved.passed && approved.approvers.length > 0) {
    return { state: "success", description: cut(`${which} approved at ${short(input.head)} by ${approved.approvers.join(", ")}`), waits, approvers: approved.approvers };
  }
  return { state: "pending", description: cut(`${which} wait: ${approved.reason}`), waits, approvers: [] };
}

/** Post the status on the head. Returns what was posted. */
export async function postApprovalStatus(
  input: ApprovalStatusInput & { forge: Pick<PrForge, "prApproved" | "kind" | "setStatus" | "runUrl"> },
  words: CiProductWords = activeProductWords(),
): Promise<ApprovalStatus> {
  const status = await approvalStatusOf(input);
  await input.forge.setStatus(input.head, {
    context: productStatusContext(words, "approval"),
    state: status.state,
    description: status.description,
    ...(input.forge.runUrl ? { url: input.forge.runUrl } : {}),
  });
  return status;
}

/**
 * Post the status on every open pull request into `branch` (#4630), for
 * GitLab's scheduled pipeline: the forge names each head and base. One
 * that fails is a warning, and the rest are posted.
 */
export async function postOpenApprovalStatuses(
  input: Omit<ApprovalStatusInput, "pr" | "head" | "base"> & { forge: Pick<PrForge, "prApproved" | "kind" | "setStatus" | "runUrl" | "openPullRequests">; branch: string },
  words: CiProductWords = activeProductWords(),
): Promise<{ posted: Array<{ pr: number; status: ApprovalStatus }>; warnings: string[] }> {
  if (!input.forge.openPullRequests) throw new Error(`${input.forge.kind} cannot list its open pull requests, so --open is not for it`);
  const posted: Array<{ pr: number; status: ApprovalStatus }> = [];
  const warnings: string[] = [];
  for (const open of await input.forge.openPullRequests(input.branch)) {
    if (open.fork) continue;
    try {
      const status = await postApprovalStatus({ ...input, pr: open.number, head: open.headSha, base: open.baseSha ?? input.branch }, words);
      posted.push({ pr: open.number, status });
    } catch (err) {
      warnings.push(`!${open.number}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { posted, warnings };
}

async function ledgerHeadPlans(name: string, head: string, cwd: string): Promise<HeadPlans | null> {
  const { gitLedgerReadPort, requireLifecycleLedger } = await import("../lifecycle/git");
  const { readHeadPlans } = await import("../lifecycle/wave-plans");
  await requireLifecycleLedger({ cwd });
  return readHeadPlans(gitLedgerReadPort({ cwd }), name, head);
}
