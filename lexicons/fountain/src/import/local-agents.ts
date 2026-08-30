/**
 * Re-express a machine's local agent configuration as fountain resources.
 *
 * `chant audit --agents` answers "what is configured on this machine". This is
 * the other half: taking that inventory and turning it into chant code, so a
 * configuration that accumulated by hand over months becomes a reviewable,
 * version-controlled, reproducible declaration.
 *
 * The mapping is close to 1:1 because fountain's `Agent` models the same four
 * ideas the harnesses do:
 *
 *   | local agent config            | fountain              |
 *   |-------------------------------|-----------------------|
 *   | CLAUDE.md / AGENTS.md         | `Agent.system`        |
 *   | `mcpServers` / `mcp_servers`  | `Agent.mcp_servers`   |
 *   | `skills/*​/SKILL.md`           | `Agent.skills`        |
 *   | settings `env`                | `Environment.env_vars`|
 *
 * Three places where it is deliberately *not* a transcription:
 *
 *  1. **Egress is derived, not copied.** A local agent runs with the machine's
 *     full network access; a fountain sandbox must declare intent (FTN010). The
 *     hosts the config's own remote MCP servers use are exactly the egress it
 *     demonstrably needs, so those become the `allowed_hosts` allowlist and
 *     everything else is denied. Copying "unrestricted" would launder an
 *     implicit local permission into an explicit remote one.
 *  2. **Secrets are not carried over.** A literal credential found in local
 *     config (AGT002) is rewritten to a `${VAR}` reference in the emitted code.
 *     Generated chant code gets committed; transcribing a live secret into it
 *     would turn a local mistake into a repository one.
 *  3. **Skills are inlined by content where possible.** A local skill is text
 *     on this machine with no upstream, so `{name, content}` is the only form
 *     that reproduces it elsewhere. Remote skills keep `{source, ref}`.
 *
 * Cursor is discovered by the scanner but has no fountain `runtime` value, so
 * its sites are reported as skipped rather than silently mapped onto a
 * different agent runtime.
 */

import type { ResourceIR } from "@intentius/chant/import/parser";
import type { AgentConfigSite, McpServerDecl, SkillDecl } from "@intentius/chant/agents";
import type { AgentImportOutcome, SkippedSite } from "@intentius/chant/agents/importer";

/** Runtimes fountain's `Agent.runtime` accepts. `cursor` is absent by design. */
export const MAPPABLE_RUNTIMES = ["claude", "codex", "gemini", "opencode"] as const;
export type MappableRuntime = (typeof MAPPABLE_RUNTIMES)[number];

/**
 * Default model per runtime, used when the local config pins none.
 *
 * `Agent.model` is required by fountain, and most local configs leave the model
 * to the harness's own default — a value that isn't written down anywhere this
 * scanner can read. Emitting a documented default that the user edits is more
 * honest than inventing a pin and calling it discovered; `unmappedModel` in the
 * result reports every site this applied to.
 */
export const DEFAULT_MODEL: Record<MappableRuntime, string> = {
  claude: "anthropic/claude-sonnet-4-6",
  codex: "openai/gpt-5.1-codex",
  gemini: "google/gemini-2.5-pro",
  opencode: "anthropic/claude-sonnet-4-6",
};

/**
 * Local model aliases → fountain's `provider/model_id` form.
 *
 * Harnesses accept short names (`opus`, `sonnet`); fountain wants the canonical
 * id. An alias not listed here passes through untouched — a user who pinned an
 * exact provider-qualified model already has the right shape.
 */
const MODEL_ALIASES: Record<string, string> = {
  opus: "anthropic/claude-opus-4-6",
  sonnet: "anthropic/claude-sonnet-4-6",
  haiku: "anthropic/claude-haiku-4-5",
  "gpt-5.5": "openai/gpt-5.5",
  "gpt-5.1-codex": "openai/gpt-5.1-codex",
};

function isMappable(runtime: string): runtime is MappableRuntime {
  return (MAPPABLE_RUNTIMES as readonly string[]).includes(runtime);
}

/** A cross-resource reference the fountain generator renders as a bare variable. */
function ref(logicalId: string): { __ref: string } {
  return { __ref: logicalId };
}

/**
 * Build the `system` prompt from the site's instruction files.
 *
 * Provenance is kept as a comment header per file. A user reading the generated
 * code needs to know which of their three CLAUDE.md files a paragraph came
 * from, and a single concatenated blob without headers makes that unrecoverable.
 */
export function buildSystem(site: AgentConfigSite): string | undefined {
  if (site.instructions.length === 0) return undefined;
  if (site.instructions.length === 1) return site.instructions[0].content.trim();
  return site.instructions.map((f) => `# ${f.path}\n\n${f.content.trim()}`).join("\n\n---\n\n");
}

/** Env-var reference form for a value that must not be inlined. */
function envRef(key: string): string {
  return `\${${key}}`;
}

/** Value shapes that are already indirection rather than a literal. */
const INDIRECT = /^\s*(?:\$\{[^}]+\}|\$[A-Za-z_][A-Za-z0-9_]*|\$\(.+\))\s*$/;
const SECRET_KEY = /(?:^|_)(?:token|secret|password|passwd|api_?key|access_?key|credential|private_?key)s?(?:$|_)/i;
const DIGEST_KEY = /(?:sha\d*|checksum|digest|fingerprint|thumbprint|hash|etag)/i;

/**
 * Header and field names that carry a credential without ever saying "token".
 *
 * `Authorization` is the important one: it is where remote MCP servers put
 * their bearer tokens, it matches none of the "looks like a secret" key
 * heuristics, and it is the single most likely thing in an agent config to be a
 * live credential.
 */
const AUTH_KEY = /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|apikey|x-auth-token|auth)$/i;

/** An HTTP authorization value: a scheme followed by the credential itself. */
const AUTH_SCHEME_VALUE = /^\s*(?:Bearer|Basic|Token|ApiKey)\s+\S+/i;

/**
 * The env-var name a redacted value is replaced with. Namespaced by the thing
 * it belongs to, so two servers' `Authorization` headers don't collapse onto
 * one variable that can only hold one of them.
 */
function secretVarName(context: string, key: string): string {
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const scope = norm(context);
  const name = norm(key);
  // A header like `Authorization` says nothing on its own, so it takes the
  // server's name. A key that already carries it (`CLEANJOBDATA_API_KEY` on the
  // `cleanjobdata` server) is left alone rather than doubled.
  if (AUTH_KEY.test(key)) return `${scope}_AUTH_TOKEN`;
  return name.includes(scope) || scope.includes(name) ? name : `${scope}_${name}`;
}

/**
 * Decide whether a value is a literal credential that must not be written to
 * disk, and if so, what to replace it with.
 *
 * Deliberately more eager than the audit check: this decides what gets written
 * into a file destined for version control, so a false positive costs the user
 * one edit while a false negative commits a live secret.
 */
function redactedValue(key: string, value: string, context: string): string | undefined {
  if (INDIRECT.test(value)) return undefined;
  if (DIGEST_KEY.test(key)) return undefined;
  if (AUTH_KEY.test(key) || AUTH_SCHEME_VALUE.test(value)) return envRef(secretVarName(context, key));
  if (SECRET_KEY.test(key) || value.length >= 32) return envRef(secretVarName(context, key));
  return undefined;
}

/** Replace literal credential values in a flat string map with `${VAR}` references. */
function redactEnv(
  env: Record<string, string> | undefined,
  context: string,
  onRedact: () => void,
): Record<string, string> | undefined {
  if (!env) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const replacement = redactedValue(key, value, context);
    if (replacement !== undefined) {
      out[key] = replacement;
      onRedact();
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Redact credentials anywhere in a nested structure.
 *
 * The passthrough fields a harness accepts (`headers`, auth blocks, whatever a
 * future version adds) are exactly the ones this model does not name, so
 * redaction cannot be a fixed list of keys — it has to walk whatever is there.
 * Everything non-credential is preserved verbatim.
 */
function redactDeep(value: unknown, key: string, context: string, onRedact: () => void): unknown {
  if (typeof value === "string") {
    const replacement = redactedValue(key, value, context);
    if (replacement === undefined) return value;
    onRedact();
    return replacement;
  }
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, key, context, onRedact));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v, k, context, onRedact);
    }
    return out;
  }
  return value;
}

/** Project the normalized MCP declarations back into fountain's `mcp_servers` map. */
export function toMcpServers(servers: McpServerDecl[], onRedact: () => void): Record<string, unknown> | undefined {
  if (servers.length === 0) return undefined;
  const out: Record<string, unknown> = {};
  for (const server of servers) {
    const entry: Record<string, unknown> = {};
    if (server.command) entry.command = server.command;
    if (server.args?.length) entry.args = server.args;
    if (server.url) entry.url = server.url;
    if (server.transport === "sse" || server.transport === "http") entry.type = server.transport;
    const env = redactEnv(server.env, server.name, onRedact);
    if (env && Object.keys(env).length > 0) entry.env = env;
    // `extra` is where `headers` (and anything else the harness accepted that
    // this model doesn't name) lands — so it gets the same redaction as `env`,
    // not a verbatim copy.
    if (server.extra) {
      for (const [key, value] of Object.entries(server.extra)) {
        entry[key] = redactDeep(value, key, server.name, onRedact);
      }
    }
    out[server.name] = entry;
  }
  return out;
}

/**
 * Project skills into fountain's two accepted forms.
 *
 * fountain requires exactly one of `content` or `source` per entry. A local
 * skill has no upstream to install from, so its text is inlined — that is what
 * makes the emitted code reproduce the configuration on a machine that has
 * never seen this one.
 */
export function toSkills(skills: SkillDecl[]): Record<string, unknown>[] | undefined {
  if (skills.length === 0) return undefined;
  const out: Record<string, unknown>[] = [];
  for (const skill of skills) {
    if (skill.source) {
      out.push({ source: skill.source, name: skill.name, ...(skill.ref ? { ref: skill.ref } : {}) });
    } else if (skill.content) {
      out.push({ name: skill.name, content: skill.content });
    }
    // A skill with neither is unreproducible; it is left out rather than
    // emitted as an entry fountain would reject at apply time.
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Hosts the config's own remote MCP servers reach.
 *
 * This is the evidence-based egress allowlist: every host here is one the
 * configuration already talks to, so the sandbox stays functional while
 * everything else stays denied.
 */
export function derivedAllowedHosts(servers: McpServerDecl[]): string[] {
  const hosts = new Set<string>();
  for (const server of servers) {
    if (!server.url) continue;
    try {
      hosts.add(new URL(server.url).hostname);
    } catch {
      // A malformed URL contributes no host — the server simply isn't reachable
      // from the sandbox until someone adds the right one by hand.
    }
  }
  return [...hosts].sort();
}

/** Canonicalize a local model name into fountain's `provider/model_id` form. */
export function canonicalModel(local: string | undefined, runtime: MappableRuntime): { model: string; defaulted: boolean } {
  if (!local) return { model: DEFAULT_MODEL[runtime], defaulted: true };
  const alias = MODEL_ALIASES[local.toLowerCase()];
  if (alias) return { model: alias, defaulted: false };
  return { model: local, defaulted: false };
}

/**
 * Convert discovered agent config sites into fountain import IR.
 *
 * Each mappable site yields an `Agent`, plus an `Environment` when it has
 * anything environmental to declare (env vars, or remote MCP hosts to
 * allowlist). Feed the result to `FountainGenerator` to get chant TypeScript.
 */
export function sitesToTemplateIR(sites: AgentConfigSite[]): AgentImportOutcome {
  const resources: ResourceIR[] = [];
  const skipped: SkippedSite[] = [];
  const unmappedModel: string[] = [];
  const redactedSecrets: string[] = [];

  for (const site of sites) {
    if (!isMappable(site.runtime)) {
      skipped.push({
        siteId: site.id,
        reason: `fountain has no "${site.runtime}" runtime — its Agent.runtime accepts ${MAPPABLE_RUNTIMES.join(", ")}. The config was audited but not re-expressed.`,
      });
      continue;
    }

    let redacted = false;
    const onRedact = () => {
      redacted = true;
    };

    const { model, defaulted } = canonicalModel(site.model, site.runtime);
    if (defaulted) unmappedModel.push(site.id);

    const allowedHosts = derivedAllowedHosts(site.mcpServers);
    const envVars = redactEnv(site.env, site.id, onRedact) ?? {};
    const hasEnvironment = Object.keys(envVars).length > 0 || allowedHosts.length > 0;

    const metadata: Record<string, unknown> = {
      "managed-by": "chant",
      "chant.io/imported-from": "local-agent-config",
      "chant.io/scope": site.scope,
      "chant.io/runtime": site.runtime,
      "chant.io/root": site.root,
    };

    let environmentId: string | undefined;
    if (hasEnvironment) {
      environmentId = `${site.id}-env`;
      resources.push({
        logicalId: environmentId,
        type: "Fountain::V1::Environment",
        properties: {
          name: environmentId,
          // FTN010: intent must be explicit. `limited` with a derived
          // allowlist — an empty list is deny-all, which is the right default
          // for a config whose network needs we could not observe.
          networking_type: "limited",
          networking_config: { allowed_hosts: allowedHosts },
          ...(Object.keys(envVars).length > 0 ? { env_vars: envVars } : {}),
          metadata,
        },
      });
    }

    const mcpServers = toMcpServers(site.mcpServers, onRedact);
    const skills = toSkills(site.skills);
    const system = buildSystem(site);

    resources.push({
      logicalId: site.id,
      type: "Fountain::V1::Agent",
      properties: {
        name: site.id,
        model,
        runtime: site.runtime,
        ...(environmentId ? { environment: ref(environmentId) } : {}),
        ...(system !== undefined ? { system } : {}),
        ...(mcpServers ? { mcp_servers: mcpServers } : {}),
        ...(skills ? { skills } : {}),
        description: `Imported from ${site.scope}-scope ${site.runtime} configuration at ${site.root}`,
        metadata,
      },
    });

    if (redacted) redactedSecrets.push(site.id);
  }

  return { ir: { resources, parameters: [] }, skipped, unmappedModel, redactedSecrets };
}
