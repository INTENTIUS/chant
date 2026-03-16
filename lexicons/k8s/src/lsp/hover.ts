import { createRequire } from "module";
import type { HoverContext, HoverInfo } from "@intentius/chant/lsp/types";
import { LexiconIndex, lexiconHover, type LexiconEntry } from "@intentius/chant/lsp/lexicon-providers";
const require = createRequire(import.meta.url);

let cachedIndex: LexiconIndex | null = null;

function getIndex(): LexiconIndex {
  if (cachedIndex) return cachedIndex;
  const data = require("../generated/lexicon-k8s.json") as Record<string, LexiconEntry>;
  cachedIndex = new LexiconIndex(data);
  return cachedIndex;
}

/**
 * Provide hover information for Kubernetes resource types.
 */
export function k8sHover(ctx: HoverContext): HoverInfo | undefined {
  return lexiconHover(ctx, getIndex(), resourceHover);
}

function resourceHover(className: string, entry: LexiconEntry): HoverInfo | undefined {
  const lines: string[] = [];

  lines.push(`**${className}**`);
  lines.push("");
  lines.push(`K8s resource type: \`${entry.resourceType}\``);

  // Show apiVersion if stored in attrs
  const apiVersion = entry.attrs?.apiVersion;
  if (apiVersion) {
    lines.push(`apiVersion: \`${apiVersion}\``);
  }

  // Show GVK kind if stored in attrs
  const gvkKind = entry.attrs?.gvkKind;
  if (gvkKind) {
    lines.push(`kind: \`${gvkKind}\``);
  }

  if (entry.kind === "resource") {
    lines.push("");
    lines.push("*Resource — serialized as a top-level Kubernetes object*");
  } else {
    lines.push("");
    lines.push("*Property — used as a nested value in resource specs*");
  }

  if (entry.attrs && Object.keys(entry.attrs).length > 0) {
    const displayAttrs = Object.entries(entry.attrs).filter(
      ([k]) => k !== "apiVersion" && k !== "gvkKind",
    );
    if (displayAttrs.length > 0) {
      lines.push("");
      lines.push("**Attributes:**");
      for (const [key, value] of displayAttrs) {
        lines.push(`- \`${key}\` \u2192 \`${value}\``);
      }
    }
  }

  if (entry.primaryIdentifier && entry.primaryIdentifier.length > 0) {
    lines.push("");
    lines.push(`**Primary identifier:** ${entry.primaryIdentifier.map((p) => `\`${p}\``).join(", ")}`);
  }

  return { contents: lines.join("\n") };
}
