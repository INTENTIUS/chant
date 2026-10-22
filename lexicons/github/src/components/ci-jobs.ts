/**
 * The GitHub Actions job pieces the three generators share (#3765): the Op
 * pipeline (`./generate-op-pipeline.ts`), the Op waves pipeline
 * (`./generate-op-waves-pipeline.ts`) and the component pipeline
 * (`./generate-pipeline.ts`). The forgejo lexicon builds on the same
 * documents and applies its dialect. The forge-neutral rules (image default,
 * branch defaults, tokens, permissions, setup and environment checks) are
 * core's, in `@intentius/chant/ci-jobs`.
 */

import { emitYAML, emitYAMLEntry } from "@intentius/chant/yaml";
import { BUILD_REQUEST_TAGS, GITHUB_JOB_TOKEN, pushBranches } from "@intentius/chant/ci-jobs";
import type { OpTrigger } from "@intentius/chant/lexicon";
import { actionRef } from "../action-pins";

/** The artifact actions every generated job uses, at the major the generators have always pinned. */
export const UPLOAD_ARTIFACT = "actions/upload-artifact@v4";
export const DOWNLOAD_ARTIFACT = "actions/download-artifact@v4";

/** The checkout step; `fullHistory` fetches every commit, for a job that reads the base commit or measures a change with git. */
export function checkoutStep(fullHistory = false): Record<string, unknown> {
  return fullHistory ? { uses: actionRef("actions/checkout"), with: { "fetch-depth": 0 } } : { uses: actionRef("actions/checkout") };
}

/** One `run:` step per line, so each line is its own step in the log. */
export function runSteps(lines: readonly string[]): Array<Record<string, unknown>> {
  return lines.map((line) => ({ run: line }));
}

/** A step that downloads `artifact` into `path`. */
export function downloadArtifactStep(name: string, artifact: string, path: string): Record<string, unknown> {
  return { name, uses: DOWNLOAD_ARTIFACT, with: { name: artifact, path } };
}

/**
 * A step that keeps a record as an artifact whatever the job's outcome, so a
 * job that stops at a gate (exit 3) still hands its record on, and a re-run
 * replaces it. Nothing to keep is not an error.
 */
export function keepRecordStep(name: string, artifact: string, path: string): Record<string, unknown> {
  return {
    name,
    if: "always()",
    uses: UPLOAD_ARTIFACT,
    with: { name: artifact, path, "if-no-files-found": "ignore", "include-hidden-files": true, overwrite: true },
  };
}

/**
 * The `if:` of a wave job after the first (#4291): it runs when the wave
 * before it failed, so a failed member blocks only the members that depend
 * on it, and the next wave's job blocks those and runs the rest. It does not
 * run when the run was cancelled, or when the job before it was skipped
 * (its own condition was false). `condition` is the job's own condition,
 * which still has to hold.
 */
export function afterEarlierWave(previous: string, condition?: string): string {
  const runs = `!cancelled() && needs.${previous}.result != 'skipped'`;
  return condition ? `${runs} && (${condition})` : runs;
}

/** A `concurrency:` mapping: one run at a time per group. */
export function concurrency(group: string, cancelInProgress = false): Record<string, unknown> {
  return { group, "cancel-in-progress": cancelInProgress };
}

/** The job token, as a step's `GITHUB_TOKEN`; `gh` reads `GH_TOKEN` too, for a step that writes. */
export function jobTokenEnv(gh = false): Record<string, string> {
  return gh ? { GITHUB_TOKEN: GITHUB_JOB_TOKEN, GH_TOKEN: GITHUB_JOB_TOKEN } : { GITHUB_TOKEN: GITHUB_JOB_TOKEN };
}

/**
 * A trigger's `on:` mapping (#2084): `cron` runs on its schedule and by hand,
 * `pull_request` on pull requests into its branches (every branch when it
 * names none; no `workflow_dispatch`, since a PR event needs no manual
 * escape hatch), `push` on pushes to its branches (core's default when it
 * names none).
 */
export function onTrigger(trigger: OpTrigger): Record<string, unknown> {
  switch (trigger.kind) {
    case "cron":
      return { schedule: [{ cron: trigger.schedule }], workflow_dispatch: {} };
    case "pull_request":
      return { pull_request: trigger.branches && trigger.branches.length > 0 ? { branches: trigger.branches } : {} };
    case "push":
      // #4169: a newest build runs at each build request's tag too, and by hand.
      return trigger.build === "newest"
        ? { push: { branches: pushBranches(trigger.branches), tags: [BUILD_REQUEST_TAGS] }, workflow_dispatch: {} }
        : { push: { branches: pushBranches(trigger.branches) } };
  }
}

/**
 * A push Op's concurrency group (#4169): one per commit under `build:
 * "every"`, so no push cancels or replaces another's run; one per ref under
 * `newest`, so the newest push waits and each build request's tag runs on its
 * own; and the Op's own name otherwise, one run at a time.
 */
export function opConcurrencyGroup(jobName: string, trigger: OpTrigger): string {
  if (trigger.kind !== "push" || !trigger.build) return jobName;
  return trigger.build === "every" ? `${jobName}-\${{ github.sha }}` : `${jobName}-\${{ github.ref }}`;
}

/**
 * A workflow document before emission. Every generator's document is one of
 * these; each leaves out the sections it has no use for.
 */
export interface GithubWorkflowDoc {
  /** Comment lines above the document, `#` included: what a dialect could not carry across (#2257). */
  header?: string[];
  /** The workflow's `name:`. */
  name?: string;
  /** The `on:` trigger mapping. */
  on: Record<string, unknown>;
  /** The workflow-level `env:` mapping, emitted when it has an entry. */
  env?: Record<string, unknown>;
  /** The workflow's `defaults:`. */
  defaults?: Record<string, unknown>;
  /** The `concurrency:` mapping. */
  concurrency?: Record<string, unknown>;
  /** The workflow-level `permissions:` mapping, emitted when it has an entry. */
  permissions?: Record<string, unknown>;
  /** The `jobs:` mapping. */
  jobsDoc: Record<string, unknown>;
}

/** Emit a workflow document as YAML, its sections in GitHub's customary order. */
export function emitWorkflowYAML(doc: GithubWorkflowDoc): string {
  const sections: string[] = [];
  if (doc.header && doc.header.length > 0) sections.push(doc.header.join("\n"));
  if (doc.name) sections.push("name: " + emitYAML(doc.name, 0));
  sections.push(emitYAMLEntry("on", doc.on));
  if (doc.env && Object.keys(doc.env).length > 0) sections.push(emitYAMLEntry("env", doc.env));
  if (doc.defaults) sections.push(emitYAMLEntry("defaults", doc.defaults));
  if (doc.concurrency) sections.push(emitYAMLEntry("concurrency", doc.concurrency));
  if (doc.permissions && Object.keys(doc.permissions).length > 0) sections.push(emitYAMLEntry("permissions", doc.permissions));
  sections.push(emitYAMLEntry("jobs", doc.jobsDoc));
  return sections.join("\n\n") + "\n";
}
