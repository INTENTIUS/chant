/**
 * The approval status before merge (#4630): `<product>/approval` on an open
 * pull request's head says whether the waves its merge will run wait for an
 * approval. It covers the waves whose approval at base is `pr-review` and,
 * under the 2026-10-28 ruling, the waves whose approval is `pull-request`.
 *
 * - `pending` while a wave whose gate the plan will hold has no approval
 *   that would pass it: under `pr-review` an approving review of that head,
 *   by a writer other than its author; under `pull-request` the pull
 *   request's own approval (below).
 * - `success` once every such wave has one, or when no wave's gate holds
 *   the plan.
 *
 * Which waves the gate holds is read the way the wave job reads it after the
 * merge: each wave's approval mode and policy from the spec at the pull
 * request's base (`readOpWavePolicy`), applied to the facts the head's plans
 * record (`chant run wave --record-plans`, `../lifecycle/wave-plans.ts`):
 * whether a run changes anything and whether a plan is destructive. A head
 * whose plans are not recorded yet is pending, since nothing says its waves
 * pass.
 *
 * The pull request's own approval, for a `pull-request` wave: an approval at
 * the pull request's gate (`approvals.pullRequest.gate` at base) whose
 * change set covers the wave's change set at the head, as the merged wave
 * checks it (`planCoveredBy`). The approval is read on the pull request's
 * op (`pr-<n>`), where the product's approve line records it, and on the
 * spec's op, which the merged wave reads. The head's change set is the one
 * `--record-plans` stored for the wave; a record without one is pending.
 *
 * The status job reads only: the pull request, its reviews and
 * `chant/lifecycle`. It writes the one commit status. On GitHub and Forgejo
 * it runs after the record-plans job and on every review; on GitLab, whose
 * approvals start no pipeline, a scheduled pipeline of the target branch
 * posts it for every open merge request (`--open`). An approval recorded on
 * the ledger starts no run on any forge: the next push, review or `--open`
 * run posts it. The status advises: the gate after the merge decides, from
 * the ledger and the merged review.
 */

import { activeProductWords, productStatusContext, type CiProductWords } from "../ci-product-words";
import type { ChangeSetDocument } from "../change-set";
import type { GateResolutionRecord } from "../lifecycle/gate-ledger";
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
  /** The resolutions on one op's gate ledger, for a `pull-request` wave. Default: `chant/lifecycle` at `cwd`. */
  readResolutions?: (op: string) => Promise<GateResolutionRecord[]>;
  /** A stored change set by digest, for a `pull-request` wave. Default: `_change-sets/` on `chant/lifecycle` at `cwd`. */
  changeSets?: (digest: string) => Promise<ChangeSetDocument | undefined>;
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
  const rulesOf = (name: string) => readOpWavePolicy(input.specFile, name, input.base, cwd, ...(input.show ? [input.show] : []));
  const asked = input.spec.waves
    .map((w, i) => ({ k: i + 1, wave: w, rules: rulesOf(w.name) }))
    .filter(({ rules }) => rules.approval === "pr-review" || rules.approval === "pull-request");
  if (asked.length === 0) return { state: "success", description: "no wave takes its approval from the pull request", waits: [], approvers: [] };
  const plans = await (input.readPlans ?? ((name, head) => ledgerHeadPlans(name, head, cwd)))(input.spec.name, input.head);
  if (!plans) {
    return { state: "pending", description: cut(`the plans of ${short(input.head)} are not recorded yet, so every wave may wait`), waits: asked.map((r) => r.k), approvers: [] };
  }
  const factsOf = (k: number) => plans.waves.find((w) => w.wave === k);
  const holding = asked.filter(({ k, rules }) => headWaveHolds(rules.policy, factsOf(k) ?? {}));
  const waits = holding.map((r) => r.k);
  if (waits.length === 0) return { state: "success", description: cut(`no wave waits for an approval at ${short(input.head)}`), waits, approvers: [] };

  const unmet: string[] = [];
  const approvers = new Set<string>();
  // pr-review: one approving review of the head answers every such wave.
  const byReview = holding.filter((r) => r.rules.approval === "pr-review").map((r) => r.k);
  if (byReview.length > 0) {
    const which = wavesLabel(byReview);
    if (!input.forge.prApproved) unmet.push(`${which}: ${input.forge.kind} cannot say who approved the head`);
    else {
      const approved = await input.forge.prApproved(input.pr, input.head, input.approvers);
      if (approved.passed && approved.approvers.length > 0) for (const a of approved.approvers) approvers.add(a);
      else unmet.push(`${which}: ${approved.reason}`);
    }
  }
  // pull-request: the pull request's own approval, whose change set must cover each wave's.
  const byPullRequest = holding.filter((r) => r.rules.approval === "pull-request");
  if (byPullRequest.length > 0) {
    const read = pullRequestApprovalReader(input, cwd);
    for (const { k, rules } of byPullRequest) {
      const got = await read(rules.pullRequestGate, factsOf(k)?.changeSet);
      if (got.approvedBy) approvers.add(got.approvedBy);
      else unmet.push(`wave ${k}: ${got.reason}`);
    }
  }
  const which = wavesLabel(waits);
  if (unmet.length > 0) return { state: "pending", description: cut(`${which} wait: ${unmet.join("; ")}`), waits, approvers: [] };
  const by = [...approvers];
  return { state: "success", description: cut(`${which} approved at ${short(input.head)} by ${by.join(", ")}`), waits, approvers: by };
}

const wavesLabel = (ks: readonly number[]): string => `wave${ks.length === 1 ? "" : "s"} ${ks.join(", ")}`;

/**
 * How a `pull-request` wave's approval is found before merge: the newest
 * approval at the pull request's gate, on the pull request's op or the
 * spec's, whose change set covers the wave's change set at the head.
 */
function pullRequestApprovalReader(input: ApprovalStatusInput, cwd: string) {
  const resolutionsOf = input.readResolutions ?? ((op: string) => ledgerResolutions(op, cwd));
  const changeSetOf = input.changeSets ?? ((digest: string) => ledgerChangeSet(digest, cwd));
  let all: Promise<GateResolutionRecord[]> | undefined;
  const resolutions = () =>
    (all ??= (async () => {
      // The pull request's op, as `prOp` (../pr-loop.ts) names it, and the spec's.
      const ops = [...new Set([`pr-${input.pr}`, input.spec.name])];
      return (await Promise.all(ops.map((op) => resolutionsOf(op)))).flat();
    })());
  return async (gate: string | undefined, digest: string | undefined): Promise<{ approvedBy?: string; reason: string }> => {
    if (!gate) return { reason: "the spec at base names no approvals.pullRequest.gate" };
    if (!digest) return { reason: `the plans of ${short(input.head)} carry no change set to check the pull request's approval against` };
    const fresh = await changeSetOf(digest).catch(() => undefined);
    if (!fresh) return { reason: `the change set ${digest} of ${short(input.head)} is not stored` };
    const approvals = (await resolutions()).filter((r) => r.gate === gate && (r.changeSet ?? r.planDigest)).sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
    if (approvals.length === 0) return { reason: `the pull request's gate ${gate} has no approval` };
    const { planCoveredBy } = await import("../components/pr-run");
    let reason = `no approval at ${gate} covers its plans`;
    for (const r of approvals) {
      const approvedDigest = (r.changeSet ?? r.planDigest)!;
      const approved = approvedDigest === fresh.digest ? fresh : await changeSetOf(approvedDigest).catch(() => undefined);
      if (!approved) {
        reason = `the change set ${approvedDigest} the approval at ${gate} names is not stored`;
        continue;
      }
      const why = fresh.members.map((m) => planCoveredBy(approved, fresh, m.member)).find((w) => w !== undefined);
      if (why === undefined) return { approvedBy: r.resolvedBy, reason: "" };
      reason = why;
    }
    return { reason };
  };
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

async function ledgerResolutions(op: string, cwd: string): Promise<GateResolutionRecord[]> {
  const { readGateLedger } = await import("../lifecycle/gate-ledger");
  return (await readGateLedger(op, { cwd })).resolutions;
}

async function ledgerChangeSet(digest: string, cwd: string): Promise<ChangeSetDocument | undefined> {
  const { readStoredChangeSet } = await import("../lifecycle/change-set-store");
  const got = await readStoredChangeSet(digest, { cwd });
  return got.status === "found" ? got.document : undefined;
}
