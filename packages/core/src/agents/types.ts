/**
 * The normalized model for an agent configuration found on a machine.
 *
 * Five harnesses (claude, codex, gemini, opencode, cursor) each spell the same
 * four ideas differently — standing instructions, tool servers, reusable
 * skills, and ambient settings. `discover.ts` reads each harness's own dialect
 * and lands here; everything downstream (`checks.ts`, the report, the fountain
 * IR mapping) reads only this shape and never a vendor file format again.
 *
 * The `AgentConfigSite` boundary is deliberately "one config that governs one
 * root, for one runtime" rather than "one file". A single Claude Code site is
 * assembled from `CLAUDE.md` + `settings.json` + `settings.local.json` +
 * `mcp.json` + `~/.claude.json` + a `skills/` tree — six files that are only
 * meaningful together, and that the agent itself experiences as one merged
 * configuration. `sources` keeps the receipts so a finding can point at the
 * actual file the reader has to edit.
 */

/**
 * Which agent harness a config belongs to. The first four are exactly
 * fountain's `Agent.runtime` enum, so they re-express losslessly; `cursor` is
 * discovered and reported but has no fountain runtime to map onto (see
 * `MAPPABLE_RUNTIMES` in the fountain import mapper).
 */
export type AgentRuntime = "claude" | "codex" | "gemini" | "opencode" | "cursor";

/**
 * Blast radius of a config, in the order harnesses merge them (later wins).
 *
 * - `system` — machine-wide policy, typically administrator-installed and not
 *   user-editable (Claude Code's `managed-settings.json`).
 * - `user` — the home directory. Applies to *every* project the user opens,
 *   which is what makes it the highest-leverage scope to audit.
 * - `project` — checked into (or sitting beside) a repo. Narrowest scope, but
 *   the one most likely to arrive from someone else.
 */
export type AgentScope = "system" | "user" | "project";

export const AGENT_SCOPES: readonly AgentScope[] = ["system", "user", "project"] as const;
export const AGENT_RUNTIMES: readonly AgentRuntime[] = ["claude", "codex", "gemini", "opencode", "cursor"] as const;

/** A standing-instructions file (CLAUDE.md, AGENTS.md, GEMINI.md, .cursorrules). */
export interface InstructionFile {
  /** Absolute path on disk. */
  path: string;
  /** File contents. Read in full — these become fountain's `Agent.system`. */
  content: string;
  bytes: number;
}

/** How an MCP server is reached. `unknown` when the declaration has neither a command nor a URL. */
export type McpTransport = "stdio" | "http" | "sse" | "unknown";

/** One MCP server declaration, normalized across the several files that can declare one. */
export interface McpServerDecl {
  name: string;
  transport: McpTransport;
  /** The file this declaration was read from. */
  source: string;
  /** stdio: the executable. */
  command?: string;
  /** stdio: argv after the executable. */
  args?: string[];
  /** http/sse: the endpoint. */
  url?: string;
  /** Environment handed to the server process. Values are kept verbatim — `checks.ts` is what decides whether one looks like a literal credential. */
  env?: Record<string, string>;
  /** Extra keys the harness accepted that this model doesn't name (headers, timeouts, …). */
  extra?: Record<string, unknown>;
}

/**
 * Where a skill came from. This distinction is the whole point of the skill
 * checks: a `local` skill is text the user can read in their own filesystem,
 * while `plugin`/`marketplace` skills are fetched from a remote and can change
 * under the user without any edit to their machine.
 */
export type SkillOrigin = "local" | "plugin" | "marketplace";

/** One skill available to the agent. */
export interface SkillDecl {
  name: string;
  origin: SkillOrigin;
  /** Absolute path to the skill directory or SKILL.md, when it exists on disk. */
  path?: string;
  /** Remote source (`owner/repo`, a URL) for plugin/marketplace skills. */
  source?: string;
  /** Version pin on `source`: a tag, branch, or sha. Absence is what AGT004 flags. */
  ref?: string;
  /** SKILL.md body, when read. Becomes fountain's inline `{name, content}` skill form. */
  content?: string;
  /** The skill's own frontmatter `description`, used for the fountain `description`. */
  description?: string;
}

/** A subagent / custom agent definition (`.claude/agents/*.md`). */
export interface SubagentDecl {
  name: string;
  path: string;
  description?: string;
  /** Tool allowlist declared in frontmatter, if any. */
  tools?: string;
  model?: string;
}

/** A slash command definition (`.claude/commands/*.md`, `~/.codex/prompts`). */
export interface CommandDecl {
  name: string;
  path: string;
  description?: string;
}

/** An installed plugin — a bundle that can inject skills, commands, and MCP servers at once. */
export interface PluginDecl {
  name: string;
  /** Marketplace or repo the plugin was installed from. */
  marketplace?: string;
  /** Version pin, when the install recorded one. */
  ref?: string;
  enabled: boolean;
  /**
   * True when the plugin tracks a remote the user does not control.
   *
   * The pinning checks turn on this: a plugin vendored from a local directory
   * cannot change underneath the user, so "pin it" is not advice that applies.
   * Harnesses ship bundled plugins from local paths (codex's
   * `source_type = "local"`), and reporting those as unpinned supply chain is
   * noise that trains the reader to skip the rule.
   */
  remote: boolean;
}

/** Tool-permission configuration, normalized from a harness's own settings shape. */
export interface PermissionConfig {
  allow?: string[];
  deny?: string[];
  ask?: string[];
  defaultMode?: string;
  /** True when the config disables a confirmation prompt outright. */
  bypassesPrompts?: boolean;
}

/**
 * One complete agent configuration governing one root, for one runtime.
 *
 * Assembled from every file at that scope the harness would merge together —
 * see the module docstring for why the file is not the unit.
 */
export interface AgentConfigSite {
  /** Stable slug, unique within a scan: `user-claude`, `project-claude-chant`. Becomes the fountain resource name. */
  id: string;
  scope: AgentScope;
  runtime: AgentRuntime;
  /** Directory this configuration governs. For `user` scope, the home directory. */
  root: string;
  /** Every file that contributed, absolute. A site with no sources is never emitted. */
  sources: string[];
  instructions: InstructionFile[];
  mcpServers: McpServerDecl[];
  skills: SkillDecl[];
  subagents: SubagentDecl[];
  commands: CommandDecl[];
  plugins: PluginDecl[];
  /** Environment variables the harness injects into every session. */
  env: Record<string, string>;
  permissions?: PermissionConfig;
  /** Default model pinned by the config, when set. */
  model?: string;
  /**
   * Raw merged settings, kept so a check can interrogate a key this model
   * doesn't name without a schema change. Not used for codegen.
   */
  settings: Record<string, unknown>;
}

/** Everything one scan found, plus what it couldn't read. */
export interface AgentScanResult {
  sites: AgentConfigSite[];
  /** Locations probed and found absent — useful for "is it really not configured, or did I not look?" */
  probed: string[];
  /** Paths that existed but could not be read or parsed, with the reason. */
  unreadable: Array<{ path: string; reason: string }>;
  /**
   * Every MCP declaration each site saw, keyed by site id — including names
   * that lost the first-wins merge and so do not appear in
   * `AgentConfigSite.mcpServers`. Diagnostic data for the shadowing check
   * (AGT007), kept beside the sites rather than on them because it describes
   * the *discovery*, not the configuration being re-expressed.
   */
  declarations: Record<string, McpServerDecl[]>;
}

/** A finding raised by an agent-config check against a discovered site. */
export interface AgentFinding {
  /** Catalog id, e.g. `AGT001`. */
  checkId: string;
  severity: "error" | "warning" | "info";
  message: string;
  /** The specific file a reader has to open to fix this. */
  file: string;
  /** The site the finding belongs to. */
  siteId: string;
  scope: AgentScope;
  runtime: AgentRuntime;
  /** The named thing within the site (an MCP server name, a skill name). */
  entity?: string;
}
