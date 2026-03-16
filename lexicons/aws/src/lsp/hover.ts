import { createRequire } from "module";
import type { HoverContext, HoverInfo } from "@intentius/chant/lsp/types";
import { LexiconIndex, lexiconHover, type LexiconEntry } from "@intentius/chant/lsp/lexicon-providers";
const require = createRequire(import.meta.url);

let cachedIndex: LexiconIndex | null = null;

function getIndex(): LexiconIndex {
  if (cachedIndex) return cachedIndex;
  const data = require("../generated/lexicon-aws.json") as Record<string, LexiconEntry>;
  cachedIndex = new LexiconIndex(data);
  return cachedIndex;
}

/**
 * Provide hover information for AWS resource types and properties.
 */
export function awsHover(ctx: HoverContext): HoverInfo | undefined {
  return lexiconHover(ctx, getIndex(), resourceHover);
}

function resourceHover(className: string, entry: LexiconEntry): HoverInfo | undefined {
  if (entry.kind !== "resource") return undefined;

  const lines: string[] = [];

  lines.push(`**${className}**`);
  lines.push("");
  lines.push(`CloudFormation type: \`${entry.resourceType}\``);

  if (entry.attrs && Object.keys(entry.attrs).length > 0) {
    lines.push("");
    lines.push("**Attributes:**");
    for (const [key, value] of Object.entries(entry.attrs)) {
      lines.push(`- \`${key}\` → \`${value}\``);
    }
  }

  if (entry.primaryIdentifier && entry.primaryIdentifier.length > 0) {
    lines.push("");
    lines.push(`**Primary identifier:** ${entry.primaryIdentifier.map((p) => `\`${p}\``).join(", ")}`);
  }

  if (entry.createOnly && entry.createOnly.length > 0) {
    lines.push("");
    lines.push(`**Create-only:** ${entry.createOnly.map((p) => `\`${p}\``).join(", ")}`);
  }

  if (entry.writeOnly && entry.writeOnly.length > 0) {
    lines.push("");
    lines.push(`**Write-only:** ${entry.writeOnly.map((p) => `\`${p}\``).join(", ")}`);
  }

  if (entry.replacementStrategy === "delete_then_create" && entry.createOnly?.length) {
    lines.push("");
    lines.push("**Replacement:** Modifying create-only properties causes delete-then-create replacement");
  }

  if (entry.conditionalCreateOnly?.length) {
    lines.push("");
    lines.push(`**Conditionally immutable:** ${entry.conditionalCreateOnly.map((p) => `\`${p}\``).join(", ")}`);
  }

  if (entry.deprecatedProperties?.length) {
    lines.push("");
    lines.push(`**Deprecated properties:** ${entry.deprecatedProperties.map((p) => `\`${p}\``).join(", ")}`);
  }

  return { contents: lines.join("\n") };
}
