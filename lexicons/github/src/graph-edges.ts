/**
 * GitHub Actions dependencies as graph edges (#3910).
 *
 * `chant graph` draws an edge for every typed reference it can find, and a
 * workflow has almost none: a job names the jobs it waits for, the reusable
 * workflow it calls and the workflows that trigger it as strings. This module
 * resolves those strings against the declared entities, the way the
 * serializer would place them, and reports each one through the plugin's
 * `graphEdges` hook:
 *
 *  - `needs`    job -> job in the same workflow
 *  - `calls`    job -> the workflow a `uses: ./.github/workflows/<file>` names,
 *               and job -> a composite action a step uses by local path
 *  - `triggers` workflow -> each workflow its `on.workflow_run.workflows` names
 *
 * A string that names nothing declared (another repository's workflow, a
 * typo'd job, a composite action, which chant does not declare) is reported
 * as dangling, never matched to a near name.
 *
 * Forgejo reuses this module: its entities are github entities, and Forgejo
 * reads reusable workflows from `.forgejo/workflows/` as well.
 */

import type { Declarable } from "@intentius/chant/declarable";
import { isPropertyDeclarable } from "@intentius/chant/declarable";
import type { LexiconGraphEdges, LexiconGraphReference } from "@intentius/chant/graph-ir";

const WORKFLOW = "GitHub::Actions::Workflow";
const JOB_TYPES = new Set(["GitHub::Actions::Job", "GitHub::Actions::ReusableWorkflowCallJob"]);

function toKebabCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

function entityType(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const t = (value as { entityType?: unknown }).entityType;
  return typeof t === "string" ? t : undefined;
}

/** A Declarable's props bag, or the plain object itself (JSON-style jobs and steps). */
function propsOf(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const props = (value as { props?: unknown }).props;
  if (entityType(value) !== undefined) {
    return props && typeof props === "object" ? (props as Record<string, unknown>) : undefined;
  }
  return value as Record<string, unknown>;
}

/** One job as the serializer places it: its YAML key and the node it is, if any. */
interface PlacedJob {
  key: string;
  node?: string;
  props: Record<string, unknown>;
}

interface PlacedWorkflow {
  name: string;
  props: Record<string, unknown>;
  jobs: PlacedJob[];
}

/**
 * Which jobs land in which workflow, mirroring ./serializer.ts: a workflow's
 * own `jobs:` map when it has one, and otherwise the standalone Job exports,
 * which go to the first workflow only.
 */
function placeJobs(entities: ReadonlyMap<string, Declarable>): { workflows: PlacedWorkflow[]; orphans: PlacedJob[] } {
  const names = new Map<unknown, string>();
  const workflows: Array<[string, Declarable]> = [];
  const standalone: PlacedJob[] = [];
  for (const [name, entity] of entities) {
    names.set(entity, name);
    if (isPropertyDeclarable(entity)) continue;
    const type = entityType(entity);
    if (type === WORKFLOW) workflows.push([name, entity]);
    else if (type && JOB_TYPES.has(type)) standalone.push({ key: toKebabCase(name), node: name, props: propsOf(entity) ?? {} });
  }

  const placed: PlacedWorkflow[] = workflows.map(([name, wf], i) => {
    const props = propsOf(wf) ?? {};
    const inline: PlacedJob[] = [];
    const jobs = props.jobs;
    if (jobs && typeof jobs === "object" && !Array.isArray(jobs)) {
      for (const [key, value] of Object.entries(jobs as Record<string, unknown>)) {
        const jobProps = propsOf(value);
        if (!jobProps) continue;
        inline.push({ key: toKebabCase(key), node: names.get(value), props: jobProps });
      }
    }
    return { name, props, jobs: inline.length > 0 ? inline : i === 0 ? standalone : [] };
  });
  return { workflows: placed, orphans: workflows.length === 0 ? standalone : [] };
}

/** The file a declared workflow is written to. Every workflow after the first
 * is `<kebab-name>.yml` (./serializer.ts); the first is written to the
 * `--output` path, which the examples and templates name the same way. */
function workflowFile(name: string): string {
  return `${toKebabCase(name)}.yml`;
}

const stripYamlExt = (file: string): string => file.replace(/\.ya?ml$/, "");

/** `needs:` as a list of job keys. A Job object held directly names itself. */
function needsKeys(needs: unknown, names: Map<unknown, string>): string[] {
  const list = Array.isArray(needs) ? needs : needs === undefined ? [] : [needs];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item === "string") out.push(item);
    else if (names.has(item)) out.push(toKebabCase(names.get(item)!));
  }
  return out;
}

/** `on.workflow_run.workflows`, read from the camelCase or snake_case key. */
function workflowRunNames(on: unknown): string[] {
  const triggers = propsOf(on);
  if (!triggers) return [];
  const run = propsOf(triggers.workflow_run ?? triggers.workflowRun);
  const workflows = run?.workflows;
  if (typeof workflows === "string") return [workflows];
  return Array.isArray(workflows) ? workflows.filter((w): w is string => typeof w === "string") : [];
}

/** The graph edges and pipeline membership a GitHub (or Forgejo) project declares. */
export function githubGraphEdges(entities: ReadonlyMap<string, Declarable>): LexiconGraphEdges | undefined {
  const { workflows, orphans } = placeJobs(entities);
  if (workflows.length === 0 && orphans.length === 0) return undefined;

  const names = new Map<unknown, string>();
  for (const [name, entity] of entities) names.set(entity, name);

  const byFile = new Map<string, string>();
  const byDisplayName = new Map<string, string>();
  for (const wf of workflows) {
    byFile.set(stripYamlExt(workflowFile(wf.name)), wf.name);
    if (typeof wf.props.name === "string") byDisplayName.set(wf.props.name, wf.name);
  }

  const references: LexiconGraphReference[] = [];
  const pipelines: Record<string, string[]> = {};

  const visitJobs = (jobs: PlacedJob[], workflow?: string): void => {
    const byKey = new Map(jobs.map((j) => [j.key, j]));
    for (const job of jobs) {
      const from = job.node ?? workflow;
      if (!from) continue;

      for (const key of needsKeys(job.props.needs, names)) {
        const target = byKey.get(key);
        const to = target ? (target.node ?? workflow) : undefined;
        if (to) references.push({ from, to, kind: "needs", viaAttr: "needs" });
        else references.push({ from, to: key, kind: "needs", viaAttr: "needs", dangling: true });
      }

      const uses = job.props.uses;
      if (typeof uses === "string") {
        const local = /^\.\/(?:.*\/)?workflows\/([^/]+\.ya?ml)$/.exec(uses);
        const called = local ? byFile.get(stripYamlExt(local[1])) : undefined;
        if (called) references.push({ from, to: called, kind: "calls", viaAttr: "uses", crossPipeline: true });
        else references.push({ from, to: uses, kind: "calls", viaAttr: "uses", crossPipeline: true, dangling: true });
      }

      const steps = Array.isArray(job.props.steps) ? job.props.steps : [];
      for (const step of steps) {
        const stepUses = propsOf(step)?.uses;
        // A local composite action. Remote actions (`owner/repo@ref`,
        // `docker://`) are packages, not part of this project's graph.
        if (typeof stepUses === "string" && stepUses.startsWith("./")) {
          references.push({ from, to: stepUses, kind: "calls", viaAttr: "steps.uses", dangling: true });
        }
      }
    }
  };

  for (const wf of workflows) {
    visitJobs(wf.jobs, wf.name);
    pipelines[wf.name] = [wf.name, ...wf.jobs.map((j) => j.node).filter((n): n is string => n !== undefined)];
    for (const trigger of workflowRunNames(wf.props.on)) {
      const to = byDisplayName.get(trigger);
      if (to) references.push({ from: wf.name, to, kind: "triggers", viaAttr: "workflow_run", crossPipeline: true });
      else references.push({ from: wf.name, to: trigger, kind: "triggers", viaAttr: "workflow_run", crossPipeline: true, dangling: true });
    }
  }
  visitJobs(orphans);

  return { references, ...(Object.keys(pipelines).length > 0 ? { pipelines } : {}) };
}
