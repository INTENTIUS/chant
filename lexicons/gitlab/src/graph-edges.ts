/**
 * GitLab CI dependencies as graph edges (#3910).
 *
 * A GitLab job names everything it depends on as a string: the jobs it
 * `needs`, the job it `extends`, the pipeline it `trigger`s, and the pipeline
 * names the files it `include`s. `chant graph` cannot read those, so this
 * module resolves them against the declared entities and reports each one
 * through the plugin's `graphEdges` hook:
 *
 *  - `needs`    job -> job, from `needs:` (a name, `{ job }`, or the Job
 *               itself); a job without `needs:` waits for the stages before
 *               its own, reported as `needs` via `stage`
 *  - `extends`  job -> the job it inherits from
 *  - `triggers` job -> the child or multi-project pipeline it starts
 *  - `includes` pipeline -> each file its `include:` pulls in
 *
 * Jobs are named in the YAML by their kebab-cased export name, as
 * ./serializer.ts writes them. Cross-pipeline references (`trigger:`,
 * `include:`, `needs: { project }` and `needs: { pipeline }`) name a pipeline
 * this project does not generate, so they are reported as dangling and
 * marked `crossPipeline`. So is any job name nothing declares: a hidden
 * template from an included file, a typo.
 */

import type { Declarable } from "@intentius/chant/declarable";
import { isPropertyDeclarable } from "@intentius/chant/declarable";
import type { LexiconGraphEdges, LexiconGraphReference } from "@intentius/chant/graph-ir";

const JOB = "GitLab::CI::Job";
const PIPELINE = "GitLab::CI::Pipeline";
const PIPELINE_LEVEL = new Set([PIPELINE, "GitLab::CI::Default", "GitLab::CI::Workflow"]);

/** The YAML name ./serializer.ts gives a job. */
function yamlName(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

function entityType(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const t = (value as { entityType?: unknown }).entityType;
  return typeof t === "string" ? t : undefined;
}

/** A Declarable's props bag, or the plain object itself. */
function propsOf(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (entityType(value) !== undefined) {
    const props = (value as { props?: unknown }).props;
    return props && typeof props === "object" ? (props as Record<string, unknown>) : undefined;
  }
  return value as Record<string, unknown>;
}

const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]);

/** GitLab's default stages, used when nothing declares a `stages:` list. */
const DEFAULT_STAGES = ["build", "test", "deploy"];

/**
 * The stage order GitLab runs, as ./serializer.ts emits it: a Pipeline's
 * `stages:` first, then every stage a job names that the list leaves out, in
 * first use. With neither, GitLab's defaults. `.pre` and `.post` always
 * bracket the list.
 */
function stageOrder(pipelines: Record<string, unknown>[], jobs: Array<{ props: Record<string, unknown> }>): string[] {
  const stages = new Set<string>();
  for (const p of pipelines) for (const s of asList(p.stages)) if (typeof s === "string") stages.add(s);
  for (const j of jobs) if (typeof j.props.stage === "string") stages.add(j.props.stage);
  const list = stages.size > 0 ? [...stages] : DEFAULT_STAGES;
  return [".pre", ...list.filter((s) => s !== ".pre" && s !== ".post"), ".post"];
}

/** A file an `include:` or `trigger: { include }` entry names, as written. */
function includeTarget(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  const p = propsOf(entry);
  if (!p) return undefined;
  for (const key of ["local", "remote", "template", "component", "artifact"]) {
    if (typeof p[key] === "string") return p[key] as string;
  }
  if (typeof p.project === "string") {
    const files = asList(p.file).filter((f): f is string => typeof f === "string");
    const ref = typeof p.ref === "string" ? `@${p.ref}` : "";
    return `${p.project}${ref}:${files.join(",")}`;
  }
  return undefined;
}

/** The graph edges and pipeline membership a GitLab CI project declares. */
export function gitlabGraphEdges(entities: ReadonlyMap<string, Declarable>): LexiconGraphEdges | undefined {
  const names = new Map<unknown, string>();
  const jobs: Array<{ node: string; key: string; props: Record<string, unknown> }> = [];
  const pipelineNodes: string[] = [];
  const pipelineEntities: Array<{ node: string; props: Record<string, unknown> }> = [];
  for (const [name, entity] of entities) {
    names.set(entity, name);
    if (isPropertyDeclarable(entity)) continue;
    const type = entityType(entity);
    if (type === JOB) jobs.push({ node: name, key: yamlName(name), props: propsOf(entity) ?? {} });
    else if (type && PIPELINE_LEVEL.has(type)) {
      pipelineNodes.push(name);
      if (type === PIPELINE) pipelineEntities.push({ node: name, props: propsOf(entity) ?? {} });
    }
  }
  if (jobs.length === 0 && pipelineEntities.length === 0) return undefined;

  const byKey = new Map(jobs.map((j) => [j.key, j.node]));
  const references: LexiconGraphReference[] = [];

  // A job name as written, or a Job object held directly.
  const jobKey = (value: unknown): string | undefined => {
    if (typeof value === "string") return value;
    const name = names.get(value);
    return name !== undefined && entityType(value) === JOB ? yamlName(name) : undefined;
  };

  // Stage order, for the jobs that say nothing about `needs:`.
  const stages = stageOrder(pipelineEntities.map((p) => p.props), jobs);
  const stageOf = (j: { props: Record<string, unknown> }): number =>
    stages.indexOf(typeof j.props.stage === "string" ? j.props.stage : "test");
  const atStage = new Map<number, typeof jobs>();
  for (const j of jobs) {
    const s = stageOf(j);
    if (s < 0) continue;
    const arr = atStage.get(s) ?? [];
    arr.push(j);
    atStage.set(s, arr);
  }

  for (const job of jobs) {
    const from = job.node;

    if (job.props.needs === undefined) {
      // Stage order: wait for every job in the nearest earlier stage that has
      // any. Those jobs wait for the stage before them in turn, unless one of
      // them uses `needs:` and starts early, in which case this job also
      // waits for the stage before, and so on back.
      for (let s = stageOf(job) - 1; s >= 0; s--) {
        const earlier = atStage.get(s);
        if (!earlier) continue;
        for (const e of earlier) references.push({ from, to: e.node, kind: "needs", viaAttr: "stage" });
        if (earlier.every((e) => e.props.needs === undefined)) break;
      }
    }

    for (const need of asList(job.props.needs)) {
      const key = jobKey(need);
      if (key !== undefined) {
        const to = byKey.get(key);
        references.push(to ? { from, to, kind: "needs", viaAttr: "needs" } : { from, to: key, kind: "needs", viaAttr: "needs", dangling: true });
        continue;
      }
      const p = propsOf(need);
      if (!p || typeof p.job !== "string") continue;
      if (typeof p.project === "string") {
        const ref = typeof p.ref === "string" ? `@${p.ref}` : "";
        references.push({ from, to: `${p.project}${ref}:${p.job}`, kind: "needs", viaAttr: "needs.project", crossPipeline: true, dangling: true });
      } else if (typeof p.pipeline === "string") {
        references.push({ from, to: `${p.pipeline}:${p.job}`, kind: "needs", viaAttr: "needs.pipeline", crossPipeline: true, dangling: true });
      } else {
        const to = byKey.get(p.job);
        references.push(to ? { from, to, kind: "needs", viaAttr: "needs" } : { from, to: p.job, kind: "needs", viaAttr: "needs", dangling: true });
      }
    }

    for (const parent of asList(job.props.extends)) {
      const key = jobKey(parent);
      if (key === undefined) continue;
      const to = byKey.get(key);
      references.push(to ? { from, to, kind: "extends", viaAttr: "extends" } : { from, to: key, kind: "extends", viaAttr: "extends", dangling: true });
    }

    const trigger = job.props.trigger;
    if (typeof trigger === "string") {
      references.push({ from, to: trigger, kind: "triggers", viaAttr: "trigger", crossPipeline: true, dangling: true });
    } else {
      const t = propsOf(trigger);
      if (t && typeof t.project === "string") {
        const branch = typeof t.branch === "string" ? `@${t.branch}` : "";
        references.push({ from, to: `${t.project}${branch}`, kind: "triggers", viaAttr: "trigger.project", crossPipeline: true, dangling: true });
      }
      for (const entry of asList(t?.include)) {
        const file = includeTarget(entry);
        if (file) references.push({ from, to: file, kind: "triggers", viaAttr: "trigger.include", crossPipeline: true, dangling: true });
      }
    }
  }

  for (const p of pipelineEntities) {
    for (const entry of asList(p.props.include)) {
      const file = includeTarget(entry);
      if (file) references.push({ from: p.node, to: file, kind: "includes", viaAttr: "include", crossPipeline: true, dangling: true });
    }
  }

  // One project, one `.gitlab-ci.yml`: every job and pipeline-level entity is in it.
  const members = [...pipelineNodes, ...jobs.map((j) => j.node)].sort();
  return { references, pipelines: { ".gitlab-ci.yml": members } };
}
