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
 * - `check-evidence`, with `evidence`, runs in the plan notes pipeline of
 *   the target branch before the note jobs (#4914), and signs each passed
 *   hook of every open merge request's settled check job from its
 *   artifact, as the plan's `<plan job>-evidence` job signs `plan` and
 *   `policy` (#4870). It names the `chant-evidence` environment, which the
 *   runner key's variable is scoped to; the check job names none.
 * - `ref-gate` runs in the plan notes pipeline of the target branch, after
 *   the note jobs, which alone holds the protected token a commit status
 *   needs (#4328): `ref-gate status --open` sets the status of every open
 *   merge request into the branch.
 */

import { GITLAB_DROP_FORGE_TOKENS } from "@intentius/chant/ci-handover";
import { PR_CHECK_ARTIFACT, type PrCheckJob, type PrCheckService, type PrRefGateJob } from "@intentius/chant/components/pr-checks";
import { gitlabTags } from "@intentius/chant/ci-jobs";
import { GITLAB_EVIDENCE_ENVIRONMENT } from "@intentius/chant/ci-evidence-jobs";

/** What {@link gitlabCheckJobs} renders the jobs with. */
export interface GitlabCheckJobsInput {
  image: string;
  /** The check job's lines after the token drop: the engine's setup and the caller's `beforeScript`. */
  setup: string[];
  /** The lines the evidence and ref gate jobs run first: the caller's `beforeScript`. */
  beforeScript: string[];
  /** The merge request pipeline's rule. */
  onMergeRequest: string;
  /** The plan notes pipeline's rule: the signing and status jobs run there (#4914). */
  onPlanNotes: string;
  /**
   * Variables the check job unsets with the forge tokens: the runner key's.
   * Scoped to the `chant-evidence` environment and protected, GitLab hands
   * it to no job of a merge request pipeline (#4914); the unset is for a
   * project that has not scoped it yet.
   */
  unset?: string[];
  check?: PrCheckJob & { runner?: unknown; evidenceRunner?: unknown };
  refGate?: PrRefGateJob & { runner?: unknown };
  /**
   * A workspace member's file (#4964): the line that enters the member's
   * directory, which the evidence and ref gate jobs run first (the check
   * job's `setup` carries it), and the member's directory, which the
   * artifact paths are kept from.
   */
  member?: { enter: string[]; dir: string };
}

/** The check job's service containers as GitLab spells them (#4964): the image, reached by its alias. GitLab does not wait for them. */
export function gitlabCheckServices(services: readonly PrCheckService[]): Array<Record<string, unknown>> {
  return services.map((s) => ({ name: s.image, alias: s.name, ...(s.env && Object.keys(s.env).length > 0 ? { variables: s.env } : {}) }));
}

/** `path`, relative to the member's directory, from the repository root, as GitLab keeps artifacts. */
function fromRoot(member: GitlabCheckJobsInput["member"], path: string): string {
  if (!member || member.dir === "." || member.dir === "") return path;
  return `${member.dir.replace(/\/+$/, "")}/${path.replace(/^\.\/+/, "")}`;
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
  const enter = input.member?.enter ?? [];
  if (check) {
    out.push([
      check.jobName,
      {
        stage: GITLAB_CHECK_STAGES.check,
        image,
        ...tags(check.runner),
        rules: [{ if: input.onMergeRequest }],
        // #4964: the product's service containers, such as the throwaway server its hooks replay into.
        ...(check.services?.length ? { services: gitlabCheckServices(check.services) } : {}),
        variables: check.env,
        // #4295: the hooks run the merge request's code, so the job's shell drops the tokens and the runner key first.
        script: [GITLAB_DROP_FORGE_TOKENS, ...(input.unset?.length ? [`unset ${input.unset.join(" ")}`] : []), ...input.setup, ...(check.before ?? []), check.command],
        artifacts: { name: PR_CHECK_ARTIFACT, when: "always", paths: [fromRoot(input.member, check.dir)] },
      },
    ]);
    if (check.evidence) {
      out.push(gitlabOpenEvidenceJob(check.evidence, { image, runner: check.evidenceRunner, beforeScript: [...enter, ...input.beforeScript], onPlanNotes: input.onPlanNotes, ...(input.member ? { member: input.member } : {}) }));
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
        script: [...enter, ...input.beforeScript, ...refGate.setup, refGate.command],
      },
    ]);
  }
  return out;
}

/**
 * A signing job of the target branch's plan notes pipeline (#4914): the
 * plan's `<plan job>-evidence` or `check-evidence`. It runs `chant ci
 * evidence sign --open` before the note jobs, for every open merge
 * request, names {@link GITLAB_EVIDENCE_ENVIRONMENT} so the runner key's
 * variable can be scoped to it, and keeps each merge request's
 * `evidence.json` for the note job.
 */
export function gitlabOpenEvidenceJob(
  ev: { jobName?: string; lines: string[]; env: Record<string, string>; dir?: string; idTokens?: Record<string, { aud: string }> },
  input: { image: string; runner?: unknown; beforeScript: string[]; onPlanNotes: string; member?: GitlabCheckJobsInput["member"] },
): [string, Record<string, unknown>] {
  const t = gitlabTags(input.runner as Parameters<typeof gitlabTags>[0]);
  return [
    ev.jobName!,
    {
      stage: GITLAB_CHECK_STAGES.evidence,
      image: input.image,
      ...(t ? { tags: t } : {}),
      rules: [{ if: input.onPlanNotes }],
      // The key's variable is scoped to this environment and protected: no job of a merge request pipeline names it.
      environment: { name: GITLAB_EVIDENCE_ENVIRONMENT, action: "access" },
      variables: ev.env,
      // #4869: signing keyless, the job's token for the signing audience.
      ...(ev.idTokens ? { id_tokens: ev.idTokens } : {}),
      // The target branch's commit: the reports are read from the merge requests' artifacts as data.
      script: [...input.beforeScript, ...ev.lines],
      // #4964: a member's job writes in the member's directory, where its note job reads.
      ...(ev.dir ? { artifacts: { when: "always", paths: [fromRoot(input.member, ev.dir)] } } : {}),
    },
  ];
}

/** The stages {@link gitlabCheckJobs}' jobs add after the plan, in order, for a pipeline whose stages are `before`. */
export function withCheckStages(before: readonly string[], jobs: Array<[string, Record<string, unknown>]>, afterNotes: string): string[] {
  const stages = [...before];
  const used = new Set(jobs.map(([, j]) => j.stage as string));
  if (used.has(GITLAB_CHECK_STAGES.evidence) && !stages.includes(GITLAB_CHECK_STAGES.evidence)) stages.splice(stages.indexOf("plan") + 1, 0, GITLAB_CHECK_STAGES.evidence);
  if (used.has(GITLAB_CHECK_STAGES.refGate) && !stages.includes(GITLAB_CHECK_STAGES.refGate)) stages.splice(stages.indexOf(afterNotes) + 1, 0, GITLAB_CHECK_STAGES.refGate);
  return stages;
}
