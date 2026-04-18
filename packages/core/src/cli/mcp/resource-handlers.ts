import { resolve } from "node:path";
import type { ResourceDefinition } from "./types";
import { getContext } from "./resources/context";
import { readSnapshot, readEnvironmentSnapshots } from "../../state/git";
import { discoverOps } from "../../op/discover";
import { makeTemporalClient } from "../handlers/run";
import { resolveWorkflowId } from "../handlers/run-client";

type PluginResourceEntry = { definition: ResourceDefinition; handler: () => Promise<string> };

/**
 * Core resource definitions (always present regardless of plugins)
 */
export const coreResourceDefinitions: ResourceDefinition[] = [
  {
    uri: "chant://context",
    name: "chant Context",
    description: "Lexicon-specific instructions and patterns for chant development",
    mimeType: "text/markdown",
  },
  {
    uri: "chant://examples/list",
    name: "Examples List",
    description: "List of available chant examples",
    mimeType: "application/json",
  },
  {
    uri: "chant://ops",
    name: "Ops",
    description: "All Op definitions discovered from *.op.ts files",
    mimeType: "application/json",
  },
  {
    uri: "chant://ops/{name}/runs",
    name: "Op run history",
    description: "Workflow run history for a named Op",
    mimeType: "application/json",
  },
  {
    uri: "chant://ops/{name}/runs/latest",
    name: "Op latest run",
    description: "Latest run state for a named Op",
    mimeType: "application/json",
  },
  {
    uri: "chant://state/{environment}",
    name: "State (all lexicons)",
    description: "All lexicon snapshots for an environment",
    mimeType: "application/json",
  },
  {
    uri: "chant://state/{environment}/{lexicon}",
    name: "State (single lexicon)",
    description: "Single lexicon snapshot for an environment",
    mimeType: "application/json",
  },
];

/**
 * Build the full resources list merging core + plugin resources
 */
export function buildResourcesList(
  pluginResources: Map<string, PluginResourceEntry>,
): { resources: ResourceDefinition[] } {
  const resources = [...coreResourceDefinitions];
  for (const { definition } of pluginResources.values()) {
    resources.push(definition);
  }
  return { resources };
}

/**
 * Collect example resources from plugins whose URI contains "examples/"
 */
export function collectExamples(
  pluginResources: Map<string, PluginResourceEntry>,
): Array<{ name: string; description: string }> {
  const examples: Array<{ name: string; description: string }> = [];
  for (const [uri, { definition }] of pluginResources.entries()) {
    if (uri.includes("/examples/")) {
      const name = uri.replace(/^chant:\/\/[^/]+\/examples\//, "");
      examples.push({ name, description: definition.description });
    }
  }
  return examples;
}

function opWorkflowFnName(opName: string): string {
  return opName.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()) + "Workflow";
}

/**
 * Handle resources/read request — checks plugin resources after core
 */
export async function handleResourcesRead(
  params: Record<string, unknown>,
  pluginResources: Map<string, PluginResourceEntry>,
): Promise<unknown> {
  const uri = params.uri as string;

  if (uri === "chant://context") {
    return {
      contents: [
        {
          uri,
          mimeType: "text/markdown",
          text: getContext(),
        },
      ],
    };
  }

  if (uri === "chant://examples/list") {
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(collectExamples(pluginResources)),
        },
      ],
    };
  }

  // Op resources
  if (uri === "chant://ops") {
    const { ops } = await discoverOps();
    const list = Array.from(ops.values()).map(({ config }) => ({
      name: config.name,
      overview: config.overview,
      phases: config.phases.length,
      taskQueue: config.taskQueue ?? config.name,
      depends: config.depends ?? [],
    }));
    return {
      contents: [{ uri, mimeType: "application/json", text: JSON.stringify(list, null, 2) }],
    };
  }

  if (uri.startsWith("chant://ops/") && uri.endsWith("/runs/latest")) {
    const name = uri.replace("chant://ops/", "").replace("/runs/latest", "");
    try {
      const { client } = await makeTemporalClient(undefined, resolve("."));
      const handle = client.workflow.getHandle(resolveWorkflowId(name));
      const desc = await handle.describe();
      const history = await handle.fetchHistory();
      const events = history.events ?? [];
      const result = {
        workflowId: desc.workflowId,
        runId: desc.runId,
        status: desc.status.name,
        startTime: desc.startTime,
        closeTime: desc.closeTime ?? null,
        taskQueue: desc.taskQueue,
        activitiesCompleted: events.filter((e) => e.eventType === "ActivityTaskCompleted").length,
        activitiesScheduled: events.filter((e) => e.eventType === "ActivityTaskScheduled").length,
      };
      return {
        contents: [{ uri, mimeType: "application/json", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        contents: [{ uri, mimeType: "application/json", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }],
      };
    }
  }

  if (uri.startsWith("chant://ops/") && uri.endsWith("/runs")) {
    const name = uri.replace("chant://ops/", "").replace("/runs", "");
    try {
      const { client } = await makeTemporalClient(undefined, resolve("."));
      const runs: unknown[] = [];
      for await (const run of client.workflow.list({ query: `WorkflowType = "${opWorkflowFnName(name)}"` })) {
        runs.push({ runId: run.runId, status: run.status.name, startTime: run.startTime, closeTime: run.closeTime ?? null });
      }
      return {
        contents: [{ uri, mimeType: "application/json", text: JSON.stringify(runs, null, 2) }],
      };
    } catch (err) {
      return {
        contents: [{ uri, mimeType: "application/json", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }],
      };
    }
  }

  // State resources: chant://state/{environment} and chant://state/{environment}/{lexicon}
  if (uri.startsWith("chant://state/")) {
    const parts = uri.replace("chant://state/", "").split("/");
    const environment = parts[0];
    const lexicon = parts[1];

    if (lexicon) {
      const content = await readSnapshot(environment, lexicon);
      if (!content) throw new Error(`No snapshot found for ${environment}/${lexicon}`);
      return {
        contents: [{ uri, mimeType: "application/json", text: content }],
      };
    } else {
      const snapshots = await readEnvironmentSnapshots(environment);
      const result: Record<string, unknown> = {};
      for (const [lex, content] of snapshots) {
        result[lex] = JSON.parse(content);
      }
      return {
        contents: [{ uri, mimeType: "application/json", text: JSON.stringify(result, null, 2) }],
      };
    }
  }

  if (uri.startsWith("chant://examples/")) {
    // Look up example in plugin resources
    const name = uri.replace("chant://examples/", "");
    for (const [pluginUri, pluginResource] of pluginResources.entries()) {
      if (pluginUri.endsWith(`/examples/${name}`)) {
        const text = await pluginResource.handler();
        return {
          contents: [
            {
              uri,
              mimeType: pluginResource.definition.mimeType ?? "text/typescript",
              text,
            },
          ],
        };
      }
    }
    throw new Error(`Example not found: ${name}`);
  }

  // Check plugin resources
  const pluginResource = pluginResources.get(uri);
  if (pluginResource) {
    const text = await pluginResource.handler();
    return {
      contents: [
        {
          uri,
          mimeType: pluginResource.definition.mimeType ?? "text/plain",
          text,
        },
      ],
    };
  }

  throw new Error(`Unknown resource: ${uri}`);
}
