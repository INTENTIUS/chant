/**
 * Find every agent configuration on this machine and normalize it.
 *
 * The scan is location-driven, not walk-driven. Agent config does not hide in
 * arbitrary places: each harness publishes a small, fixed set of paths it
 * reads, so this module probes that list rather than crawling the filesystem.
 * That keeps a full three-scope scan to a few dozen `stat` calls, and — more
 * importantly — makes "we looked and it wasn't there" a fact the report can
 * state (`AgentScanResult.probed`) instead of an absence of evidence.
 *
 * Two shapes recur across harnesses and are handled once here:
 *
 *   - **A config is many files.** Claude Code merges `settings.json`,
 *     `settings.local.json`, `mcp.json`, and `~/.claude.json` into one
 *     effective configuration; codex puts the equivalent in one TOML file.
 *     Both land as a single {@link AgentConfigSite} with `sources` listing
 *     every file that contributed.
 *   - **MCP servers are declared in more than one place per scope.** Claude
 *     Code alone accepts them in `~/.claude/mcp.json`, `~/.claude.json`'s
 *     top-level `mcpServers`, and per-project entries under `~/.claude.json`'s
 *     `projects` map. `mergeMcp` collects all of them and keeps the *first*
 *     declaration of a name, matching the harness's own precedence.
 *
 * Nothing here judges what it finds — `checks.ts` owns that. Discovery's only
 * editorial act is dropping sites with no content at all, so an empty
 * `~/.gemini` directory doesn't become a resource.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { basename, join, resolve } from "path";
import { parseTOML } from "../toml";
import { parseYAML } from "../yaml";
import type {
  AgentConfigSite,
  AgentRuntime,
  AgentScanResult,
  AgentScope,
  CommandDecl,
  InstructionFile,
  McpServerDecl,
  McpTransport,
  PermissionConfig,
  PluginDecl,
  SkillDecl,
  SkillOrigin,
  SubagentDecl,
} from "./types";
import { AGENT_RUNTIMES, AGENT_SCOPES } from "./types";

/** Skip pathological files rather than pulling them into memory — mirrors the audit walk's cap. */
const MAX_FILE_BYTES = 4 * 1024 * 1024;
/** `~/.claude.json` legitimately reaches hundreds of KB (it holds per-project history), so it gets its own, larger cap. */
const MAX_STATE_FILE_BYTES = 32 * 1024 * 1024;
/** Bound the per-directory listing so a stray huge skills/ tree can't stall a scan. */
const MAX_DIR_ENTRIES = 500;

export interface ScanOptions {
  /** Scopes to probe. Defaults to all three. */
  scopes?: readonly AgentScope[];
  /** Harnesses to probe. Defaults to all five. */
  runtimes?: readonly AgentRuntime[];
  /** Home directory. Injectable so tests can scan a fixture tree instead of the real machine. */
  home?: string;
  /** Platform, which decides where system-scope policy lives. Injectable for the same reason. */
  platform?: NodeJS.Platform;
  /** Directories to treat as project scope. Defaults to `[process.cwd()]`. */
  projectRoots?: string[];
}

/**
 * Machine-wide policy locations, by platform. Claude Code is the only harness
 * of the five that defines a system scope today; the others are user-scoped
 * only, which is itself worth reporting.
 */
export function systemSettingsPaths(platform: NodeJS.Platform): string[] {
  if (platform === "darwin") return ["/Library/Application Support/ClaudeCode/managed-settings.json"];
  if (platform === "win32") return ["C:\\ProgramData\\ClaudeCode\\managed-settings.json"];
  return ["/etc/claude-code/managed-settings.json"];
}

// ── Reading primitives ───────────────────────────────────────────────
//
// Every read goes through the recorder so the scan can report what it probed
// and what it failed on. A parse failure is never fatal: a machine with one
// corrupt settings file should still get a report about the other twelve.

/** Accumulates the provenance a scan reports alongside its sites. */
class Recorder {
  readonly probed: string[] = [];
  readonly unreadable: Array<{ path: string; reason: string }> = [];
  /**
   * Per-site MCP declarations before first-wins merging, keyed by
   * {@link declKey} rather than site id.
   *
   * Site ids are not yet unique at discovery time — `uniquifySiteIds` runs
   * after every site is collected, because it needs to see the collisions.
   * Keying this by identity-from-the-start means a collision can't cause one
   * site's declarations to overwrite another's before the rename happens.
   */
  readonly declarations: Record<string, McpServerDecl[]> = {};
  /** Memo for files read once per scanned root — see {@link cachedJson}. */
  private readonly jsonCache = new Map<string, Record<string, unknown> | undefined>();

  /** Note that a path was looked for. Returns whether it exists. */
  probe(path: string): boolean {
    this.probed.push(path);
    return existsSync(path);
  }

  fail(path: string, err: unknown): void {
    this.unreadable.push({ path, reason: err instanceof Error ? err.message : String(err) });
  }

  text(path: string, maxBytes = MAX_FILE_BYTES): string | undefined {
    if (!this.probe(path)) return undefined;
    try {
      const size = statSync(path).size;
      if (size > maxBytes) {
        this.fail(path, `file is ${size} bytes, over the ${maxBytes}-byte scan cap`);
        return undefined;
      }
      return readFileSync(path, "utf-8");
    } catch (err) {
      this.fail(path, err);
      return undefined;
    }
  }

  json(path: string, maxBytes = MAX_FILE_BYTES): Record<string, unknown> | undefined {
    const raw = this.text(path, maxBytes);
    if (raw === undefined) return undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      return isRecord(parsed) ? parsed : undefined;
    } catch (err) {
      this.fail(path, err);
      return undefined;
    }
  }

  /**
   * `json`, memoized by path.
   *
   * For `~/.claude.json` specifically: it is read once per project root (it
   * holds the per-project MCP servers), it is routinely hundreds of KB, and
   * `--all-projects` scans dozens of roots in one pass. Re-parsing it per root
   * turned a fast scan into a slow one for no benefit — the file cannot change
   * mid-scan.
   */
  cachedJson(path: string, maxBytes = MAX_FILE_BYTES): Record<string, unknown> | undefined {
    if (this.jsonCache.has(path)) return this.jsonCache.get(path);
    const parsed = this.json(path, maxBytes);
    this.jsonCache.set(path, parsed);
    return parsed;
  }

  toml(path: string): Record<string, unknown> | undefined {
    const raw = this.text(path);
    if (raw === undefined) return undefined;
    try {
      const parsed: unknown = parseTOML(raw);
      return isRecord(parsed) ? parsed : undefined;
    } catch (err) {
      this.fail(path, err);
      return undefined;
    }
  }

  /** Subdirectory names under `dir`, or `[]` if it isn't a readable directory. */
  dirs(dir: string): string[] {
    if (!this.probe(dir)) return [];
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .slice(0, MAX_DIR_ENTRIES)
        .map((e) => e.name)
        .sort();
    } catch (err) {
      this.fail(dir, err);
      return [];
    }
  }

  /** Names of files under `dir` matching `ext`, or `[]`. */
  files(dir: string, ext: string): string[] {
    if (!this.probe(dir)) return [];
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(ext))
        .slice(0, MAX_DIR_ENTRIES)
        .map((e) => e.name)
        .sort();
    } catch (err) {
      this.fail(dir, err);
      return [];
    }
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asStringMap(v: unknown): Record<string, string> {
  if (!isRecord(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === "string") out[k] = val;
    else if (typeof val === "number" || typeof val === "boolean") out[k] = String(val);
  }
  return out;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string");
  return out.length > 0 ? out : undefined;
}

/** Parse a markdown file's `---` YAML frontmatter. Returns `{}` when there is none. */
export function frontmatter(markdown: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (!match) return {};
  try {
    const parsed = parseYAML(match[1]);
    return isRecord(parsed) ? parsed : {};
  } catch {
    // Malformed frontmatter just means we don't get a description — the skill
    // itself is still real and still gets reported.
    return {};
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

// ── MCP normalization ────────────────────────────────────────────────

/**
 * Normalize one harness's `mcpServers` / `mcp_servers` map.
 *
 * Both dialects agree on the substance — a name mapping to either a `command`
 * + `args` (stdio) or a `url` (http/sse) — so one normalizer serves Claude
 * Code's JSON and codex's TOML. Keys this model names are lifted out; whatever
 * remains is preserved in `extra` so a check can read a header or timeout
 * without this function having to know about it.
 */
export function normalizeMcpServers(raw: unknown, source: string): McpServerDecl[] {
  if (!isRecord(raw)) return [];
  const servers: McpServerDecl[] = [];
  for (const [name, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;
    const command = str(value.command);
    const url = str(value.url) ?? str(value.endpoint);
    const declared = str(value.type) ?? str(value.transport);

    let transport: McpTransport;
    if (declared === "sse") transport = "sse";
    else if (declared === "http" || declared === "streamable-http") transport = "http";
    else if (command) transport = "stdio";
    else if (url) transport = url.includes("/sse") ? "sse" : "http";
    else transport = "unknown";

    const extra: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (["command", "args", "url", "endpoint", "env", "type", "transport"].includes(k)) continue;
      extra[k] = v;
    }

    servers.push({
      name,
      transport,
      source,
      command,
      args: asStringArray(value.args),
      url,
      env: isRecord(value.env) ? asStringMap(value.env) : undefined,
      extra: Object.keys(extra).length > 0 ? extra : undefined,
    });
  }
  // Sorted by name so a site's server list is stable regardless of the order
  // the source file happened to declare them in. Generated chant code is diffed
  // between runs, so ordering that tracks file layout would produce churn.
  return servers.sort((a, b) => (a.name < b.name ? -1 : 1));
}

/**
 * Combine MCP declarations from several files, first-wins per name.
 *
 * First-wins matches how the harnesses resolve a duplicate: the
 * highest-precedence file is passed first by the callers below, and a
 * later-scanned file redeclaring the same server name does not override it.
 * The shadowed copy is not dropped silently — AGT007 reports it.
 */
function mergeMcp(...groups: McpServerDecl[][]): McpServerDecl[] {
  const byName = new Map<string, McpServerDecl>();
  for (const group of groups) {
    for (const server of group) {
      if (!byName.has(server.name)) byName.set(server.name, server);
    }
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** Every MCP declaration seen, including ones `mergeMcp` shadowed. Feeds the shadowing check. */
function allMcp(...groups: McpServerDecl[][]): McpServerDecl[] {
  return groups.flat();
}

// ── Shared readers ───────────────────────────────────────────────────

/**
 * Read a `skills/` tree laid out as `<dir>/<name>/SKILL.md` — the layout
 * Claude Code and codex both use.
 */
function readSkillTree(rec: Recorder, dir: string, origin: SkillOrigin): SkillDecl[] {
  const skills: SkillDecl[] = [];
  for (const name of rec.dirs(dir)) {
    const path = join(dir, name, "SKILL.md");
    const content = rec.text(path);
    if (content === undefined) continue;
    const fm = frontmatter(content);
    skills.push({
      name: str(fm.name) ?? name,
      origin,
      path,
      content,
      description: str(fm.description),
    });
  }
  return skills;
}

/** Read `<dir>/*.md` agent definitions. */
function readSubagents(rec: Recorder, dir: string): SubagentDecl[] {
  const agents: SubagentDecl[] = [];
  for (const file of rec.files(dir, ".md")) {
    const path = join(dir, file);
    const content = rec.text(path);
    if (content === undefined) continue;
    const fm = frontmatter(content);
    agents.push({
      name: str(fm.name) ?? basename(file, ".md"),
      path,
      description: str(fm.description),
      tools: str(fm.tools),
      model: str(fm.model),
    });
  }
  return agents;
}

/** Read `<dir>/*.md` slash-command definitions. */
function readCommands(rec: Recorder, dir: string): CommandDecl[] {
  const commands: CommandDecl[] = [];
  for (const file of rec.files(dir, ".md")) {
    const path = join(dir, file);
    const content = rec.text(path);
    if (content === undefined) continue;
    commands.push({
      name: basename(file, ".md"),
      path,
      description: str(frontmatter(content).description),
    });
  }
  return commands;
}

/** Read an instruction file if present. */
function readInstructions(rec: Recorder, ...paths: string[]): InstructionFile[] {
  const out: InstructionFile[] = [];
  for (const path of paths) {
    const content = rec.text(path);
    if (content === undefined || content.trim() === "") continue;
    out.push({ path, content, bytes: Buffer.byteLength(content, "utf-8") });
  }
  return out;
}

/** Normalize a settings `permissions` block. */
function readPermissions(settings: Record<string, unknown>): PermissionConfig | undefined {
  const raw = settings.permissions;
  const bypasses = settings.skipDangerousModePermissionPrompt === true || settings.bypassPermissions === true;
  if (!isRecord(raw)) return bypasses ? { bypassesPrompts: true } : undefined;
  return {
    allow: asStringArray(raw.allow),
    deny: asStringArray(raw.deny),
    ask: asStringArray(raw.ask),
    defaultMode: str(raw.defaultMode),
    bypassesPrompts: bypasses || undefined,
  };
}

/** Drop a site that would carry no information. */
function hasContent(site: AgentConfigSite): boolean {
  return (
    site.instructions.length > 0 ||
    site.mcpServers.length > 0 ||
    site.skills.length > 0 ||
    site.subagents.length > 0 ||
    site.commands.length > 0 ||
    site.plugins.length > 0 ||
    Object.keys(site.env).length > 0 ||
    site.permissions !== undefined ||
    site.model !== undefined
  );
}

/**
 * Stable identity for a site during discovery, independent of its (not yet
 * unique) id. Scope, runtime, and absolute root together identify exactly one
 * site by construction.
 */
function declKey(site: Pick<AgentConfigSite, "scope" | "runtime" | "root">): string {
  return `${site.scope}|${site.runtime}|${resolve(site.root)}`;
}

/** Slugify one path segment. */
function slugSegment(segment: string): string {
  return segment.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Slugify the last `depth` segments of a path into the project half of a site
 * id. Depth 1 is the directory name; deeper values disambiguate two projects
 * that share one (see {@link uniquifySiteIds}).
 */
function projectSlug(path: string, depth = 1): string {
  const segments = resolve(path).split(/[\\/]/).filter(Boolean);
  const slug = segments.slice(-depth).map(slugSegment).filter(Boolean).join("-");
  return slug || "root";
}

/** Slugify a directory name into the project half of a site id. */
function slug(path: string): string {
  return projectSlug(path, 1);
}

/**
 * Make every site id unique within a scan.
 *
 * Site ids are derived from the directory name, which is unique enough when
 * scanning one project and demonstrably not when scanning all of them — a
 * machine here had `dev/intentius/behold` and `dev/jhgaylor/behold`, plus two
 * `guild` checkouts. Left alone, those collide into one id, which silently
 * corrupts the per-site declaration lookup and emits duplicate `export const`
 * identifiers in generated TypeScript.
 *
 * Colliding ids are qualified with as many parent directory segments as it
 * takes (`...-intentius-behold` vs `...-jhgaylor-behold`), falling back to a
 * numeric suffix in the pathological case. Ids that were already unique are
 * left exactly as they were, so the common single-project output is unchanged.
 */
function uniquifySiteIds(sites: AgentConfigSite[]): void {
  const counts = new Map<string, number>();
  for (const site of sites) counts.set(site.id, (counts.get(site.id) ?? 0) + 1);
  if ([...counts.values()].every((n) => n === 1)) return;

  const taken = new Set(sites.filter((s) => counts.get(s.id) === 1).map((s) => s.id));

  for (const site of sites) {
    if (counts.get(site.id) === 1) continue;
    const prefix = `${site.scope}-${site.runtime}`;

    let chosen: string | undefined;
    for (let depth = 2; depth <= 6; depth++) {
      const candidate = `${prefix}-${projectSlug(site.root, depth)}`;
      if (!taken.has(candidate)) {
        chosen = candidate;
        break;
      }
    }
    if (chosen === undefined) {
      let n = 2;
      while (taken.has(`${site.id}-${n}`)) n++;
      chosen = `${site.id}-${n}`;
    }

    site.id = chosen;
    taken.add(chosen);
  }
}

// ── Per-harness discovery ────────────────────────────────────────────

/**
 * Claude Code — the richest surface of the five, and the only one with a
 * system scope.
 *
 * At user scope the effective config is spread over five files plus two
 * directory trees, and MCP servers can come from three of them; at project
 * scope the same shape repeats under `.claude/`, with the wrinkle that
 * `~/.claude.json`'s `projects` map holds per-project MCP servers that live in
 * the *home* directory while governing a *project* root. That last one is easy
 * to miss by hand, which is exactly why it's worth scanning for.
 */
function discoverClaude(rec: Recorder, scope: AgentScope, root: string, home: string, platform: NodeJS.Platform): AgentConfigSite | undefined {
  const id = scope === "project" ? `project-claude-${slug(root)}` : `${scope}-claude`;
  const sources: string[] = [];
  const track = <T>(path: string, value: T | undefined): T | undefined => {
    if (value !== undefined) sources.push(path);
    return value;
  };

  if (scope === "system") {
    // System scope is policy only: a managed-settings.json, no skills or memory.
    for (const path of systemSettingsPaths(platform)) {
      const settings = rec.json(path);
      if (settings === undefined) continue;
      sources.push(path);
      const site: AgentConfigSite = {
        id,
        scope,
        runtime: "claude",
        root: "/",
        sources,
        instructions: [],
        mcpServers: normalizeMcpServers(settings.mcpServers, path),
        skills: [],
        subagents: [],
        commands: [],
        plugins: [],
        env: asStringMap(settings.env),
        permissions: readPermissions(settings),
        model: str(settings.model),
        settings,
      };
      return hasContent(site) ? site : undefined;
    }
    return undefined;
  }

  const dir = scope === "user" ? join(root, ".claude") : join(root, ".claude");

  const settingsPath = join(dir, "settings.json");
  const localPath = join(dir, "settings.local.json");
  const mcpPath = scope === "user" ? join(dir, "mcp.json") : join(root, ".mcp.json");

  const settings = track(settingsPath, rec.json(settingsPath)) ?? {};
  const local = track(localPath, rec.json(localPath)) ?? {};
  const mcpFile = track(mcpPath, rec.json(mcpPath)) ?? {};

  // `~/.claude.json` is the harness's own state file. It carries a top-level
  // `mcpServers` at user scope, and a `projects` map whose entries hold
  // per-project `mcpServers` — config that governs a project root but is
  // stored in the home directory.
  const statePath = join(home, ".claude.json");
  const state = rec.cachedJson(statePath, MAX_STATE_FILE_BYTES) ?? {};
  let stateMcp: McpServerDecl[] = [];
  if (scope === "user") {
    stateMcp = normalizeMcpServers(state.mcpServers, statePath);
  } else {
    const projects = isRecord(state.projects) ? state.projects : {};
    const entry = projects[resolve(root)];
    if (isRecord(entry)) stateMcp = normalizeMcpServers(entry.mcpServers, statePath);
  }
  if (stateMcp.length > 0) sources.push(statePath);

  // settings.local.json wins over settings.json, which is why it merges second.
  const merged: Record<string, unknown> = { ...settings, ...local };

  const instructions =
    scope === "user"
      ? readInstructions(rec, join(root, "CLAUDE.md"), join(dir, "CLAUDE.md"))
      : readInstructions(rec, join(root, "CLAUDE.md"), join(root, "AGENTS.md"), join(dir, "CLAUDE.md"));
  sources.push(...instructions.map((i) => i.path));

  const skills = readSkillTree(rec, join(dir, "skills"), "local");
  const subagents = readSubagents(rec, join(dir, "agents"));
  const commands = readCommands(rec, join(dir, "commands"));

  const mcpFromFile = normalizeMcpServers(mcpFile.mcpServers, mcpPath);
  const mcpFromSettings = normalizeMcpServers(merged.mcpServers, settingsPath);

  const site: AgentConfigSite = {
    id,
    scope,
    runtime: "claude",
    root: resolve(root),
    sources: [...new Set(sources)],
    instructions,
    mcpServers: mergeMcp(mcpFromFile, mcpFromSettings, stateMcp),
    skills: [...skills, ...(scope === "user" ? readClaudePlugins(rec, dir, merged) : [])],
    subagents,
    commands,
    plugins: scope === "user" ? readClaudePluginRegistry(rec, dir, merged) : [],
    env: asStringMap(merged.env),
    permissions: readPermissions(merged),
    model: str(merged.model),
    settings: merged,
  };
  // Record every declaration (not just the merge winners) for AGT007.
  rec.declarations[declKey(site)] = allMcp(mcpFromFile, mcpFromSettings, stateMcp);
  return hasContent(site) ? site : undefined;
}

/** Skills that arrive via an installed plugin, which the user never wrote and may not have read. */
function readClaudePlugins(rec: Recorder, dir: string, settings: Record<string, unknown>): SkillDecl[] {
  const skills: SkillDecl[] = [];
  const marketplaces = rec.json(join(dir, "plugins", "known_marketplaces.json")) ?? {};
  for (const [name, entry] of Object.entries(marketplaces)) {
    if (!isRecord(entry)) continue;
    const location = str(entry.installLocation);
    if (!location) continue;
    for (const skill of readSkillTree(rec, join(location, "skills"), "marketplace")) {
      skills.push({ ...skill, source: marketplaceSource(entry) });
    }
  }
  void settings;
  return skills;
}

/** The installed-plugin registry, including which marketplace each came from and whether it is pinned. */
function readClaudePluginRegistry(rec: Recorder, dir: string, settings: Record<string, unknown>): PluginDecl[] {
  const plugins: PluginDecl[] = [];
  const enabled = isRecord(settings.enabledPlugins) ? settings.enabledPlugins : {};
  const installed = rec.json(join(dir, "plugins", "installed_plugins.json")) ?? {};
  const entries = isRecord(installed.plugins) ? installed.plugins : {};
  for (const [name, entry] of Object.entries(entries)) {
    plugins.push({
      name,
      marketplace: isRecord(entry) ? str(entry.marketplace) ?? marketplaceSource(entry) : undefined,
      ref: isRecord(entry) ? str(entry.version) ?? str(entry.ref) ?? str(entry.commit) : undefined,
      enabled: enabled[name] !== false,
      remote: isRecord(entry) ? !isLocalSource(entry) : true,
    });
  }

  // A known marketplace with no installed plugin is still a configured remote
  // the harness will fetch from, so it is worth reporting.
  const marketplaces = rec.json(join(dir, "plugins", "known_marketplaces.json")) ?? {};
  for (const [name, entry] of Object.entries(marketplaces)) {
    if (plugins.some((p) => p.name === name)) continue;
    if (!isRecord(entry)) continue;
    plugins.push({ name, marketplace: marketplaceSource(entry), ref: str(entry.ref), enabled: true, remote: !isLocalSource(entry) });
  }
  return plugins;
}

/** True when a marketplace/plugin entry points at a local directory rather than a remote the user doesn't control. */
function isLocalSource(entry: Record<string, unknown>): boolean {
  const source = isRecord(entry.source) ? entry.source : entry;
  const kind = str(source.source_type) ?? str(source.source) ?? str(source.type);
  if (kind === "local" || kind === "file" || kind === "directory") return true;
  // A bare absolute path with no repo/url is a vendored directory.
  const location = str(source.path) ?? str(source.source);
  return location !== undefined && location.startsWith("/") && !str(source.repo) && !str(source.url);
}

/** Render a marketplace `source` block (`{source: "github", repo: "owner/name"}`) as a source string. */
function marketplaceSource(entry: Record<string, unknown>): string | undefined {
  const source = isRecord(entry.source) ? entry.source : entry;
  const repo = str(source.repo);
  if (repo) return repo;
  return str(source.url) ?? str(source.source);
}

/**
 * Codex — one TOML file holds what Claude Code spreads across five, with
 * `[mcp_servers.<name>]` tables in place of a `mcpServers` object.
 */
function discoverCodex(rec: Recorder, scope: AgentScope, root: string): AgentConfigSite | undefined {
  if (scope === "system") return undefined;
  const id = scope === "project" ? `project-codex-${slug(root)}` : "user-codex";
  const dir = scope === "user" ? join(root, ".codex") : join(root, ".codex");
  const configPath = join(dir, "config.toml");
  const sources: string[] = [];

  const config = rec.toml(configPath);
  if (config !== undefined) sources.push(configPath);
  const settings = config ?? {};

  const instructions =
    scope === "user"
      ? readInstructions(rec, join(dir, "AGENTS.md"), join(root, "AGENTS.md"))
      : readInstructions(rec, join(root, "AGENTS.md"));
  sources.push(...instructions.map((i) => i.path));

  // `.rules` files are codex's standing-instruction dialect alongside AGENTS.md.
  for (const file of rec.files(join(dir, "rules"), ".rules")) {
    const path = join(dir, "rules", file);
    const content = rec.text(path);
    if (content === undefined || content.trim() === "") continue;
    instructions.push({ path, content, bytes: Buffer.byteLength(content, "utf-8") });
    sources.push(path);
  }

  const marketplaces = isRecord(settings.marketplaces) ? settings.marketplaces : {};
  const plugins: PluginDecl[] = Object.entries(marketplaces).map(([name, entry]) => ({
    name,
    marketplace: isRecord(entry) ? str(entry.source) : undefined,
    ref: isRecord(entry) ? str(entry.ref) : undefined,
    enabled: true,
    // codex records `source_type = "local"` for the marketplaces it bundles.
    remote: isRecord(entry) ? str(entry.source_type) !== "local" : true,
  }));

  const site: AgentConfigSite = {
    id,
    scope,
    runtime: "codex",
    root: resolve(root),
    sources: [...new Set(sources)],
    instructions,
    mcpServers: normalizeMcpServers(settings.mcp_servers ?? settings.mcpServers, configPath),
    skills: readSkillTree(rec, join(dir, "skills"), "local"),
    subagents: [],
    commands: readCommands(rec, join(dir, "prompts")),
    plugins,
    env: asStringMap(settings.env),
    permissions: undefined,
    model: str(settings.model),
    settings,
  };
  return hasContent(site) ? site : undefined;
}

/** Gemini CLI — GEMINI.md plus a settings.json that can carry `mcpServers`. */
function discoverGemini(rec: Recorder, scope: AgentScope, root: string): AgentConfigSite | undefined {
  if (scope === "system") return undefined;
  const id = scope === "project" ? `project-gemini-${slug(root)}` : "user-gemini";
  const dir = join(root, ".gemini");
  const settingsPath = join(dir, "settings.json");
  const sources: string[] = [];

  const settings = rec.json(settingsPath);
  if (settings !== undefined) sources.push(settingsPath);

  const instructions = readInstructions(rec, join(root, "GEMINI.md"), join(dir, "GEMINI.md"));
  sources.push(...instructions.map((i) => i.path));

  const site: AgentConfigSite = {
    id,
    scope,
    runtime: "gemini",
    root: resolve(root),
    sources: [...new Set(sources)],
    instructions,
    mcpServers: normalizeMcpServers(settings?.mcpServers, settingsPath),
    skills: [],
    subagents: [],
    commands: [],
    plugins: [],
    env: asStringMap(settings?.env),
    permissions: undefined,
    model: str(settings?.model),
    settings: settings ?? {},
  };
  return hasContent(site) ? site : undefined;
}

/** opencode — XDG-style config with an `mcp` block. */
function discoverOpencode(rec: Recorder, scope: AgentScope, root: string): AgentConfigSite | undefined {
  if (scope === "system") return undefined;
  const id = scope === "project" ? `project-opencode-${slug(root)}` : "user-opencode";
  const configPath = scope === "user" ? join(root, ".config", "opencode", "opencode.json") : join(root, "opencode.json");
  const sources: string[] = [];

  const settings = rec.json(configPath);
  if (settings !== undefined) sources.push(configPath);

  const instructions =
    scope === "user"
      ? readInstructions(rec, join(root, ".config", "opencode", "AGENTS.md"))
      : readInstructions(rec, join(root, "AGENTS.md"));
  sources.push(...instructions.map((i) => i.path));

  const site: AgentConfigSite = {
    id,
    scope,
    runtime: "opencode",
    root: resolve(root),
    sources: [...new Set(sources)],
    instructions,
    // opencode names the block `mcp`; the entry shape matches the others.
    mcpServers: normalizeMcpServers(settings?.mcp ?? settings?.mcpServers, configPath),
    skills: [],
    subagents: [],
    commands: [],
    plugins: [],
    env: asStringMap(settings?.env),
    permissions: undefined,
    model: str(settings?.model),
    settings: settings ?? {},
  };
  return hasContent(site) ? site : undefined;
}

/**
 * Cursor — `.cursorrules` / `.cursor/rules/*.mdc` for instructions plus
 * `mcp.json` for tool servers. Discovered and audited like the rest; it simply
 * has no fountain `runtime` value to re-express onto.
 */
function discoverCursor(rec: Recorder, scope: AgentScope, root: string): AgentConfigSite | undefined {
  if (scope === "system") return undefined;
  const id = scope === "project" ? `project-cursor-${slug(root)}` : "user-cursor";
  const dir = join(root, ".cursor");
  const mcpPath = join(dir, "mcp.json");
  const sources: string[] = [];

  const mcpFile = rec.json(mcpPath);
  if (mcpFile !== undefined) sources.push(mcpPath);

  const instructions = readInstructions(rec, join(root, ".cursorrules"));
  sources.push(...instructions.map((i) => i.path));

  // `.cursor/rules/*.mdc` is the newer, per-rule-file dialect.
  for (const file of rec.files(join(dir, "rules"), ".mdc")) {
    const path = join(dir, "rules", file);
    const content = rec.text(path);
    if (content === undefined || content.trim() === "") continue;
    instructions.push({ path, content, bytes: Buffer.byteLength(content, "utf-8") });
    sources.push(path);
  }

  const site: AgentConfigSite = {
    id,
    scope,
    runtime: "cursor",
    root: resolve(root),
    sources: [...new Set(sources)],
    instructions,
    mcpServers: normalizeMcpServers(mcpFile?.mcpServers, mcpPath),
    skills: [],
    subagents: [],
    commands: [],
    plugins: [],
    env: {},
    permissions: undefined,
    model: undefined,
    settings: mcpFile ?? {},
  };
  return hasContent(site) ? site : undefined;
}

// ── Entry point ──────────────────────────────────────────────────────

type Discoverer = (rec: Recorder, scope: AgentScope, root: string, home: string, platform: NodeJS.Platform) => AgentConfigSite | undefined;

const DISCOVERERS: Record<AgentRuntime, Discoverer> = {
  claude: discoverClaude,
  codex: (rec, scope, root) => discoverCodex(rec, scope, root),
  gemini: (rec, scope, root) => discoverGemini(rec, scope, root),
  opencode: (rec, scope, root) => discoverOpencode(rec, scope, root),
  cursor: (rec, scope, root) => discoverCursor(rec, scope, root),
};

/**
 * Scan the machine and return every agent configuration found.
 *
 * Sites are ordered system → user → project, matching the order the harnesses
 * merge them, so a reader scanning the report sees broad policy before the
 * narrow overrides that modify it.
 */
export function scanAgentConfigs(opts: ScanOptions = {}): AgentScanResult {
  const home = opts.home ?? homedir();
  const platform = opts.platform ?? process.platform;
  const scopes = opts.scopes ?? AGENT_SCOPES;
  const runtimes = opts.runtimes ?? AGENT_RUNTIMES;
  const projectRoots = opts.projectRoots ?? [process.cwd()];

  const rec = new Recorder();
  const sites: AgentConfigSite[] = [];

  for (const scope of AGENT_SCOPES) {
    if (!scopes.includes(scope)) continue;
    const roots = scope === "project" ? projectRoots : [scope === "system" ? "/" : home];
    for (const root of roots) {
      for (const runtime of AGENT_RUNTIMES) {
        if (!runtimes.includes(runtime)) continue;
        const site = DISCOVERERS[runtime](rec, scope, root, home, platform);
        if (site) sites.push(site);
      }
    }
  }

  // Ids must be unique before declarations are keyed by them — see
  // `uniquifySiteIds` for why a same-named directory in two parents collides.
  uniquifySiteIds(sites);

  const declarations: Record<string, McpServerDecl[]> = {};
  for (const site of sites) {
    const raw = rec.declarations[declKey(site)];
    if (raw) declarations[site.id] = raw;
  }

  return {
    sites,
    probed: [...new Set(rec.probed)].sort(),
    unreadable: rec.unreadable,
    declarations,
  };
}

/**
 * Every project root the harness has registered on this machine, from
 * `~/.claude.json`'s `projects` map.
 *
 * This is what makes `--all-projects` possible without crawling the disk: the
 * harness already keeps the list of every project it has been opened in.
 *
 * Roots whose directory no longer exists are dropped. A deleted project is not
 * something a user can act on, and counting it would make the "N projects not
 * scanned" note overstate the gap — on a machine with 77 registered projects,
 * 12 of them were stale.
 */
export function registeredProjectRoots(home: string): string[] {
  const statePath = join(home, ".claude.json");
  if (!existsSync(statePath)) return [];
  try {
    if (statSync(statePath).size > MAX_STATE_FILE_BYTES) return [];
    const state: unknown = JSON.parse(readFileSync(statePath, "utf-8"));
    if (!isRecord(state) || !isRecord(state.projects)) return [];
    return Object.keys(state.projects)
      .map((p) => resolve(p))
      .filter((p) => {
        try {
          return statSync(p).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

/**
 * Count registered project roots this scan did not visit. A user with dozens of
 * registered projects should be told that a cwd-scoped scan saw one of them,
 * rather than being left to assume it saw all.
 */
export function unscannedProjectCount(home: string, scannedRoots: string[]): number {
  const scanned = new Set(scannedRoots.map((r) => resolve(r)));
  return registeredProjectRoots(home).filter((p) => !scanned.has(p)).length;
}
