/**
 * The prescribed delivery workflows (#4168 section 7): `ci.workflow` in the
 * declaration, at the top level or on a member, which wins.
 *
 * `trunk-curated`: a merge records the plan and deploys nothing (#4168 4.1),
 * the quick checks run before the branch moves (4.4), and a release is cut
 * from a green commit and promoted through the member's environments, gated
 * in the last (4.2). `trunk-curated+apply-on-merge` is the same, and each
 * newest green commit is also applied (section 5, step 9).
 *
 * A workflow requires no security group: those are opt-in on their own
 * (./security.ts). `chant workspace check` reports what a member under a
 * workflow still lacks (./checks/ci-workflow.ts, WSP151), and `chant ci
 * init` writes what it can. {@link CI_WORKFLOW_REQUIREMENTS} is the table the
 * reference page prints.
 */
import type { CiWorkflow, Declaration, Member } from "./declaration";

/** The marker a component stub `chant ci init` writes carries until someone fills it in. WSP151 reports a member whose only components carry it. */
export const STUB_MARKER = "TODO(chant ci init)";

export const CI_WORKFLOWS = ["trunk-curated", "trunk-curated+apply-on-merge"] as const satisfies readonly CiWorkflow[];

/** Whether `workflow` turns the apply on merge back on. */
export function appliesOnMerge(workflow: CiWorkflow): boolean {
  return workflow === "trunk-curated+apply-on-merge";
}

/** The workflow `member` follows: its own `ci.workflow`, else the top level's, else null. */
export function workflowOf(declaration: Pick<Declaration, "ci">, member: Pick<Member, "ciWorkflow"> | null): CiWorkflow | null {
  return member?.ciWorkflow ?? declaration.ci?.workflow ?? null;
}

/** One requirement of the workflows, with the `workspace check` code that reports it missing. */
export interface CiWorkflowRequirement {
  /** The reason code WSP151 reports. */
  code: string;
  /** What the workflow needs. */
  requirement: string;
  /** What adds it. */
  fix: string;
  /** Whether it applies per member (true) or once for the workspace. */
  perMember: boolean;
}

/**
 * Every requirement, in the order `workspace check` reports them. The
 * reference page's table is printed from this list (`ciWorkflowTable`), and a
 * test compares the two.
 */
export const CI_WORKFLOW_REQUIREMENTS = [
  { code: "ci-workflow-green-undeclared", requirement: "`ci.green` is declared, so commits get a verdict and a release is cut only from a green one", fix: "`chant ci init`, or a hand-written `ci.green` block", perMember: false },
  { code: "ci-workflow-no-pre-merge", requirement: "`ci.green.preMerge` names at least one phase, the quick checks that run before the branch moves", fix: "`preMerge` in `ci.green`", perMember: false },
  { code: "ci-workflow-apply-in-green", requirement: "no phase in `ci.green.require` matches an apply job, which would wait on its own verdict", fix: "drop the apply job's pattern from the required phases", perMember: false },
  { code: "ci-workflow-no-components", requirement: "the member declares a component (`*.component.ts`)", fix: "`chant ci init` writes a stub", perMember: true },
  { code: "ci-workflow-no-environments", requirement: "the member's `chant.config.ts` declares `environments`, the promotion order", fix: "`environments` in `chant.config.ts`", perMember: true },
  { code: "ci-workflow-ungated-env", requirement: "each component has a gate, so a promote to the last environment waits on an approval", fix: "a `gate()` step in the component", perMember: true },
  { code: "ci-workflow-pipeline-missing", requirement: "a pipeline file runs the plan job, the record job (`ci run record`) and `chant ci tick`", fix: "`chant build --components --generate <forge> --pr-loop` and `chant ci workflow`", perMember: false },
  { code: "ci-workflow-pipeline-differs", requirement: "the pipeline matches the workflow: no apply job under `trunk-curated`, and under `trunk-curated+apply-on-merge` an apply job that applies the newest green commit, not each merge", fix: "regenerate the pull-request pipeline, with `--apply-on-merge` only under apply on merge", perMember: false },
  { code: "ci-workflow-publish-missing", requirement: "a pipeline file runs `chant release publish`", fix: "`chant release workflow`", perMember: false },
] as const satisfies readonly CiWorkflowRequirement[];

export type CiWorkflowCode = (typeof CI_WORKFLOW_REQUIREMENTS)[number]["code"];

export const CI_WORKFLOW_FINDING_CODES = CI_WORKFLOW_REQUIREMENTS.map((r) => r.code) as readonly CiWorkflowCode[];

/** The requirements table the reference page carries, row for row. */
export function ciWorkflowTable(): string {
  const rows = CI_WORKFLOW_REQUIREMENTS.map((r) => `| \`${r.code}\` | ${r.requirement} | ${r.perMember ? "each member" : "the workspace"} | ${r.fix} |`);
  return ["| Code | Requirement | Checked for | Added by |", "|---|---|---|---|", ...rows].join("\n");
}
