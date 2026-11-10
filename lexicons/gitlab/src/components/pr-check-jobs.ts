/**
 * The check job, the check evidence job and the ref gate's status job on
 * GitLab CI (#4935), from chant's descriptors
 * (`@intentius/chant/components/pr-checks`), for the merge request loop's
 * pipeline and the product plan pipeline alike.
 *
 * - `check` runs in the merge request pipeline beside the plan, drops the
 *   forge tokens and the runner key's variable before any of the change's
 *   code runs (#4295), runs `chant ci check`, and keeps `.chant/check` as
 *   its artifact.
 * - `check-evidence`, with `evidence`, runs once the check job succeeded,
 *   from its artifact, and signs each passed hook, as the plan's
 *   `<plan job>-evidence` job signs `plan` and `policy` (#4870).
 * - `ref-gate` runs in the plan notes pipeline of the target branch, after
 *   the note jobs, which alone holds the protected token a commit status
 *   needs (#4328): `ref-gate status --open` sets the status of every open
 *   merge request into the branch.
 */

import { GITLAB_DROP_FORGE_TOKENS } from "@intentius/chant/ci-handover";
import { PR_CHECK_ARTIFACT, type PrCheckJob, type PrRefGateJob } from "@intentius/chant/components/pr-checks";
import { gitlabTags } from "@intentius/chant/ci-jobs";

/** What {@link gitlabCheckJobs} renders the jobs with. */
export interface GitlabCheckJobsInput {
  image: string;
  /** The check job's lines after the token drop: the engine's setup and the caller's `beforeScript`. */
  setup: string[];
  /** The lines the evidence and ref gate jobs run first: the caller's `beforeScript`. */
  beforeScript: string[];
  /** The merge request pipeline's rule. */
  onMergeRequest: string;
  /** The rule of the jobs that hold a key: `onMergeRequest`, and with `forks: "skip"` the project's own. Default `onMergeRequest`. */
  onTrustedMergeRequest?: string;
  /** The plan notes pipeline's rule. */
  onPlanNotes: string;
  /** Variables the check job unsets with the forge tokens: the runner key's, which GitLab hands every job. */
  unset?: string[];
  check?: PrCheckJob & { runner?: unknown; evidenceRunner?: unknown };
  refGate?: PrRefGateJob & { runner?: unknown };
}

/** The stages the jobs run in: the check beside the plan, the evidence after it, the ref gate after the notes. */
export const GITLAB_CHECK_STAGES = { check: "plan", evidence: "evidence", refGate: "ref-gate" } as const;

/** The jobs as GitLab entries, in order: check, check-evidence, ref-gate, those asked for. */
export function gitlabCheckJobs(input: GitlabCheckJobsInput): Array<[string, Record<string, unknown>]> {
  const { image, check, refGate } = input;
  const tags = (runner: unknown): Record<string, unknown> => {
    const t = gitlabTags(runner as Parameters<typeof gitlabTags>[0]);
    return t ? { tags: t } : {};
  };
  const out: Array<[string, Record<string, unknown>]> = [];
  if (check) {
    out.push([
      check.jobName,
      {
        stage: GITLAB_CHECK_STAGES.check,
        image,
        ...tags(check.runner),
        rules: [{ if: input.onMergeRequest }],
        variables: check.env,
        // #4295: the hooks run the merge request's code, so the job's shell drops the tokens and the runner key first.
        script: [GITLAB_DROP_FORGE_TOKENS, ...(input.unset?.length ? [`unset ${input.unset.join(" ")}`] : []), ...input.setup, check.command],
        artifacts: { name: PR_CHECK_ARTIFACT, when: "always", paths: [check.dir] },
      },
    ]);
    if (check.evidence) {
      const ev = check.evidence;
      out.push([
        ev.jobName,
        {
          stage: GITLAB_CHECK_STAGES.evidence,
          image,
          ...tags(check.evidenceRunner),
          rules: [{ if: input.onTrustedMergeRequest ?? input.onMergeRequest }],
          needs: [{ job: check.jobName, artifacts: true }],
          variables: ev.env,
          // #4869: signing keyless, the job's token for the signing audience.
          ...(ev.idTokens ? { id_tokens: ev.idTokens } : {}),
          script: [...input.beforeScript, ...ev.lines],
        },
      ]);
    }
  }
  if (refGate) {
    out.push([
      refGate.jobName,
      {
        stage: GITLAB_CHECK_STAGES.refGate,
        image,
        ...tags(refGate.runner),
        rules: [{ if: input.onPlanNotes }],
        ...(Object.keys(refGate.env).length > 0 ? { variables: refGate.env } : {}),
        // The target branch's commit: the policy at base, and none of a merge request's code.
        script: [...input.beforeScript, ...refGate.setup, refGate.command],
      },
    ]);
  }
  return out;
}

/** The stages {@link gitlabCheckJobs}' jobs add after the plan, in order, for a pipeline whose stages are `before`. */
export function withCheckStages(before: readonly string[], jobs: Array<[string, Record<string, unknown>]>, afterNotes: string): string[] {
  const stages = [...before];
  const used = new Set(jobs.map(([, j]) => j.stage as string));
  if (used.has(GITLAB_CHECK_STAGES.evidence) && !stages.includes(GITLAB_CHECK_STAGES.evidence)) stages.splice(stages.indexOf("plan") + 1, 0, GITLAB_CHECK_STAGES.evidence);
  if (used.has(GITLAB_CHECK_STAGES.refGate) && !stages.includes(GITLAB_CHECK_STAGES.refGate)) stages.splice(stages.indexOf(afterNotes) + 1, 0, GITLAB_CHECK_STAGES.refGate);
  return stages;
}
