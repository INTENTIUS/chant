/**
 * Read-only MCP tools that expose what `chant build` already computes about a
 * GitHub Actions workflow — its jobs and run order, what it pulls in from
 * outside (actions, images), and its security findings — so an agent can ask
 * about a change *before it runs or merges* (#327).
 *
 * The GitHub counterpart to the GitLab context tools. Every tool builds from
 * source and returns data. None of them touch the live GitHub instance, read
 * run history, or write anything — that boundary is what keeps chant a context
 * producer and not a copy of the live tooling.
 */

import { build, type BuildResult } from "@intentius/chant/build";
import { runPostSynthChecks, getPrimaryOutput } from "@intentius/chant/lint/post-synth";
import { discoverPostSynthChecks } from "@intentius/chant/lint/discover";
import type { McpToolContribution } from "@intentius/chant/mcp/types";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { githubSerializer } from "../serializer";
import {
  extractJobs,
  extractActionRefs,
  extractImageRefs,
  extractTriggers,
  extractWorkflowName,
} from "../lint/post-synth/yaml-helpers";

/** Build the project and return the emitted GitHub workflow YAML plus the raw result. */
async function buildGithub(path: string): Promise<{ yaml: string; result: BuildResult }> {
  const result = await build(path, [githubSerializer]);
  const out = result.outputs.get("github");
  return { yaml: out ? getPrimaryOutput(out) : "", result };
}

/** Discover the lexicon's post-synth checks without depending on the plugin. */
function githubPostSynthChecks() {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "lint", "post-synth");
  return discoverPostSynthChecks(dir, import.meta.url);
}

/** Is a `uses:` ref pinned to a full commit SHA (the only immutable form)? */
export function actionPinned(ref: string): boolean {
  const at = ref.lastIndexOf("@");
  return at !== -1 && /^[0-9a-f]{40}$/.test(ref.slice(at + 1));
}

/** Jobs that would re-run because they depend (transitively) on `job`. */
export function downstreamJobs(yaml: string, job: string): string[] {
  const jobs = extractJobs(yaml);
  // edge: upstream -> downstream (J depends on each of its needs)
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

/** The read-only context tools for the GitHub lexicon. */
export function githubContextTools(): McpToolContribution[] {
  return [
    {
      name: "github:checks",
      description:
        "Build the workflow and return its security and correctness findings (the GHA checks) as JSON. Read-only — does not touch the live GitHub instance.",
      inputSchema: PATH_INPUT,
      async handler(params: Record<string, unknown>): Promise<unknown> {
        const { yaml, result } = await buildGithub((params.path as string) ?? ".");
        if (!yaml) return { findings: [], note: "no GitHub workflow produced from this project" };
        const scoped = { ...result, outputs: new Map([["github", result.outputs.get("github")!]]) };
        const diags = runPostSynthChecks(githubPostSynthChecks(), scoped);
        return {
          findings: diags.map((d) => ({
            id: d.checkId,
            severity: d.severity,
            job: d.entity ?? null,
            message: d.message,
          })),
        };
      },
    },
    {
      name: "github:workflow",
      description:
        "Build the workflow and return its triggers and jobs as written (name, what each job runs after, step count) — before anything runs. Read-only.",
      inputSchema: PATH_INPUT,
      async handler(params: Record<string, unknown>): Promise<unknown> {
        const { yaml } = await buildGithub((params.path as string) ?? ".");
        const jobs = [...extractJobs(yaml).values()].map((j) => ({
          name: j.name,
          runsAfter: j.needs ?? [],
          steps: j.steps?.length ?? 0,
        }));
        return {
          workflow: extractWorkflowName(yaml) ?? null,
          triggers: Object.keys(extractTriggers(yaml)),
          jobs,
        };
      },
    },
    {
      name: "github:references",
      description:
        "Build the workflow and list everything it pulls in from outside (actions via uses:, container/service images) and whether each is pinned to an immutable commit SHA. Read-only.",
      inputSchema: PATH_INPUT,
      async handler(params: Record<string, unknown>): Promise<unknown> {
        const { yaml } = await buildGithub((params.path as string) ?? ".");
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
      name: "github:affected",
      description:
        "Build the workflow and, given a job name, list the jobs that would re-run because they depend on it (the needs chain). Read-only.",
      inputSchema: {
        type: "object" as const,
        properties: {
          path: { type: "string", description: "Path to the chant project directory (default: current directory)" },
          job: { type: "string", description: "Job name to trace downstream from" },
        },
        required: ["job"],
      },
      async handler(params: Record<string, unknown>): Promise<unknown> {
        const { yaml } = await buildGithub((params.path as string) ?? ".");
        const job = params.job as string;
        return { job, wouldRerun: downstreamJobs(yaml, job) };
      },
    },
    {
      name: "github:workflow-yaml",
      description: "Build the project and return the generated GitHub Actions workflow YAML as a string. Read-only.",
      inputSchema: PATH_INPUT,
      async handler(params: Record<string, unknown>): Promise<unknown> {
        const { yaml } = await buildGithub((params.path as string) ?? ".");
        return { yaml };
      },
    },
  ];
}
