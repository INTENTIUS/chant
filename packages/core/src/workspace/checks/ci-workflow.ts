/**
 * WSP151 (#4168 step 6): what a member under `ci.workflow` still lacks.
 *
 * A declaration that names no workflow gets no finding from this file. The
 * requirements and their codes are {@link CI_WORKFLOW_REQUIREMENTS}
 * (../ci-workflow.ts). Like the security checklists (./security.ts), the
 * check reads files and never runs them: `chant.config.ts` for the
 * environments (its literal `environments`, as `workspace status` reads it),
 * `*.component.ts` for components and gates, and the forge pipeline files for
 * the jobs. A generated file that differs from what its generator writes is
 * WSP101 to WSP106's to report; this check asks only whether the jobs the
 * workflow needs are there.
 */

import type { WorkspaceCheck, WorkspaceDiagnostic } from "../checks";
import type { CiWorkflow, Member } from "../declaration";
import { appliesOnMerge, STUB_MARKER, workflowOf, type CiWorkflowCode } from "../ci-workflow";
import { matchesCheckRun } from "../ci-green";
import { staticPromotionOrder } from "../promotion-order";
import { joinPath } from "../tree";
import { allPipelineFiles, commandLines, componentFiles, read } from "./security";

export const WSP_CI_WORKFLOW = "WSP151";

const memberDir = (dir: string) => (dir === "." ? "" : dir);

const PLAN = /\bci\s+run\s+plan\b|\bcomponents\s+pr-plan\b/;
const RECORD = /\bci\s+run\s+record\b|\bcomponents\s+pr-record\b/;
const APPLY = /\bci\s+run\s+apply\b|\bcomponents\s+pr-apply\b/;
const TICK = /\bci\s+tick\b/;
const PUBLISH = /\brelease\s+publish\b/;

/** The apply job names a required phase could match. */
const APPLY_JOB_NAMES = ["apply", "pr-apply"];

export const CI_WORKFLOW_CHECKS: readonly WorkspaceCheck[] = [
  {
    id: WSP_CI_WORKFLOW,
    name: "ci-workflow",
    description: "Under ci.workflow: ci.green with pre-merge phases and no apply job required, each member with a component, environments and a gate on each component, and pipeline files that plan, record (or apply under apply on merge), tick and publish.",
    severity: "warning",
    configurable: true,
    check(ctx) {
      const d = ctx.declaration;
      const under = d.members
        .map((m) => ({ member: m, workflow: workflowOf(d, m) }))
        .filter((u): u is { member: Member; workflow: CiWorkflow } => u.workflow !== null)
        // The top level's workflow covers the members that build with chant; a member that names one itself is held to it.
        .filter((u) => u.member.ciWorkflow !== null || ctx.tree.stat(joinPath(memberDir(u.member.dir), "chant.config.ts")) === "file");
      if (under.length === 0 && !d.ci?.workflow) return [];
      const pointer = d.ci?.workflow ? "/ci/workflow" : `${under[0]!.member.pointer}/ci/workflow`;
      const out: WorkspaceDiagnostic[] = [];
      const finding = (code: CiWorkflowCode, message: string, at: { pointer?: string; entity?: string; treeFile?: string; line?: number } = {}): void => {
        out.push({
          checkId: this.id,
          severity: this.severity,
          code,
          message: `${code}: ${message}`,
          pointer: at.pointer ?? pointer,
          ...(at.entity !== undefined ? { entity: at.entity } : {}),
          ...(at.treeFile !== undefined ? { treeFile: at.treeFile, line: at.line ?? 1, column: 1 } : {}),
        });
      };

      const green = d.ci?.green ?? null;
      if (!green) {
        finding("ci-workflow-green-undeclared", "the workspace follows a ci.workflow and declares no ci.green, so no commit gets a verdict and no release can be cut; run chant ci init or add a ci.green block");
      } else {
        if ((green.preMerge ?? []).length === 0) {
          finding("ci-workflow-no-pre-merge", "ci.green.preMerge names no phase, so nothing says which checks run before the branch moves; name the quick ones", { pointer: green.pointer });
        }
        for (const name of green.require) {
          const phase = green.phases.find((p) => p.name === name);
          const hit = phase?.runs.find((pattern) => APPLY_JOB_NAMES.some((job) => matchesCheckRun(pattern, job)));
          if (phase && hit) {
            finding("ci-workflow-apply-in-green", `the required phase ${name} matches the apply job with ${JSON.stringify(hit)}, so an apply that waits for a green commit would wait on itself; drop the pattern`, { pointer: phase.pointer });
          }
        }
      }

      for (const { member } of under) {
        const dir = memberDir(member.dir);
        const components = componentFiles(ctx.tree, dir);
        if (components.length === 0) {
          finding("ci-workflow-no-components", `member ${member.name} declares no component, so nothing of it can be cut or promoted; chant ci init writes a stub`, { pointer: member.pointer, entity: member.name });
        } else if (components.every((f) => (read(ctx.tree, f) ?? "").includes(STUB_MARKER))) {
          finding("ci-workflow-no-components", `member ${member.name}'s only component is the stub chant ci init wrote (${components[0]}); say how it is built and deployed, then delete its ${STUB_MARKER} line`, { pointer: member.pointer, entity: member.name, treeFile: components[0] });
        }
        const configPath = joinPath(dir, "chant.config.ts");
        const config = read(ctx.tree, configPath);
        // A config whose environments aren't literals can't be read without running it; say nothing rather than guess.
        const order = config === null ? [] : staticPromotionOrder(config);
        if (order !== undefined && order.length === 0) {
          finding("ci-workflow-no-environments", `member ${member.name}'s chant.config.ts declares no environments, so a release has nowhere to be promoted to`, { pointer: member.pointer, entity: member.name, ...(config !== null ? { treeFile: configPath } : {}) });
        }
        for (const file of components) {
          const text = read(ctx.tree, file) ?? "";
          if (/\bgate\s*\(|kind\s*:\s*["']gate["']/.test(text)) continue;
          const last = order && order.length > 0 ? order[order.length - 1]!.name : "the last environment";
          finding("ci-workflow-ungated-env", `${file} has no gate, so a promote to ${last} waits on no approval; add a gate() step`, { pointer: member.pointer, entity: member.name, treeFile: file });
        }
      }

      const files = allPipelineFiles(ctx);
      const has = (re: RegExp) => files.some((f) => f.lines.some((l) => re.test(l)));
      const applyOnMerge = under.some((u) => appliesOnMerge(u.workflow)) || (d.ci?.workflow ? appliesOnMerge(d.ci.workflow) : false);
      const missing = [
        ...(has(PLAN) ? [] : ["a plan job (ci run plan)"]),
        ...(has(RECORD) || has(APPLY) ? [] : [applyOnMerge ? "an apply job (ci run apply)" : "a record job (ci run record)"]),
        ...(has(TICK) ? [] : ["chant ci tick"]),
      ];
      if (missing.length > 0) {
        finding("ci-workflow-pipeline-missing", `no pipeline file runs ${missing.join(", ")}; generate them with chant build --components --generate <forge> --pr-loop and chant ci workflow`);
      }
      if (!applyOnMerge) {
        for (const l of commandLines(ctx, APPLY)) {
          finding("ci-workflow-pipeline-differs", `${l.path} applies on merge, and the workflow is trunk-curated, where a merge records the plan and deploys nothing; regenerate without --apply-on-merge, or set ci.workflow to trunk-curated+apply-on-merge`, { treeFile: l.path, line: l.line });
        }
      } else if (!has(APPLY) && has(RECORD)) {
        const l = commandLines(ctx, RECORD)[0]!;
        finding("ci-workflow-pipeline-differs", `${l.path} records on merge, and the workflow is trunk-curated+apply-on-merge; regenerate with --apply-on-merge`, { treeFile: l.path, line: l.line });
      }
      if (!has(PUBLISH)) {
        finding("ci-workflow-publish-missing", "no pipeline file runs chant release publish, so a cut release is never published; generate one with chant release workflow");
      }
      return out;
    },
  },
];
