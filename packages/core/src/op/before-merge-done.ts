/**
 * The job after a before-merge run's last wave (#4984): `chant run wave --op
 * <op> --wave <last> --merge auto|manual --forge <kind>`, at the default
 * branch's commit, with every wave job's outcome file.
 *
 * It reads the decision the run names again (./before-merge.ts) and checks
 * every wave applied: the outcomes add up to `applied` or `unchanged`, and
 * the decision ran every wave. Then, with `auto`, it asks the forge whether
 * the pull request is still approved at the decided head, merges it only
 * at that head (`mergeAfterApply`, ../pr-merge.ts: open, head unmoved),
 * releases the change's locks and replies. With `manual` it replies that
 * the head applied, and the locks hold until the pull request merges or
 * closes, when the unlock job releases them. A refusal is posted on the
 * pull request and the job exits `waiting` (3), so the run shows it.
 */

import { CHANT_EXIT } from "../exit-codes";
import type { CiProductWords } from "../ci-product-words";
import type { ApplyOutcomeSummary } from "../control/applied";
import type { PrForge } from "../pr-forge";
import { mergeAfterApply } from "../pr-merge";
import { beforeMergeProblems, type BeforeMergeRecord, type BeforeMergeRun } from "./before-merge";

/** What {@link beforeMergeDone} takes. */
export interface BeforeMergeDoneInput {
  op: string;
  /** How many waves the spec has. */
  waves: number;
  run: BeforeMergeRun;
  record: BeforeMergeRecord | undefined;
  /** The waves' outcome, from every job's outcome file. */
  outcome: ApplyOutcomeSummary;
  merge: "auto" | "manual";
  /** The job's client: it replies and reads the approval. */
  forge: Pick<PrForge, "kind" | "addComment"> & Partial<Pick<PrForge, "prApproved">>;
  /** The client holding the merge token (`auto`); default `forge`. */
  merger?: Pick<PrForge, "kind" | "mergePullRequest" | "pullRequestHead" | "upsertComment">;
  /** Release every lock the pull request holds; the targets released. */
  release(pr: number): Promise<string[]>;
  words: CiProductWords;
}

/** What the job did: its exit and its line. */
export interface BeforeMergeDone {
  code: number;
  text: string;
  merged?: boolean;
}

const short = (sha: string): string => sha.slice(0, 12);

/** Check the run and its waves, then merge or say it is ready (#4984). Throws only when the reply cannot be posted. */
export async function beforeMergeDone(i: BeforeMergeDoneInput): Promise<BeforeMergeDone> {
  const problems = beforeMergeProblems(i.op, i.run, i.record);
  if (problems.length > 0) return { code: CHANT_EXIT.misplaced, text: problems.join("; ") };
  const r = i.record!;
  const at = i.forge.kind === "gitlab" ? `!${r.pr}` : `pull request ${r.pr}`;
  const verb = i.words.verbs.apply;
  const say = async (text: string, code: number, merged?: boolean): Promise<BeforeMergeDone> => {
    await i.forge.addComment(r.pr, `${i.words.product}: ${text}`);
    return { code, text, ...(merged !== undefined ? { merged } : {}) };
  };
  if (r.through !== undefined && r.through < i.waves) {
    return say(`${verb[1]} ${i.op} through wave ${r.through} of ${i.waves} at ${at}'s head ${short(r.head)}; the waves after it wait until the ${verb[0]} is asked for again without a wave, so nothing is merged`, CHANT_EXIT.done);
  }
  if (i.outcome.outcome !== "applied" && i.outcome.outcome !== "unchanged") {
    return say(`the waves of ${i.op} at ${at}'s head ${short(r.head)} ended ${i.outcome.outcome}, so nothing is merged; each wave's job says why`, CHANT_EXIT.waiting);
  }
  if (i.merge === "manual") {
    return say(`every wave of ${i.op} ${verb[1]} ${at}'s head ${short(r.head)}. Merge it when you are ready; its locks hold until it merges or closes`, CHANT_EXIT.done);
  }
  // The approval is read again for the head that applied: one taken back since does not merge.
  if (i.forge.prApproved) {
    const approval = await i.forge.prApproved(r.pr, r.head);
    if (!approval.passed) return say(`every wave of ${i.op} ${verb[1]} ${at}'s head ${short(r.head)}, and it was not merged: it is not approved at that head (${approval.reason}). Merge it by hand once it is`, CHANT_EXIT.waiting, false);
  }
  const merger = i.merger ?? (i.forge as unknown as NonNullable<BeforeMergeDoneInput["merger"]>);
  const merged = await mergeAfterApply({ forge: merger, pr: r.pr, head: r.head, recorded: { pushed: true }, words: i.words });
  if (!merged.merged) return { code: CHANT_EXIT.waiting, text: `${at} was not merged: ${merged.reason ?? "the forge refused"}${merged.posted ? "; the reason is posted on it" : ""}`, merged: false };
  let released: string[] = [];
  let kept = "";
  try {
    released = await i.release(r.pr);
  } catch (e) {
    kept = `; its locks could not be released (${e instanceof Error ? e.message : String(e)}), and the unlock job releases them on close`;
  }
  const locks = released.length > 0 ? ` and released its locks on ${released.join(", ")}` : "";
  return say(`every wave of ${i.op} ${verb[1]} ${at}'s head ${short(r.head)}: merged it${merged.sha ? ` as ${short(merged.sha)}` : ""}${locks}${kept}`, CHANT_EXIT.done, true);
}
