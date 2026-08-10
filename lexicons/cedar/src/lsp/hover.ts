import type { HoverContext, HoverInfo } from "@intentius/chant/lsp/types";
import { lexiconHover, type LexiconEntry } from "@intentius/chant/lsp/lexicon-providers";
import { cedarIndex, cedarRegistry } from "./registry";

/**
 * Hover over a generated declaration.
 *
 * Core's default formatter reports CloudFormation-shaped facts (primary
 * identifier, create-only, write-only) a Cedar declaration does not have. The
 * facts that matter here are the Cedar ones: what a `Policy` prop means, which
 * groups an entity type is `in`, and what an action applies to.
 */
export function hover(ctx: HoverContext): HoverInfo | undefined {
  return lexiconHover(ctx, cedarIndex(), formatCedarHover);
}

function formatCedarHover(className: string, indexed: LexiconEntry): HoverInfo | undefined {
  const entry = cedarRegistry()[className];
  if (!entry) return undefined;

  const lines = [`**${className}**`, "", `Cedar type: \`${entry.resourceType}\``];

  if (entry.description) {
    lines.push("", entry.description);
  }

  if (entry.resourceType === "Cedar::Policy") {
    lines.push(
      "",
      "The unit this lexicon serializes — one `.cedar` policy plus its entry in the JSON policy set.",
      "",
      "| Prop | Meaning |",
      "|------|---------|",
      "| `effect` | `permit` or `forbid`; defaults to `permit` |",
      "| `principal`, `action`, `resource` | scope constraints — `{}`, `{ eq }`, `{ in }`, `{ is }` |",
      "| `when`, `unless` | Cedar expression strings, one clause each |",
      "| `annotations` | emitted as `@key(\"value\")` above the policy |",
    );
    return { contents: lines.join("\n") };
  }

  if (entry.resourceType.includes("::Action::")) {
    if (entry.principalTypes?.length) {
      lines.push("", `**Principals:** ${entry.principalTypes.map((t) => `\`${t}\``).join(", ")}`);
    }
    if (entry.resourceTypes?.length) {
      lines.push("", `**Resources:** ${entry.resourceTypes.map((t) => `\`${t}\``).join(", ")}`);
    }
    const context = Object.entries(entry.properties ?? {});
    if (context.length > 0) {
      lines.push("", "**Context:**");
      for (const [name, spec] of context) {
        lines.push(`- \`${name}\`${spec.required ? "" : "?"} — \`${spec.type}\``);
      }
    }
    return { contents: lines.join("\n") };
  }

  if (entry.memberOfTypes?.length) {
    lines.push("", `**Member of:** ${entry.memberOfTypes.map((t) => `\`${t}\``).join(", ")}`);
  }
  if (entry.enumValues?.length) {
    lines.push("", `**Enum values:** ${entry.enumValues.map((v) => `\`${v}\``).join(", ")}`);
  }

  const attributes = Object.entries(entry.properties ?? {});
  if (attributes.length > 0) {
    lines.push("", indexed.kind === "property" ? "**Fields:**" : "**Attributes:**");
    for (const [name, spec] of attributes) {
      lines.push(`- \`${name}\`${spec.required ? "" : "?"} — \`${spec.type}\``);
    }
  }

  return { contents: lines.join("\n") };
}
