import { createRequire } from "module";
import type { HoverContext, HoverInfo } from "@intentius/chant/lsp/types";
import { LexiconIndex, lexiconHover, type LexiconEntry } from "@intentius/chant/lsp/lexicon-providers";
const require = createRequire(import.meta.url);

let cachedIndex: LexiconIndex | null = null;

function getIndex(): LexiconIndex {
  if (cachedIndex) return cachedIndex;
  const data = require("../generated/lexicon-temporal.json") as Record<string, LexiconEntry>;
  cachedIndex = new LexiconIndex(data);
  return cachedIndex;
}

/**
 * Provide hover information for Temporal resource types.
 */
export function temporalHover(ctx: HoverContext): HoverInfo | undefined {
  return lexiconHover(ctx, getIndex(), resourceHover);
}

function resourceHover(className: string, entry: LexiconEntry): HoverInfo | undefined {
  const lines: string[] = [];

  lines.push(`**${className}**`);
  lines.push("");
  lines.push(`Temporal type: \`${entry.resourceType}\``);

  switch (entry.resourceType) {
    case "Temporal::Server":
      lines.push("");
      lines.push("*Serializes to docker-compose.yml (and Helm values in `mode: \"full\"`)*");
      break;
    case "Temporal::Namespace":
      lines.push("");
      lines.push("*Serializes to a `temporal operator namespace create` command in temporal-setup.sh*");
      break;
    case "Temporal::SearchAttribute":
      lines.push("");
      lines.push("*Serializes to a `temporal operator search-attribute create` command in temporal-setup.sh*");
      break;
    case "Temporal::Schedule":
      lines.push("");
      lines.push("*Serializes to SDK schedule-creation TypeScript in schedules/<id>.ts*");
      break;
  }

  return { contents: lines.join("\n") };
}
