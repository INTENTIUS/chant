import { createRequire } from "module";
import type { HoverContext, HoverInfo } from "@intentius/chant/lsp/types";
import { LexiconIndex, lexiconHover, type LexiconEntry } from "@intentius/chant/lsp/lexicon-providers";
const require = createRequire(import.meta.url);

// GCP's generated lexicon JSON includes extra CRD-derived metadata (apiVersion,
// gvkKind) that the core LexiconEntry interface doesn't carry. Type the data
// locally as a GCP-specific extension.
type GcpLexiconEntry = LexiconEntry & {
  apiVersion?: string;
  gvkKind?: string;
};

let cachedIndex: LexiconIndex | null = null;

function getIndex(): LexiconIndex {
  if (cachedIndex) return cachedIndex;
  const data = require("../generated/lexicon-gcp.json") as Record<string, GcpLexiconEntry>;
  cachedIndex = new LexiconIndex(data);
  return cachedIndex;
}

export function gcpHover(ctx: HoverContext): HoverInfo | undefined {
  return lexiconHover(ctx, getIndex(), resourceHover);
}

function resourceHover(className: string, entry: LexiconEntry): HoverInfo | undefined {
  const lines: string[] = [];
  const gcpEntry = entry as GcpLexiconEntry;

  lines.push(`**${className}**`);
  lines.push("");
  lines.push(`GCP Config Connector resource: \`${entry.resourceType}\``);

  if (gcpEntry.apiVersion) {
    lines.push(`API Version: \`${gcpEntry.apiVersion}\``);
  }

  if (gcpEntry.gvkKind) {
    lines.push(`Kind: \`${gcpEntry.gvkKind}\``);
  }

  const customAttrs = Object.entries(entry.attrs ?? {})
    .filter(([k]) => k !== "apiVersion" && k !== "kind" && k !== "name" && k !== "namespace" && k !== "uid");
  if (customAttrs.length > 0) {
    lines.push("");
    lines.push("**Attributes:**");
    for (const [key, value] of customAttrs) {
      lines.push(`- \`${key}\` → \`${value}\``);
    }
  }

  // Link to Config Connector docs
  const parts = entry.resourceType.split("::");
  if (parts.length >= 3) {
    const service = parts[1].toLowerCase();
    const kind = parts[2].toLowerCase();
    lines.push("");
    lines.push(`[Config Connector docs](https://cloud.google.com/config-connector/docs/reference/resource-docs/${service}/${service}${kind})`);
  }

  return { contents: lines.join("\n") };
}
