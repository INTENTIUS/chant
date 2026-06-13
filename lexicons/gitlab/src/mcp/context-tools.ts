/**
 * Read-only MCP tools that expose what `chant build` already computes about a
 * GitLab pipeline — its stages and jobs, what it pulls in from outside, its
 * security findings — so an agent can ask about a change *before it runs or
 * merges* (#327, #328).
 *
 * Every tool here builds from source and returns data. None of them touch the
 * live GitLab instance, read run history, or write anything — that boundary is
 * what keeps chant a context producer and not a copy of the live tooling.
 */

import { build, type BuildResult } from "@intentius/chant/build";
import { runPostSynthChecks, getPrimaryOutput } from "@intentius/chant/lint/post-synth";
import { discoverPostSynthChecks } from "@intentius/chant/lint/discover";
import type { McpToolContribution } from "@intentius/chant/mcp/types";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { gitlabSerializer } from "../serializer";
import {
  extractStages,
  extractJobs,
  extractIncludes,
  extractImageRefs,
  isPinnedRef,
} from "../lint/post-synth/yaml-helpers";

/** Build the project and return the emitted GitLab YAML plus the raw result. */
async function buildGitlab(path: string): Promise<{ yaml: string; result: BuildResult }> {
  const result = await build(path, [gitlabSerializer]);
  const out = result.outputs.get("gitlab");
  return { yaml: out ? getPrimaryOutput(out) : "", result };
}

/** Discover the lexicon's post-synth checks without depending on the plugin. */
function gitlabPostSynthChecks() {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "lint", "post-synth");
  return discoverPostSynthChecks(dir, import.meta.url);
}

/** Is a component address (`host/group/comp@version`) pinned to a fixed version? */
export function componentPinned(value: string): boolean {
  const at = value.lastIndexOf("@");
  return at !== -1 && isPinnedRef(value.slice(at + 1));
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

/** The read-only context tools for the GitLab lexicon. */
export function gitlabContextTools(): McpToolContribution[] {
  return [
    {
      name: "gitlab:checks",
      description:
        "Build the pipeline and return its security and correctness findings (the WGL checks) as JSON. Read-only — does not touch the live GitLab instance.",
      inputSchema: PATH_INPUT,
      async handler(params: Record<string, unknown>): Promise<unknown> {
        const { yaml, result } = await buildGitlab((params.path as string) ?? ".");
        if (!yaml) return { findings: [], note: "no GitLab pipeline produced from this project" };
        const scoped = { ...result, outputs: new Map([["gitlab", result.outputs.get("gitlab")!]]) };
        const diags = runPostSynthChecks(gitlabPostSynthChecks(), scoped);
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
      name: "gitlab:pipeline",
      description:
        "Build the pipeline and return its stages and jobs as written (name, stage, and what each job runs after) — before anything runs. Read-only.",
      inputSchema: PATH_INPUT,
      async handler(params: Record<string, unknown>): Promise<unknown> {
        const { yaml } = await buildGitlab((params.path as string) ?? ".");
        const jobs = [...extractJobs(yaml).values()].map((j) => ({
          name: j.name,
          stage: j.stage ?? null,
          runsAfter: j.needs ?? [],
        }));
        return { stages: extractStages(yaml), jobs };
      },
    },
    {
      name: "gitlab:references",
      description:
        "Build the pipeline and list everything it pulls in from outside (includes, components, images) and whether each is pinned to a fixed version. Read-only.",
      inputSchema: PATH_INPUT,
      async handler(params: Record<string, unknown>): Promise<unknown> {
        const { yaml } = await buildGitlab((params.path as string) ?? ".");
        const includes = extractIncludes(yaml).map((e) => ({
          kind: e.kind,
          source: e.value,
          ref: e.ref ?? null,
          pinned:
            e.kind === "project" ? (e.ref ? isPinnedRef(e.ref) : false) : e.kind === "component" ? componentPinned(e.value) : null,
        }));
        const images = extractImageRefs(yaml).map((i) => ({
          kind: "image" as const,
          source: i.image,
          ref: null,
          pinned: i.image.includes("@sha256:"),
        }));
        return [...includes, ...images];
      },
    },
    {
      name: "gitlab:affected",
      description:
        "Build the pipeline and, given a job name, list the jobs that would re-run because they depend on it (the needs chain). Read-only.",
      inputSchema: {
        type: "object" as const,
        properties: {
          path: { type: "string", description: "Path to the chant project directory (default: current directory)" },
          job: { type: "string", description: "Job name to trace downstream from" },
        },
        required: ["job"],
      },
      async handler(params: Record<string, unknown>): Promise<unknown> {
        const { yaml } = await buildGitlab((params.path as string) ?? ".");
        const job = params.job as string;
        return { job, wouldRerun: downstreamJobs(yaml, job) };
      },
    },
    {
      name: "gitlab:pipeline-yaml",
      description: "Build the project and return the generated .gitlab-ci.yml as a string. Read-only.",
      inputSchema: PATH_INPUT,
      async handler(params: Record<string, unknown>): Promise<unknown> {
        const { yaml } = await buildGitlab((params.path as string) ?? ".");
        return { yaml };
      },
    },
  ];
}
