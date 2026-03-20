import { createRequire } from "module";
import type { HoverContext, HoverInfo } from "@intentius/chant/lsp/types";
import { LexiconIndex, lexiconHover, type LexiconEntry } from "@intentius/chant/lsp/lexicon-providers";
const require = createRequire(import.meta.url);

let cachedIndex: LexiconIndex | null = null;

function getIndex(): LexiconIndex {
  if (cachedIndex) return cachedIndex;
  const data = require("../generated/lexicon-docker.json") as Record<string, LexiconEntry>;
  cachedIndex = new LexiconIndex(data);
  return cachedIndex;
}

/**
 * Provide hover information for Docker entity types.
 */
export function dockerHover(ctx: HoverContext): HoverInfo | undefined {
  return lexiconHover(ctx, getIndex(), resourceHover);
}

function resourceHover(className: string, entry: LexiconEntry): HoverInfo | undefined {
  const lines: string[] = [];

  lines.push(`**${className}**`);
  lines.push("");
  lines.push(`Docker type: \`${entry.resourceType}\``);

  if (entry.resourceType.startsWith("Docker::Compose::")) {
    lines.push("");
    lines.push("*Compose resource — serialized into docker-compose.yml*");
  } else if (entry.resourceType === "Docker::Dockerfile") {
    lines.push("");
    lines.push("*Dockerfile resource — serialized as Dockerfile.{name}*");
  }

  return { contents: lines.join("\n") };
}
