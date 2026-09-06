import type { HoverContext, HoverInfo } from "@intentius/chant/lsp/types";
import { lexiconHover, type LexiconEntry } from "@intentius/chant/lsp/lexicon-providers";
import { fountainLexiconIndex } from "./lexicon-index";

/**
 * Per-kind notes. The security-relevant semantics (deny-all networking,
 * vault precedence, conversation-scoped vault attachment) are the ones an
 * author gets wrong from the property names alone, so hover carries them
 * rather than leaving them to the skills.
 */
const KIND_NOTES: Record<string, string> = {
  Environment:
    "Sandbox baseline — packages, repositories, env_vars, secrets, networking.\n\n" +
    "`networking_type: limited` restricts egress to `networking_config.allowed_hosts`; " +
    "an empty list denies all egress. `unrestricted` is open — FTN010/FTN011 flag both silence and openness.",
  Vault:
    "Env-var overrides attached at conversation create. Vault values win on key " +
    "collision with the environment, silently — FTN014 surfaces the shadowing in review.",
  Agent:
    "A runnable agent config bound to one Environment. `allowed_vault_ids`: " +
    "`null` allows any tenant vault, `[]` forbids all, a list is an allowlist — " +
    "set `[]` when the reviewed environment must not be overridable at spawn.\n\n" +
    "`runtime: \"acp\"` with `runtime_command` is a chant extension pending " +
    "BinaryBourbon/fountain#1634; FTN023 keeps the pair together and FTN016 " +
    "rejects a model on it.",
  Teammate:
    "An Agent seated on the team, with a thread of its own. `agent` is a typed " +
    "reference; `environment` and `vault` override the agent's own for this " +
    "seat and must satisfy its allowlists. FTN021 rejects a dangling reference " +
    "at build rather than at apply.",
  Schedule:
    "A cron prompt sent to a Teammate. `cron` is five fields in UTC (FTN020). " +
    "`one_off: false` sends into the teammate's own thread — a busy teammate " +
    "means the run is skipped, not queued; `one_off: true` opens a fresh " +
    "conversation each fire.",
  Webhook:
    "A URL fountain POSTs lifecycle events to. FTN022 requires https and " +
    "refuses loopback, link-local and RFC1918 targets — fountain refuses them " +
    "again at request time. The signing secret is returned once at create and " +
    "is never readable, so it is not part of the declared shape.",
};

/** Enum-valued props are worth spelling out inline — they are the typo surface. */
function enumLines(entry: LexiconEntry): string[] {
  const constraints = entry.propertyConstraints as
    | Record<string, { enum?: unknown[] }>
    | undefined;
  if (!constraints) return [];

  const lines: string[] = [];
  for (const [prop, c] of Object.entries(constraints)) {
    if (!Array.isArray(c?.enum) || c.enum.length === 0) continue;
    lines.push(`- \`${prop}\`: ${c.enum.map((v) => `\`${String(v)}\``).join(" | ")}`);
  }
  return lines;
}

function fountainHover(className: string, entry: LexiconEntry): HoverInfo | undefined {
  const lines: string[] = [`**${className}**`, "", `Fountain type: \`${entry.resourceType}\``];

  if (entry.kind === "property") {
    lines.push("", "*Property type — a nested shape, not a standalone declarable.*");
    return { contents: lines.join("\n") };
  }

  const note = KIND_NOTES[className];
  if (note) lines.push("", note);

  const enums = enumLines(entry);
  if (enums.length > 0) lines.push("", "Enumerated properties:", ...enums);

  return { contents: lines.join("\n") };
}

/** Provide LSP hover information for fountain resources. */
export function hover(ctx: HoverContext): HoverInfo | undefined {
  return lexiconHover(ctx, fountainLexiconIndex(), fountainHover);
}
