/**
 * GitHub Actions → GitLab CI transformer.
 *
 * Takes a GitHub TemplateIR (produced by `GitHubActionsParser.parse`)
 * and rewrites it into a GitLab TemplateIR (consumed by the existing
 * `GitLabGenerator` for TS emit, or by `emit-yaml.ts` for direct YAML).
 *
 * Per-key provenance is collected in a side-channel `ProvenanceAccumulator`
 * so the IR stays clean (re-usable by `chant import`).
 */

import type { TemplateIR, ResourceIR } from "@intentius/chant/import/parser";
import type { ProvenanceAccumulator } from "./provenance";
import { substituteExpressions, translateIfCondition } from "./expressions";
import { inferStages, type GhJobSummary } from "./stages";
import { lookupAction, type ActionMappingRegistry } from "./actions/registry";

export interface TransformOptions {
  /** Source file path for provenance (best-effort, no parse) */
  sourceFile?: string;
  /** Optional registry override for testability */
  registry?: ActionMappingRegistry;
  /** Provenance accumulator to write to */
  provenance: ProvenanceAccumulator;
}

/**
 * Map GitHub `runs-on` value to a GitLab `image` (best effort).
 * Self-hosted runners with extra labels map to `tags:`.
 */
function translateRunsOn(
  runsOn: unknown,
  ctx: { logicalId: string; jobName: string; sourceFile?: string },
  prov: ProvenanceAccumulator,
): { image?: string; tags?: string[] } {
  if (typeof runsOn === "string") {
    const map: Record<string, string> = {
      "ubuntu-latest": "ubuntu:24.04",
      "ubuntu-24.04": "ubuntu:24.04",
      "ubuntu-22.04": "ubuntu:22.04",
      "ubuntu-20.04": "ubuntu:20.04",
    };
    if (Object.prototype.hasOwnProperty.call(map, runsOn)) {
      prov.push({
        gitlabPath: `jobs.${ctx.logicalId}.image`,
        gitlabLogicalId: ctx.logicalId,
        sourceKey: `jobs.${ctx.jobName}.runs-on`,
        sourceFile: ctx.sourceFile,
        category: "literal",
        rule: "MIG-RUNS-ON-001",
        note: `runs-on: ${runsOn} → image: ${map[runsOn]}`,
      });
      return { image: map[runsOn] };
    }
    if (/^macos|^windows/.test(runsOn)) {
      prov.push({
        gitlabPath: `jobs.${ctx.logicalId}.image`,
        gitlabLogicalId: ctx.logicalId,
        sourceKey: `jobs.${ctx.jobName}.runs-on`,
        sourceFile: ctx.sourceFile,
        category: "needs-review",
        rule: "MIG-RUNS-ON-NON-LINUX",
        note: `runs-on: ${runsOn} has no direct GitLab image; configure a self-hosted runner with appropriate tag`,
      });
      return { tags: [runsOn] };
    }
    // Custom label → tags
    prov.push({
      gitlabPath: `jobs.${ctx.logicalId}.tags`,
      gitlabLogicalId: ctx.logicalId,
      sourceKey: `jobs.${ctx.jobName}.runs-on`,
      sourceFile: ctx.sourceFile,
      category: "literal",
      rule: "MIG-RUNS-ON-TAG",
      note: `runs-on: ${runsOn} → tags: [${runsOn}]`,
    });
    return { tags: [runsOn] };
  }
  if (Array.isArray(runsOn)) {
    prov.push({
      gitlabPath: `jobs.${ctx.logicalId}.tags`,
      gitlabLogicalId: ctx.logicalId,
      sourceKey: `jobs.${ctx.jobName}.runs-on`,
      sourceFile: ctx.sourceFile,
      category: "literal",
      rule: "MIG-RUNS-ON-TAG",
      note: `runs-on: [${runsOn.join(", ")}] → tags`,
    });
    return { tags: runsOn.map(String) };
  }
  return {};
}

/**
 * Translate a GitHub `on:` trigger spec to GitLab `workflow.rules`.
 */
function translateOnTrigger(
  on: unknown,
  ctx: { sourceFile?: string },
  prov: ProvenanceAccumulator,
): unknown[] {
  const rules: unknown[] = [];

  const sources = typeof on === "string"
    ? [on]
    : Array.isArray(on)
      ? on.map(String)
      : on && typeof on === "object"
        ? Object.keys(on as Record<string, unknown>)
        : [];

  for (const event of sources) {
    switch (event) {
      case "push":
        rules.push({ if: '$CI_PIPELINE_SOURCE == "push"' });
        prov.push({
          gitlabPath: "workflow.rules",
          sourceKey: "on.push",
          sourceFile: ctx.sourceFile,
          category: "literal",
          rule: "MIG-ON-PUSH",
          note: 'on: push → if: $CI_PIPELINE_SOURCE == "push"',
        });
        break;
      case "pull_request":
      case "pull_request_target":
        rules.push({ if: '$CI_PIPELINE_SOURCE == "merge_request_event"' });
        prov.push({
          gitlabPath: "workflow.rules",
          sourceKey: `on.${event}`,
          sourceFile: ctx.sourceFile,
          category: "literal",
          rule: "MIG-ON-PR",
          note: `on: ${event} → if: $CI_PIPELINE_SOURCE == "merge_request_event"`,
        });
        break;
      case "schedule":
        rules.push({ if: '$CI_PIPELINE_SOURCE == "schedule"' });
        prov.push({
          gitlabPath: "workflow.rules",
          sourceKey: "on.schedule",
          sourceFile: ctx.sourceFile,
          category: "needs-review",
          rule: "MIG-ON-SCHEDULE",
          note: "on: schedule → cron schedules must be configured in GitLab UI under CI/CD > Schedules",
        });
        break;
      case "workflow_dispatch":
        rules.push({ if: '$CI_PIPELINE_SOURCE == "web"' });
        rules.push({ if: '$CI_PIPELINE_SOURCE == "api"' });
        prov.push({
          gitlabPath: "workflow.rules",
          sourceKey: "on.workflow_dispatch",
          sourceFile: ctx.sourceFile,
          category: "needs-review",
          rule: "MIG-ON-DISPATCH",
          note: "on: workflow_dispatch → web/api triggers; inputs require spec:inputs (GitLab 17+) and per-input defaults",
        });
        break;
      case "release":
      case "issues":
      case "issue_comment":
      case "discussion":
      case "label":
        prov.push({
          gitlabPath: "workflow.rules",
          sourceKey: `on.${event}`,
          sourceFile: ctx.sourceFile,
          category: "needs-review",
          rule: "MIG-ON-NON-GIT",
          note: `on: ${event} has no GitLab equivalent — GitLab pipelines run only on git events. Consider gitlab-triage or webhooks.`,
        });
        break;
      default:
        prov.push({
          gitlabPath: "workflow.rules",
          sourceKey: `on.${event}`,
          sourceFile: ctx.sourceFile,
          category: "needs-review",
          rule: "MIG-ON-UNKNOWN",
          note: `on: ${event} not recognised; review manually`,
        });
    }
  }

  return rules;
}

/**
 * Translate a step's env into job-level variables (merged later).
 */
function collectStepEnv(
  steps: Array<Record<string, unknown>>,
  ctx: { logicalId: string; jobName: string; sourceFile?: string },
  prov: ProvenanceAccumulator,
): Record<string, unknown> {
  const variables: Record<string, unknown> = {};
  for (const [i, step] of steps.entries()) {
    if (step.env && typeof step.env === "object") {
      for (const [k, v] of Object.entries(step.env as Record<string, unknown>)) {
        if (k in variables && variables[k] !== v) {
          prov.push({
            gitlabPath: `jobs.${ctx.logicalId}.variables.${k}`,
            gitlabLogicalId: ctx.logicalId,
            sourceKey: `jobs.${ctx.jobName}.steps[${i}].env.${k}`,
            sourceFile: ctx.sourceFile,
            category: "needs-review",
            rule: "MIG-STEP-ENV-CONFLICT",
            note: `Step-level env var ${k} conflicts across steps; using last value`,
          });
        }
        variables[k] = v;
      }
    }
  }
  return variables;
}

/**
 * Translate a step's `run` block into script lines, applying expression
 * substitution. Returns the produced script lines + provenance.
 */
function translateRunStep(
  step: Record<string, unknown>,
  i: number,
  ctx: { logicalId: string; jobName: string; sourceFile?: string },
  prov: ProvenanceAccumulator,
): string[] {
  const run = String(step.run ?? "");
  // GitHub's `run:` supports multi-line shell. Split on newlines.
  const lines = run.split(/\r?\n/).filter((l) => l.length > 0);
  const out: string[] = [];
  for (const [j, line] of lines.entries()) {
    const subbed = substituteExpressions(line, {
      gitlabPath: `jobs.${ctx.logicalId}.script[${out.length}]`,
      sourceKey: `jobs.${ctx.jobName}.steps[${i}].run[${j}]`,
      sourceFile: ctx.sourceFile,
    });
    prov.pushAll(subbed.provenance);
    out.push(subbed.output);
  }
  return out;
}

/**
 * Translate a single GH job ResourceIR into a GitLab Job ResourceIR.
 */
function translateJob(
  ghJob: ResourceIR,
  opts: TransformOptions,
): { gitlabJob: ResourceIR; logicalId: string; needs: string[] } {
  const prov = opts.provenance;
  const logicalId = ghJob.logicalId;
  const jobName = (ghJob.metadata?.originalName as string) ?? logicalId;
  const props = ghJob.properties as Record<string, unknown>;
  const gitlabProps: Record<string, unknown> = {};

  // runs-on
  if (props["runs-on"] !== undefined) {
    const { image, tags } = translateRunsOn(props["runs-on"], { logicalId, jobName, sourceFile: opts.sourceFile }, prov);
    if (image) gitlabProps.image = image;
    if (tags) gitlabProps.tags = tags;
  }

  // env → variables
  if (props.env && typeof props.env === "object") {
    gitlabProps.variables = { ...(props.env as Record<string, unknown>) };
    prov.push({
      gitlabPath: `jobs.${logicalId}.variables`,
      gitlabLogicalId: logicalId,
      sourceKey: `jobs.${jobName}.env`,
      sourceFile: opts.sourceFile,
      category: "literal",
      rule: "MIG-JOB-ENV",
      note: "env: → variables:",
    });
  }

  // timeout-minutes → timeout
  if (props["timeout-minutes"] !== undefined) {
    gitlabProps.timeout = `${props["timeout-minutes"]} minutes`;
    prov.push({
      gitlabPath: `jobs.${logicalId}.timeout`,
      gitlabLogicalId: logicalId,
      sourceKey: `jobs.${jobName}.timeout-minutes`,
      sourceFile: opts.sourceFile,
      category: "literal",
      rule: "MIG-TIMEOUT",
      note: `timeout-minutes → timeout`,
    });
  }

  // continue-on-error → allow_failure
  if (props["continue-on-error"] !== undefined) {
    gitlabProps.allow_failure = props["continue-on-error"];
    prov.push({
      gitlabPath: `jobs.${logicalId}.allow_failure`,
      gitlabLogicalId: logicalId,
      sourceKey: `jobs.${jobName}.continue-on-error`,
      sourceFile: opts.sourceFile,
      category: "literal",
      rule: "MIG-ALLOW-FAILURE",
      note: "continue-on-error → allow_failure",
    });
  }

  // if → rules
  if (typeof props.if === "string") {
    const { ifExpression, whenClause, provenance } = translateIfCondition(props.if, {
      gitlabPath: `jobs.${logicalId}.rules[0]`,
      sourceKey: `jobs.${jobName}.if`,
      sourceFile: opts.sourceFile,
    });
    prov.pushAll(provenance);
    const rule: Record<string, unknown> = {};
    if (ifExpression) rule.if = ifExpression;
    if (whenClause) rule.when = whenClause;
    gitlabProps.rules = [rule];
  }

  // permissions — no per-job equivalent
  if (props.permissions !== undefined) {
    prov.push({
      gitlabPath: `jobs.${logicalId}.permissions`,
      gitlabLogicalId: logicalId,
      sourceKey: `jobs.${jobName}.permissions`,
      sourceFile: opts.sourceFile,
      category: "needs-review",
      rule: "MIG-PERMISSIONS-001",
      note: "GitHub permissions: has no per-job GitLab equivalent. Configure CI/CD token access at the project level.",
    });
  }

  // outputs — needs review (dotenv pattern)
  if (props.outputs !== undefined) {
    prov.push({
      gitlabPath: `jobs.${logicalId}.artifacts.reports.dotenv`,
      gitlabLogicalId: logicalId,
      sourceKey: `jobs.${jobName}.outputs`,
      sourceFile: opts.sourceFile,
      category: "needs-review",
      rule: "MIG-JOB-OUTPUTS",
      note: "GitHub job outputs require the artifacts:reports:dotenv pattern in GitLab.",
    });
  }

  // strategy.matrix → parallel.matrix
  if (props.strategy && typeof props.strategy === "object") {
    const strategy = props.strategy as Record<string, unknown>;
    if (strategy.matrix && typeof strategy.matrix === "object") {
      const matrix = strategy.matrix as Record<string, unknown>;
      const parallel: Record<string, unknown> = {};
      const matrixEntries: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(matrix)) {
        if (k === "include" || k === "exclude") {
          prov.push({
            gitlabPath: `jobs.${logicalId}.parallel.matrix`,
            gitlabLogicalId: logicalId,
            sourceKey: `jobs.${jobName}.strategy.matrix.${k}`,
            sourceFile: opts.sourceFile,
            category: "needs-review",
            rule: "MIG-MATRIX-INCLUDE-001",
            note: `matrix.${k} has no direct GitLab equivalent; review manually`,
          });
          continue;
        }
        matrixEntries[k.toUpperCase()] = v;
      }
      if (Object.keys(matrixEntries).length > 0) {
        parallel.matrix = [matrixEntries];
        gitlabProps.parallel = parallel;
        prov.push({
          gitlabPath: `jobs.${logicalId}.parallel.matrix`,
          gitlabLogicalId: logicalId,
          sourceKey: `jobs.${jobName}.strategy.matrix`,
          sourceFile: opts.sourceFile,
          category: "literal",
          rule: "MIG-MATRIX",
          note: "strategy.matrix → parallel.matrix",
        });
      }
    }
    if (strategy["fail-fast"] === true) {
      prov.push({
        gitlabPath: `jobs.${logicalId}.parallel.matrix`,
        gitlabLogicalId: logicalId,
        sourceKey: `jobs.${jobName}.strategy.fail-fast`,
        sourceFile: opts.sourceFile,
        category: "needs-review",
        rule: "MIG-FAIL-FAST",
        note: "strategy.fail-fast: true has no GitLab equivalent (GitLab's default is non-fail-fast)",
      });
    }
  }

  // needs → needs (passthrough, kebab-case names preserved)
  const needsArray: string[] = [];
  if (props.needs !== undefined) {
    const raw = props.needs;
    const list = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw.map(String) : [];
    needsArray.push(...list);
    if (list.length > 0) {
      gitlabProps.needs = list;
      prov.push({
        gitlabPath: `jobs.${logicalId}.needs`,
        gitlabLogicalId: logicalId,
        sourceKey: `jobs.${jobName}.needs`,
        sourceFile: opts.sourceFile,
        category: "literal",
        rule: "MIG-NEEDS",
        note: "needs: passthrough",
      });
    }
  }

  // concurrency.group → resource_group, cancel-in-progress → interruptible
  if (props.concurrency !== undefined) {
    const c = typeof props.concurrency === "object" && props.concurrency !== null
      ? props.concurrency as Record<string, unknown>
      : { group: String(props.concurrency) };
    if (c.group) {
      const subbed = substituteExpressions(String(c.group), {
        gitlabPath: `jobs.${logicalId}.resource_group`,
        sourceKey: `jobs.${jobName}.concurrency.group`,
        sourceFile: opts.sourceFile,
      });
      prov.pushAll(subbed.provenance);
      gitlabProps.resource_group = subbed.output;
    }
    if (c["cancel-in-progress"] === true) {
      gitlabProps.interruptible = true;
    }
    prov.push({
      gitlabPath: `jobs.${logicalId}.resource_group`,
      gitlabLogicalId: logicalId,
      sourceKey: `jobs.${jobName}.concurrency`,
      sourceFile: opts.sourceFile,
      category: "literal",
      rule: "MIG-CONCURRENCY",
      note: "concurrency.group → resource_group; cancel-in-progress → interruptible",
    });
  }

  // services — pass through (shape is similar)
  if (props.services !== undefined) {
    gitlabProps.services = props.services;
    prov.push({
      gitlabPath: `jobs.${logicalId}.services`,
      gitlabLogicalId: logicalId,
      sourceKey: `jobs.${jobName}.services`,
      sourceFile: opts.sourceFile,
      category: "literal",
      rule: "MIG-SERVICES",
      note: "services: passthrough",
    });
  }

  // container.image → image (overrides runs-on default)
  if (props.container && typeof props.container === "object") {
    const container = props.container as Record<string, unknown>;
    if (container.image) {
      gitlabProps.image = container.image;
      prov.push({
        gitlabPath: `jobs.${logicalId}.image`,
        gitlabLogicalId: logicalId,
        sourceKey: `jobs.${jobName}.container.image`,
        sourceFile: opts.sourceFile,
        category: "literal",
        rule: "MIG-CONTAINER",
        note: "container.image → image",
      });
    }
  }

  // steps → script
  const script: string[] = [];
  const beforeScript: string[] = [];
  const stepEnv = collectStepEnv(Array.isArray(props.steps) ? props.steps as Array<Record<string, unknown>> : [], { logicalId, jobName, sourceFile: opts.sourceFile }, prov);
  if (Object.keys(stepEnv).length > 0) {
    const existing = (gitlabProps.variables as Record<string, unknown> | undefined) ?? {};
    gitlabProps.variables = { ...existing, ...stepEnv };
  }

  if (Array.isArray(props.steps)) {
    const stepsArr = props.steps as Array<Record<string, unknown>>;
    for (const [i, step] of stepsArr.entries()) {
      // run: shell command
      if (typeof step.run === "string") {
        const lines = translateRunStep(step, i, { logicalId, jobName, sourceFile: opts.sourceFile }, prov);
        script.push(...lines);
        continue;
      }
      // uses: marketplace action
      if (typeof step.uses === "string") {
        const action = lookupAction(step.uses, opts.registry);
        if (action) {
          const result = action.translate(step, {
            logicalId,
            jobName,
            sourceFile: opts.sourceFile,
            stepIndex: i,
          });
          script.push(...result.scriptLines);
          if (result.beforeScript) beforeScript.push(...result.beforeScript);
          if (result.image) gitlabProps.image = result.image;
          if (result.services) gitlabProps.services = result.services;
          if (result.cache) gitlabProps.cache = result.cache;
          if (result.artifacts) gitlabProps.artifacts = result.artifacts;
          if (result.variables) {
            const existing = (gitlabProps.variables as Record<string, unknown> | undefined) ?? {};
            gitlabProps.variables = { ...existing, ...result.variables };
          }
          prov.pushAll(result.provenance);
        } else {
          script.push(`# TODO(migration): action "${step.uses}" not mapped — review manually`);
          prov.push({
            gitlabPath: `jobs.${logicalId}.script[${script.length - 1}]`,
            gitlabLogicalId: logicalId,
            sourceKey: `jobs.${jobName}.steps[${i}].uses`,
            sourceFile: opts.sourceFile,
            category: "needs-review",
            rule: "MIG-ACTION-UNKNOWN",
            note: `Marketplace action "${step.uses}" has no registered mapping; emitted TODO`,
            actionRef: step.uses,
          });
        }
      }
    }
  }
  if (script.length > 0) gitlabProps.script = script;
  if (beforeScript.length > 0) gitlabProps.before_script = beforeScript;

  return { gitlabJob: { logicalId, type: "GitLab::CI::Job", properties: gitlabProps, metadata: { originalName: jobName } }, logicalId, needs: needsArray };
}

export async function transformIR(
  ghIR: TemplateIR,
  opts: TransformOptions,
): Promise<{ ir: TemplateIR; stages: string[] }> {
  const prov = opts.provenance;
  const resources: ResourceIR[] = [];

  // Extract workflow-level properties
  const workflowResource = ghIR.resources.find((r) => r.type === "GitHub::Actions::Workflow");
  if (workflowResource) {
    const wf = workflowResource.properties;
    const gitlabWorkflowProps: Record<string, unknown> = {};
    if (wf.name) {
      gitlabWorkflowProps.name = wf.name;
      prov.push({
        gitlabPath: "workflow.name",
        sourceKey: "name",
        sourceFile: opts.sourceFile,
        category: "literal",
        rule: "MIG-WORKFLOW-NAME",
        note: "name → workflow.name",
      });
    }
    if (wf.on !== undefined) {
      const rules = translateOnTrigger(wf.on, { sourceFile: opts.sourceFile }, prov);
      if (rules.length > 0) gitlabWorkflowProps.rules = rules;
    }
    if (Object.keys(gitlabWorkflowProps).length > 0) {
      resources.push({
        logicalId: "workflow",
        type: "GitLab::CI::Workflow",
        properties: gitlabWorkflowProps,
      });
    }
    // Workflow-level env → top-level variables (handled via metadata)
    if (wf.env && typeof wf.env === "object") {
      prov.push({
        gitlabPath: "variables",
        sourceKey: "env",
        sourceFile: opts.sourceFile,
        category: "literal",
        rule: "MIG-WORKFLOW-ENV",
        note: "workflow env → top-level variables",
      });
    }
    // Workflow-level permissions
    if (wf.permissions !== undefined) {
      prov.push({
        gitlabPath: "(none)",
        sourceKey: "permissions",
        sourceFile: opts.sourceFile,
        category: "needs-review",
        rule: "MIG-PERMISSIONS-001",
        note: "GitHub workflow-level permissions: configure CI/CD token access at the project level (no YAML equivalent).",
      });
    }
  }

  // Translate jobs
  const ghJobs = ghIR.resources.filter(
    (r) => r.type === "GitHub::Actions::Job" || r.type === "GitHub::Actions::ReusableWorkflowCallJob",
  );
  const translatedJobs: Array<ReturnType<typeof translateJob>> = [];
  const jobSummaries: GhJobSummary[] = [];
  for (const ghJob of ghJobs) {
    if (ghJob.type === "GitHub::Actions::ReusableWorkflowCallJob") {
      prov.push({
        gitlabPath: `jobs.${ghJob.logicalId}`,
        gitlabLogicalId: ghJob.logicalId,
        sourceKey: `jobs.${(ghJob.metadata?.originalName as string) ?? ghJob.logicalId}.uses`,
        sourceFile: opts.sourceFile,
        category: "needs-review",
        rule: "MIG-REUSABLE-WORKFLOW",
        note: "GitHub reusable workflow `uses:` requires GitLab `include:` + variable substitution (no typed inputs/outputs)",
      });
      continue;
    }
    const translated = translateJob(ghJob, opts);
    translatedJobs.push(translated);
    jobSummaries.push({
      logicalId: translated.logicalId,
      originalName: (ghJob.metadata?.originalName as string) ?? translated.logicalId,
      needs: translated.needs,
    });
  }

  // Infer stages
  const stageResult = inferStages(jobSummaries);
  prov.pushAll(stageResult.provenance);

  // Apply stage assignments
  for (const tj of translatedJobs) {
    const stage = stageResult.stageByJob.get(tj.logicalId);
    if (stage) {
      (tj.gitlabJob.properties as Record<string, unknown>).stage = stage;
    }
    resources.push(tj.gitlabJob);
  }

  // Workflow-level env collected into a top-level metadata.variables slot
  const topLevelVars: Record<string, unknown> = {};
  if (workflowResource && workflowResource.properties.env && typeof workflowResource.properties.env === "object") {
    Object.assign(topLevelVars, workflowResource.properties.env);
  }

  const metadata: Record<string, unknown> = {
    migration: {
      sourceFile: opts.sourceFile ?? "(unknown)",
      sourceTool: "github-actions",
    },
    stages: stageResult.stages,
  };
  if (Object.keys(topLevelVars).length > 0) {
    metadata.variables = topLevelVars;
  }

  return {
    ir: { resources, parameters: [], metadata },
    stages: stageResult.stages,
  };
}
