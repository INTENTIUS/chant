import { createRequire } from "module";
import type { HoverContext, HoverInfo } from "@intentius/chant/lsp/types";
import { LexiconIndex, lexiconHover, type LexiconEntry } from "@intentius/chant/lsp/lexicon-providers";
const require = createRequire(import.meta.url);

let cachedIndex: LexiconIndex | null = null;

function getIndex(): LexiconIndex {
  if (cachedIndex) return cachedIndex;
  const data = require("../generated/lexicon-azure.json") as Record<string, LexiconEntry>;
  cachedIndex = new LexiconIndex(data);
  return cachedIndex;
}

/**
 * Provide hover information for Azure resource types and properties.
 */
export function azureHover(ctx: HoverContext): HoverInfo | undefined {
  return lexiconHover(ctx, getIndex(), resourceHover);
}

function resourceHover(className: string, entry: LexiconEntry): HoverInfo | undefined {
  if (entry.kind !== "resource") return undefined;

  const lines: string[] = [];

  lines.push(`**${className}**`);
  lines.push("");
  lines.push(`ARM resource type: \`${entry.resourceType}\``);

  const apiVersion = (entry as Record<string, unknown>).apiVersion;
  if (apiVersion) {
    lines.push(`API version: \`${apiVersion}\``);
  }

  if (entry.attrs && Object.keys(entry.attrs).length > 0) {
    lines.push("");
    lines.push("**Attributes:**");
    for (const [key, value] of Object.entries(entry.attrs)) {
      lines.push(`- \`${key}\` → \`${value}\``);
    }
  }

  const provider = entry.resourceType.split("/")[0]?.replace("Microsoft.", "").toLowerCase();
  const resource = entry.resourceType.split("/").pop()?.toLowerCase();
  if (provider && resource) {
    lines.push("");
    lines.push(`[Azure docs](https://learn.microsoft.com/en-us/azure/templates/${provider}/${resource})`);
  }

  return { contents: lines.join("\n") };
}
