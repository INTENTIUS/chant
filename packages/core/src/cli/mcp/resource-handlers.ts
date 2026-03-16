import type { ResourceDefinition } from "./types";
import { getContext } from "./resources/context";
import { readSnapshot, readEnvironmentSnapshots } from "../../state/git";
import { discoverSpells } from "../../spell/discovery";
import { generatePrompt } from "../../spell/prompt";
import { getRuntime } from "../../runtime-adapter";

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
    uri: "chant://spells",
    name: "Spells",
    description: "List all spells with status, tasks, and lexicon",
    mimeType: "application/json",
  },
  {
    uri: "chant://spell/{name}",
    name: "Spell details",
    description: "Show spell definition and status",
    mimeType: "application/json",
  },
  {
    uri: "chant://spell/{name}/prompt",
    name: "Spell bootstrap prompt",
    description: "Bootstrap prompt for agent consumption",
    mimeType: "text/markdown",
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

  // Spell resources
  if (uri === "chant://spells") {
    const { spells } = await discoverSpells();
    const list = Array.from(spells.entries()).map(([name, s]) => ({
      name,
      status: s.status,
      tasks: `${s.definition.tasks.filter((t) => t.done).length}/${s.definition.tasks.length}`,
      lexicon: s.definition.lexicon ?? null,
      overview: s.definition.overview,
    }));
    return {
      contents: [{ uri, mimeType: "application/json", text: JSON.stringify(list, null, 2) }],
    };
  }

  if (uri.startsWith("chant://spell/") && uri.endsWith("/prompt")) {
    const name = uri.replace("chant://spell/", "").replace("/prompt", "");
    const { spells } = await discoverSpells();
    const spell = spells.get(name);
    if (!spell) throw new Error(`Spell "${name}" not found`);
    const rt = getRuntime();
    const gitRootResult = await rt.spawn(["git", "rev-parse", "--show-toplevel"]);
    const gitRoot = gitRootResult.stdout.trim();
    const prompt = await generatePrompt(spell.definition, { gitRoot });
    return {
      contents: [{ uri, mimeType: "text/markdown", text: prompt }],
    };
  }

  if (uri.startsWith("chant://spell/")) {
    const name = uri.replace("chant://spell/", "");
    const { spells } = await discoverSpells();
    const spell = spells.get(name);
    if (!spell) throw new Error(`Spell "${name}" not found`);
    return {
      contents: [{
        uri,
        mimeType: "application/json",
        text: JSON.stringify({
          ...spell.definition,
          status: spell.status,
          filePath: spell.filePath,
        }, null, 2),
      }],
    };
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
