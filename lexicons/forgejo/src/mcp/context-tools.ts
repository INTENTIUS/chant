/**
 * Read-only MCP tools for the forgejo lexicon.
 *
 * The forgejo counterpart to the github/gitlab context tools (#327): expose
 * what `chant build` already computes about a Forgejo workflow — its triggers
 * and jobs, what it pulls in from outside, its findings, where each job came
 * from in source — plus `forgejo:compare`, the migration safety view. Because
 * Forgejo emits GitHub-style YAML, the parsing reuses the github lexicon's
 * yaml-helpers.
 *
 * Every tool builds from source and returns data. None touch a live forge,
 * read run history, or write anything.
 */

import { build, type BuildResult } from "@intentius/chant/build";
import { runPostSynthChecks, getPrimaryOutput } from "@intentius/chant/lint/post-synth";
import { postSynthChecks } from "../lint/post-synth";
import { getProvenance } from "@intentius/chant/provenance";
import type { McpToolContribution } from "@intentius/chant/mcp/types";
import { relative, isAbsolute, resolve } from "path";
import { readFile } from "fs/promises";
import {
  extractJobs,
  extractActionRefs,
  extractImageRefs,
  extractTriggers,
  extractWorkflowName,
} from "@intentius/chant-lexicon-github/lint/post-synth/yaml-helpers";
import { forgejoSerializer } from "../serializer";
import { transform, detectGitHubWorkflow } from "../migrate/from-github";

/**
 * Build the project with the forgejo serializer and return the emitted YAML.
 * The serializer is registered under the "github" lexicon (it serializes the
 * reused github entities), so the output is keyed "github".
 */
async function buildForgejo(path: string): Promise<{ yaml: string; result: BuildResult }> {
  const result = await build(path, [forgejoSerializer]);
  const out = result.outputs.get("github");
  return { yaml: out ? getPrimaryOutput(out) : "", result };
}

/** Discover the forgejo post-synth checks without depending on the plugin. */
function forgejoPostSynthChecks() {
  return postSynthChecks;
}

/** Is a `uses:` ref pinned to a full commit SHA (the only immutable form)? */
export function actionPinned(ref: string): boolean {
  const at = ref.lastIndexOf("@");
  return at !== -1 && /^[0-9a-f]{40}$/.test(ref.slice(at + 1));
}

/** The YAML job name a build entity serializes to (camelCase → kebab-case). */
export function jobNameOf(entityName: string): string {
  return entityName.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/** Find the build entity whose serialized job name matches `job`. */
function entityForJob(result: BuildResult, job: string): { name: string; entity: object } | undefined {
  for (const [name, entity] of result.entities) {
    if (name === job || jobNameOf(name) === job) return { name, entity };
  }
  return undefined;
}

/** Render a source-file path relative to the project root, when possible. */
function relSource(root: string, file: string | undefined): string | undefined {
  if (!file) return undefined;
  if (!isAbsolute(file)) return file;
  const rel = relative(root, file);
  return rel.startsWith("..") ? file : rel;
}

/** Jobs that would re-run because they depend (transitively) on `job`. */
export function downstreamJobs(yaml: string, job: string): string[] {
  const jobs = extractJobs(yaml);
  const downstreamOf = new Map<string, string[]>();
  for (const [name, j] of jobs) {
    for (const dep of j.needs ?? []) {
      const arr = downstreamOf.get(dep) ?? [];
      arr.push(name);
      downstreamOf.set(dep, arr);
    }
  }
  const out = new Set<string>();
  const queue = [job];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const next of downstreamOf.get(cur) ?? []) {
      if (!out.has(next)) {
        out.add(next);
        queue.push(next);
      }
    }
  }
  return [...out];
}

const PATH_INPUT = {
  type: "object" as const,
  properties: {
    path: { type: "string", description: "Path to the chant project directory (default: current directory)" },
  },
};

const JOB_INPUT = {
  type: "object" as const,
  properties: {
    path: { type: "string", description: "Path to the chant project directory (default: current directory)" },
    job: { type: "string", description: "Job name (as it appears in the generated YAML)" },
  },
  required: ["job"],
};

/** The read-only context tools for the forgejo lexicon. */
export function forgejoContextTools(): McpToolContribution[] {
  return [
    {
      name: "forgejo:checks",
      description:
        "Build the workflow and return its Forgejo-specific findings (the WFJ checks: unresolved action refs, GitHub-hosted runner labels) as JSON. Read-only.",
      inputSchema: PATH_INPUT,
      async handler(params: Record<string, unknown>): Promise<unknown> {
        const { yaml, result } = await buildForgejo((params.path as string) ?? ".");
        if (!yaml) return { findings: [], note: "no Forgejo workflow produced from this project" };
        const scoped = { ...result, outputs: new Map([["github", result.outputs.get("github")!]]) };
        const diags = runPostSynthChecks(forgejoPostSynthChecks(), scoped);
        return {
          findings: diags.map((d) => ({ id: d.checkId, severity: d.severity, job: d.entity ?? null, message: d.message })),
        };
      },
    },
    {
      name: "forgejo:workflow",
      description:
        "Build the workflow and return its triggers and jobs as written (name, what each job runs after, step count) — before anything runs. Read-only.",
      inputSchema: PATH_INPUT,
      async handler(params: Record<string, unknown>): Promise<unknown> {
        const { yaml } = await buildForgejo((params.path as string) ?? ".");
        const jobs = [...extractJobs(yaml).values()].map((j) => ({
          name: j.name,
          runsAfter: j.needs ?? [],
          steps: j.steps?.length ?? 0,
        }));
        return { workflow: extractWorkflowName(yaml) ?? null, triggers: Object.keys(extractTriggers(yaml)), jobs };
      },
    },
    {
      name: "forgejo:references",
      description:
        "Build the workflow and list everything it pulls in from outside (actions via uses:, container/service images) and whether each is pinned to an immutable commit SHA. Read-only.",
      inputSchema: PATH_INPUT,
      async handler(params: Record<string, unknown>): Promise<unknown> {
        const { yaml } = await buildForgejo((params.path as string) ?? ".");
        const actions = extractActionRefs(yaml).map((a) => ({
          kind: a.level === "job" ? ("reusable-workflow" as const) : ("action" as const),
          job: a.job,
          source: a.ref,
          pinned: actionPinned(a.ref),
        }));
        const images = extractImageRefs(yaml).map((i) => ({
          kind: "image" as const,
          job: i.job,
          source: i.image,
          pinned: i.image.includes("@sha256:"),
        }));
        return [...actions, ...images];
      },
    },
    {
      name: "forgejo:affected",
      description:
        "Build the workflow and, given a job name, list the jobs that would re-run because they depend on it (the needs chain). Read-only.",
      inputSchema: JOB_INPUT,
      async handler(params: Record<string, unknown>): Promise<unknown> {
        const { yaml } = await buildForgejo((params.path as string) ?? ".");
        const job = params.job as string;
        return { job, wouldRerun: downstreamJobs(yaml, job) };
      },
    },
    {
      name: "forgejo:workflow-yaml",
      description: "Build the project and return the generated Forgejo Actions workflow YAML as a string. Read-only.",
      inputSchema: PATH_INPUT,
      async handler(params: Record<string, unknown>): Promise<unknown> {
        const { yaml } = await buildForgejo((params.path as string) ?? ".");
        return { yaml };
      },
    },
    {
      name: "forgejo:source",
      description:
        "Build the project and, given a job name, say where it came from in the TypeScript source — the file that declared it and the composite that expanded it, if any. Entity-level provenance, not a YAML-line source map. Read-only.",
      inputSchema: JOB_INPUT,
      async handler(params: Record<string, unknown>): Promise<unknown> {
        const root = (params.path as string) ?? ".";
        const { result } = await buildForgejo(root);
        const job = params.job as string;
        const found = entityForJob(result, job);
        if (!found) return { job, found: false, note: "no build entity serializes to that job name" };
        const prov = getProvenance(found.entity);
        return { job, found: true, entity: found.name, from: relSource(root, prov?.sourceFile) ?? null, via: prov?.composite ?? null };
      },
    },
    {
      name: "forgejo:owns",
      description:
        "Build the project and report whether a job is declared (owned) by chant in this project's source. For workflow config, ownership means \"declared here\" — Forgejo Actions jobs are not taggable cloud resources, so there is no live ownership marker as there is for cloud lexicons. Read-only.",
      inputSchema: JOB_INPUT,
      async handler(params: Record<string, unknown>): Promise<unknown> {
        const root = (params.path as string) ?? ".";
        const { result } = await buildForgejo(root);
        const job = params.job as string;
        const found = entityForJob(result, job);
        return {
          job,
          owned: Boolean(found),
          basis: "declared-in-source",
          note: "Forgejo Actions jobs are not taggable cloud resources; ownership here means the job is declared by chant in this project. Live ownership markers apply to cloud lexicons (aws/azure/k8s).",
        };
      },
    },
    {
      name: "forgejo:compare",
      description:
        "Given a GitHub Actions workflow file, migrate it to Forgejo and report which properties survive the move and which weaken or are lost (the migration safety view). Returns a per-property fate (translated/approximated/needs-review/lost) plus summary counts. Read-only — analyzes, never writes.",
      inputSchema: {
        type: "object" as const,
        properties: {
          file: { type: "string", description: "Path to a .github/workflows/*.yml workflow file to migrate and compare" },
        },
        required: ["file"],
      },
      async handler(params: Record<string, unknown>): Promise<unknown> {
        const file = resolve((params.file as string) ?? "");
        let content: string;
        try {
          content = await readFile(file, "utf8");
        } catch {
          return { file: params.file ?? null, found: false, note: "could not read the workflow file" };
        }
        if (!detectGitHubWorkflow(content)) {
          return { file: params.file ?? null, found: false, note: "file does not look like a GitHub Actions workflow" };
        }
        const migration = await transform(content, { security: true, sourceFile: file });
        const properties = migration.provenance.map((r) => ({
          property: r.security.property,
          fate: r.security.fate,
          severity: r.security.severity,
          sourceKey: r.sourceKey,
          reestablish: r.security.reestablish ?? null,
          note: r.note ?? null,
        }));
        const summary: Record<string, number> = { translated: 0, approximated: 0, "needs-review": 0, lost: 0 };
        for (const p of properties) summary[p.fate] = (summary[p.fate] ?? 0) + 1;
        return { found: true, properties, summary };
      },
    },
  ];
}
