import { createRequire } from "module";
import type { HoverContext, HoverInfo } from "@intentius/chant/lsp/types";
import { LexiconIndex, lexiconHover, type LexiconEntry } from "@intentius/chant/lsp/lexicon-providers";
const require = createRequire(import.meta.url);

let cachedIndex: LexiconIndex | null = null;

function getIndex(): LexiconIndex {
  if (cachedIndex) return cachedIndex;
  const data = require("../generated/lexicon-flyway.json") as Record<string, LexiconEntry>;
  cachedIndex = new LexiconIndex(data);
  return cachedIndex;
}

/**
 * Provide hover information for Flyway config types.
 */
export function flywayHover(ctx: HoverContext): HoverInfo | undefined {
  return lexiconHover(ctx, getIndex(), resourceHover);
}

function resourceHover(className: string, entry: LexiconEntry): HoverInfo | undefined {
  const lines: string[] = [];

  lines.push(`**${className}**`);
  lines.push("");
  lines.push(`Flyway config type: \`${entry.resourceType}\``);

  if (entry.kind === "resource") {
    lines.push("");
    lines.push("*Resource — serialized as a top-level TOML section*");
  } else {
    lines.push("");
    lines.push("*Property — used as a nested value in config sections*");
  }

  // Add contextual info based on type
  const type = entry.resourceType;
  if (type === "Flyway::Project") {
    lines.push("");
    lines.push("Top-level project container. Properties appear at the TOML root.");
  } else if (type === "Flyway::Config") {
    lines.push("");
    lines.push("Global Flyway settings. Serialized under `[flyway]` section.");
  } else if (type === "Flyway::Environment") {
    lines.push("");
    lines.push("Environment definition. Serialized under `[environments.<name>]`.");
  } else if (type.startsWith("Flyway::Resolver.")) {
    const resolverType = type.split(".").pop();
    lines.push("");
    lines.push(`Resolver configuration for \`${resolverType}\`. Serialized under \`[environments.<name>.resolvers.${resolverType?.toLowerCase()}]\`.`);
  } else if (type.startsWith("Flyway::Provisioner.")) {
    const provType = type.split(".").pop();
    lines.push("");
    lines.push(`Provisioner type: \`${provType?.toLowerCase()}\`. Set as \`provisioner\` value in an environment.`);
  }

  return { contents: lines.join("\n") };
}
