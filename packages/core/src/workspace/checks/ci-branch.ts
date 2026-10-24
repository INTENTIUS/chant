/**
 * WSP152 (#4325): a member's generated pull-request pipeline targets the
 * branch `ci.branches` routes the member to.
 *
 * `chant build --pr-loop` refuses a branch that disagrees with the route
 * (../member-pipeline.ts), but only when it writes the file. A route changed
 * after the pipeline was generated, or a pipeline edited by hand, goes
 * unnoticed until a push to the wrong branch applies nothing. This check
 * reads the files each member's generated-file record lists and compares what
 * they target with the route. It reads files and never runs them.
 *
 * A pipeline names its target in two places: the `--branch` its record and
 * apply commands carry, and the `branches` of its `push` and `pull_request`
 * triggers. A routed member's pipeline names the route in both. A member with
 * no route may name a branch `ci.branches` does not list, and not one it
 * lists, since that branch applies only the members its globs match.
 */

import type { WorkspaceCheck, WorkspaceDiagnostic } from "../checks";
import type { Member } from "../declaration";
import { routedBranch } from "../ci-branches";
import { GENERATED_RECORD_FILE } from "../member-pipeline";
import { joinPath } from "../tree";
import { parseYAMLDocument } from "../../yaml";
import { read } from "./security";

export const WSP_CI_BRANCH_ROUTE = "WSP152";

/** The finding code WSP152 reports. */
export const CI_BRANCH_FINDING_CODES = ["ci-branch-route-differs"] as const;

const memberDir = (dir: string) => (dir === "." ? "" : dir);

/** A record or apply command of the pull-request loop: `ci run record|apply`, or `components pr-record|pr-apply`. */
const JOB = /\bci\s+run\s+(?:record|apply)\b|\bcomponents\s+pr-(?:record|apply)\b/;
const BRANCH_FLAG = /--branch(?:\s+|=)(?:"([^"]+)"|'([^']+)'|(\S+))/;

/** What a pipeline file says it targets. */
export interface PipelineTargets {
  /** The `--branch` of each record or apply command, by line; null for a command with none. */
  jobs: { line: number; branch: string | null }[];
  /** The branches its `push` and `pull_request` triggers list, by trigger. Absent for a trigger with no list. */
  triggers: { trigger: "push" | "pull_request"; branches: string[] }[];
}

/** The branches a pipeline file targets, read from its text. */
export function pipelineTargets(text: string): PipelineTargets {
  const jobs: PipelineTargets["jobs"] = [];
  text.split("\n").forEach((line, i) => {
    if (!JOB.test(line)) return;
    const m = BRANCH_FLAG.exec(line);
    jobs.push({ line: i + 1, branch: m ? (m[1] ?? m[2] ?? m[3] ?? null) : null });
  });
  const triggers: PipelineTargets["triggers"] = [];
  try {
    const doc = parseYAMLDocument(text) as { on?: unknown; true?: unknown } | null;
    // YAML 1.1 reads a bare `on` key as true.
    const on = doc && typeof doc === "object" ? (doc.on ?? doc.true) : undefined;
    if (on && typeof on === "object" && !Array.isArray(on)) {
      for (const trigger of ["push", "pull_request"] as const) {
        const t = (on as Record<string, unknown>)[trigger];
        const branches = t && typeof t === "object" ? (t as { branches?: unknown }).branches : undefined;
        if (Array.isArray(branches)) triggers.push({ trigger, branches: branches.filter((b): b is string => typeof b === "string") });
      }
    }
  } catch {
    // A file that is not YAML has no triggers to compare; its commands still are.
  }
  return { jobs, triggers };
}

/**
 * What differs between `targets` and the branch `own` the member is routed to
 * (null when it has no route), as sentences. `listed` is every branch
 * `ci.branches` names.
 */
export function routeDifferences(targets: PipelineTargets, own: string | null, listed: readonly string[], member: string): string[] {
  const out: string[] = [];
  const said = (b: string | null): string => (b === null ? "the default branch (it passes no --branch)" : b);
  for (const j of targets.jobs) {
    if (own !== null && j.branch !== own) out.push(`line ${j.line} targets ${said(j.branch)}, and ci.branches routes member ${member} to ${own}`);
    else if (own === null && j.branch !== null && listed.includes(j.branch)) out.push(`line ${j.line} targets ${j.branch}, which ci.branches reserves for the members its globs match, and member ${member} is not one`);
  }
  for (const t of targets.triggers) {
    if (own !== null && !(t.branches.length === 1 && t.branches[0] === own)) out.push(`its ${t.trigger} trigger lists ${t.branches.join(", ") || "no branch"}, and ci.branches routes member ${member} to ${own}`);
    else if (own === null) {
      const reserved = t.branches.filter((b) => listed.includes(b));
      if (reserved.length > 0) out.push(`its ${t.trigger} trigger lists ${reserved.join(", ")}, which ci.branches reserves for the members its globs match, and member ${member} is not one`);
    }
  }
  return out;
}

/** The files a member's generated-file record lists, which are pipelines the check can read. */
function recordedFiles(ctx: Parameters<WorkspaceCheck["check"]>[0], member: Member): string[] {
  const text = read(ctx.tree, joinPath(memberDir(member.dir), GENERATED_RECORD_FILE));
  if (text === null) return [];
  try {
    const parsed = JSON.parse(text) as { files?: { path?: unknown }[] };
    return (parsed.files ?? []).flatMap((f) => (typeof f.path === "string" && /\.ya?ml$/.test(f.path) ? [f.path] : []));
  } catch {
    return [];
  }
}

export const CI_BRANCH_CHECKS: readonly WorkspaceCheck[] = [
  {
    id: WSP_CI_BRANCH_ROUTE,
    name: "ci-branch-route",
    description: "A member's generated pull-request pipeline targets the branch ci.branches routes the member to, in its record and apply commands and its push and pull_request triggers.",
    severity: "error",
    configurable: true,
    check(ctx) {
      const branches = ctx.declaration.ci?.branches;
      if (!branches || Object.keys(branches).length === 0) return [];
      const listed = Object.keys(branches);
      const out: WorkspaceDiagnostic[] = [];
      for (const member of ctx.declaration.members) {
        const own = routedBranch(branches, member.name);
        for (const path of recordedFiles(ctx, member)) {
          const text = read(ctx.tree, path);
          if (text === null) continue;
          for (const why of routeDifferences(pipelineTargets(text), own, listed, member.name)) {
            out.push({
              checkId: this.id,
              severity: this.severity,
              code: CI_BRANCH_FINDING_CODES[0],
              message: `WSP152: ${path}: ${why}; regenerate it with chant build --components --generate <forge> --pr-loop`,
              pointer: "/ci/branches",
              entity: member.name,
              treeFile: path,
              line: 1,
              column: 1,
            });
          }
        }
      }
      return out;
    },
  },
];
