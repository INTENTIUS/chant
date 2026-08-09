/**
 * Checks over discovered agent configuration (the `AGT` rule family).
 *
 * The threat model these encode is specific, and worth stating because it is
 * not the same as the CI threat model the rest of `chant audit` covers.
 *
 * An agent config is *executable surface that runs with the user's own
 * credentials on the user's own machine, usually with no review step*. An MCP
 * server entry is a command line that runs at session start; a skill is
 * instructions the model will follow; a permission allowlist decides what runs
 * without anyone being asked. All three are commonly installed with one
 * command, are rarely re-read after the day they were added, and — for the
 * remote-sourced ones — can change upstream without any local edit.
 *
 * So the checks concentrate on three questions:
 *   1. **What executes, and is it pinned?** (AGT001, AGT004)
 *   2. **What can read secrets or reach the network in the clear?** (AGT002, AGT003)
 *   3. **What runs without asking, and over how many projects?** (AGT005, AGT006)
 * Plus AGT007, which flags config that is silently shadowed — where what the
 * user reads is not what the agent runs.
 *
 * Every check is read-only and pure over a scan result, so a caller can run
 * them against a fixture tree with no machine access.
 */

import type { AgentConfigSite, AgentFinding, AgentScanResult, McpServerDecl } from "./types";

/** Rule ids in this family, in report order. Kept in sync with `audit/catalog.ts` by a drift test. */
export const AGENT_RULE_IDS = [
  "AGT001",
  "AGT002",
  "AGT003",
  "AGT004",
  "AGT005",
  "AGT006",
  "AGT007",
  "AGT008",
] as const;

/**
 * Package runners that fetch and execute code from a registry at invocation
 * time. These are the commands where an unpinned spec means "whatever upstream
 * publishes next", evaluated every time the agent starts.
 */
const PACKAGE_RUNNERS = new Set(["npx", "pnpm dlx", "dlx", "bunx", "uvx", "pipx"]);

/** Spec forms that pin to an immutable release. Anything else floats. */
const PINNED_SPEC = /@\d+\.\d+\.\d+|@sha256:|==\d|@[0-9a-f]{40}$/;

/**
 * Value shapes that are credentials rather than references to credentials.
 * A config that stores `${GITHUB_TOKEN}` is fine; one that stores the token
 * itself puts a live secret in a file that syncs, backs up, and gets shared.
 */
const SECRET_KEY = /(?:^|_)(?:token|secret|password|passwd|api_?key|access_?key|credential|private_?key)s?(?:$|_)/i;
/** Indirection — an env-var reference or a command substitution — not a literal. */
const INDIRECT_VALUE = /^\s*(?:\$\{[^}]+\}|\$[A-Za-z_][A-Za-z0-9_]*|\$\(.+\))\s*$/;

/**
 * A key naming a *digest* rather than a credential.
 *
 * Digests are the case where the generic "long opaque string" heuristic gets it
 * exactly backwards: `NODE_REPL_TRUSTED_..._SHA256S` is a pin on trusted code —
 * publishing it costs nothing and removing it would weaken the config. Checked
 * before any value heuristic so a hash is never reported as a leaked secret.
 */
const DIGEST_KEY = /(?:sha\d*|checksum|digest|fingerprint|thumbprint|hash|etag)/i;

/**
 * Vendor-issued credential prefixes. These are unambiguous: no other kind of
 * value starts this way, so a match alone is enough to report.
 */
const VENDOR_CREDENTIAL = /^(?:sk-|sk-ant-|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xox[baprs]-|AKIA|ASIA|glpat-|glrt-|AIza|hf_|pplx-|dop_v1_|shpat_|npm_|rk_live_|pk_live_)/;

/**
 * Header names that carry a credential without naming one. `Authorization` is
 * the case that matters: it is where remote MCP servers keep their bearer
 * tokens, and it matches none of the "looks like a secret" key heuristics.
 */
const AUTH_KEY = /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|apikey|x-auth-token|auth)$/i;

/** An HTTP authorization value: a scheme followed by the credential itself. */
const AUTH_SCHEME_VALUE = /^\s*(?:Bearer|Basic|Token|ApiKey)\s+\S+/i;

/**
 * A long opaque value that is *not* a hex digest. Pure hex is excluded because
 * hashes, git shas, and content digests dominate that shape in agent config and
 * are not secrets; real credentials in this length range are base64/base62 and
 * mix in non-hex characters.
 */
function looksHighEntropy(value: string): boolean {
  if (value.length < 40) return false;
  if (!/^[A-Za-z0-9+/_-]{40,}={0,2}$/.test(value)) return false;
  if (/^[0-9a-f]+$/i.test(value)) return false; // a digest or sha, not a credential
  return true;
}

/**
 * Permission patterns that grant a whole tool with no argument constraint.
 * `Bash(git status:*)` is a scoped grant; `Bash` and `Bash(*)` are not.
 */
const BLANKET_PERMISSION = /^([A-Za-z]+)(?:\(\s*(?:\*|:\*)\s*\))?$/;

/** Instruction files past this size stop being reliably followed and start crowding the context window. */
const INSTRUCTION_SIZE_BUDGET = 32 * 1024;

function finding(
  site: AgentConfigSite,
  checkId: string,
  severity: AgentFinding["severity"],
  file: string,
  message: string,
  entity?: string,
): AgentFinding {
  return { checkId, severity, message, file, siteId: site.id, scope: site.scope, runtime: site.runtime, entity };
}

/** The argv a stdio MCP server actually runs, as one string. */
function commandLine(server: McpServerDecl): string {
  return [server.command ?? "", ...(server.args ?? [])].join(" ").trim();
}

/**
 * AGT001 — an MCP server executes an unpinned package from a registry.
 *
 * `npx -y some-server` resolves `latest` on every launch, so the code running
 * with the user's filesystem and credentials is whatever was published most
 * recently. This is the agent-config form of the unpinned-dependency problem
 * OSSF Scorecard tracks for CI, with a shorter path to the user's data.
 */
function checkUnpinnedMcp(site: AgentConfigSite): AgentFinding[] {
  const out: AgentFinding[] = [];
  for (const server of site.mcpServers) {
    if (server.transport !== "stdio" || !server.command) continue;
    const runner = server.command.split("/").pop() ?? server.command;
    if (!PACKAGE_RUNNERS.has(runner)) continue;

    // The package spec is the first argument that isn't a flag or a flag's value.
    const args = server.args ?? [];
    let spec: string | undefined;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--from" || arg === "-p" || arg === "--package" || arg === "--with") {
        spec = args[++i];
        break;
      }
      if (arg.startsWith("-")) continue;
      spec = arg;
      break;
    }
    if (spec === undefined) continue;
    if (PINNED_SPEC.test(spec)) continue;

    out.push(
      finding(
        site,
        "AGT001",
        "error",
        server.source,
        `MCP server "${server.name}" runs \`${commandLine(server)}\` — \`${spec}\` is unpinned, so a new upstream release executes on this machine with no review.`,
        server.name,
      ),
    );
  }
  return out;
}

/** AGT002 — a literal credential is stored in agent config rather than referenced. */
function checkLiteralSecrets(site: AgentConfigSite): AgentFinding[] {
  const out: AgentFinding[] = [];

  const inspect = (source: string, entity: string, key: string, value: string): void => {
    if (INDIRECT_VALUE.test(value)) return;
    // A digest is a pin, not a credential — and it matches every "long opaque
    // string" heuristic, so it has to be excluded before they run.
    if (DIGEST_KEY.test(key)) return;
    const looksSecretByKey = SECRET_KEY.test(key) || AUTH_KEY.test(key);
    const looksSecretByValue = AUTH_SCHEME_VALUE.test(value) || VENDOR_CREDENTIAL.test(value) || looksHighEntropy(value);
    if (!looksSecretByKey && !looksSecretByValue) return;
    // A key that names a secret but holds a short, obviously-non-secret value
    // (a boolean, a path) is configuration, not a credential.
    if (looksSecretByKey && !looksSecretByValue && value.length < 20) return;
    out.push(
      finding(
        site,
        "AGT002",
        "error",
        source,
        `\`${key}\` in "${entity}" holds a literal credential. Agent config files sync, back up, and get shared — reference the secret (\`\${${key}}\`) and keep the value in a secret store.`,
        entity,
      ),
    );
  };

  /** Walk a nested passthrough structure (`headers`, and whatever else a harness accepted). */
  const inspectDeep = (source: string, entity: string, key: string, value: unknown, depth = 0): void => {
    if (depth > 4) return;
    if (typeof value === "string") inspect(source, entity, key, value);
    else if (Array.isArray(value)) for (const v of value) inspectDeep(source, entity, key, v, depth + 1);
    else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) inspectDeep(source, entity, k, v, depth + 1);
    }
  };

  for (const server of site.mcpServers) {
    for (const [key, value] of Object.entries(server.env ?? {})) inspect(server.source, server.name, key, value);
    // Credentials hide in the fields this model doesn't name — `headers` above
    // all. Skipping them would clear a config whose bearer token is sitting in
    // plain text one key over from where we looked.
    for (const [key, value] of Object.entries(server.extra ?? {})) inspectDeep(server.source, server.name, key, value);
    // A credential passed as an argument is worse than one in `env`: it is also
    // visible to anyone who can list processes.
    for (const arg of server.args ?? []) {
      const match = /^--?([A-Za-z0-9_-]*(?:token|key|secret|password)[A-Za-z0-9_-]*)[=\s]+(.+)$/i.exec(arg);
      if (match) inspect(server.source, server.name, match[1], match[2]);
      else if (VENDOR_CREDENTIAL.test(arg) || looksHighEntropy(arg)) inspect(server.source, server.name, "argv", arg);
    }
  }

  const envSource = site.sources.find((s) => s.endsWith(".json") || s.endsWith(".toml")) ?? site.root;
  for (const [key, value] of Object.entries(site.env)) inspect(envSource, "session environment", key, value);

  return out;
}

/** AGT003 — a remote MCP server is reached over cleartext HTTP. */
function checkCleartextMcp(site: AgentConfigSite): AgentFinding[] {
  const out: AgentFinding[] = [];
  for (const server of site.mcpServers) {
    if (!server.url || !/^http:\/\//i.test(server.url)) continue;
    // Loopback is not exposed to the network, so it isn't the same risk.
    if (/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(server.url)) continue;
    out.push(
      finding(
        site,
        "AGT003",
        "error",
        server.source,
        `MCP server "${server.name}" is reached over cleartext at ${server.url}. Tool calls and their results — including anything the agent read from this machine — cross the network unencrypted.`,
        server.name,
      ),
    );
  }
  return out;
}

/**
 * AGT004 — a skill or plugin is installed from a remote source with no version pin.
 *
 * Grouped by *source*, not by skill. One unpinned marketplace supplying twenty
 * skills is one decision to revisit and one place to fix; twenty findings would
 * bury the other rules without telling the reader anything the first one didn't.
 */
function checkUnpinnedRemoteSkills(site: AgentConfigSite): AgentFinding[] {
  const out: AgentFinding[] = [];

  const bySource = new Map<string, typeof site.skills>();
  for (const skill of site.skills) {
    if (skill.origin === "local" || !skill.source || skill.ref) continue;
    const group = bySource.get(skill.source) ?? [];
    group.push(skill);
    bySource.set(skill.source, group);
  }
  for (const [source, skills] of bySource) {
    const names = skills.map((s) => s.name).sort();
    const shown = names.slice(0, 5).join(", ") + (names.length > 5 ? `, +${names.length - 5} more` : "");
    out.push(
      finding(
        site,
        "AGT004",
        "warning",
        skills[0].path ?? site.root,
        `${names.length} skill${names.length === 1 ? "" : "s"} come${names.length === 1 ? "s" : ""} from ${source} with no pinned ref, so their instructions can change upstream without any edit on this machine (${shown}).`,
        source,
      ),
    );
  }
  for (const plugin of site.plugins) {
    if (!plugin.enabled || !plugin.remote || !plugin.marketplace || plugin.ref) continue;
    out.push(
      finding(
        site,
        "AGT004",
        "warning",
        site.sources[0] ?? site.root,
        `Plugin "${plugin.name}" tracks ${plugin.marketplace} with no pinned ref. Plugins can add skills, commands, and MCP servers at once, so an upstream change installs all three.`,
        plugin.name,
      ),
    );
  }
  return out;
}

/** AGT005 — the config runs tools without asking. */
function checkBlanketPermissions(site: AgentConfigSite): AgentFinding[] {
  const out: AgentFinding[] = [];
  const perms = site.permissions;
  if (!perms) return out;
  const source = site.sources.find((s) => s.includes("settings")) ?? site.sources[0] ?? site.root;

  if (perms.bypassesPrompts) {
    out.push(
      finding(
        site,
        "AGT005",
        "error",
        source,
        `This config disables the confirmation prompt for dangerous operations${site.scope === "user" ? " for every project on this machine" : ""}.`,
      ),
    );
  }

  for (const entry of perms.allow ?? []) {
    const match = BLANKET_PERMISSION.exec(entry.trim());
    if (!match) continue;
    out.push(
      finding(
        site,
        "AGT005",
        "warning",
        source,
        `\`${entry}\` allows every invocation of ${match[1]} with no argument constraint. Scope it (\`${match[1]}(<specific command>:*)\`) so an unexpected call still surfaces.`,
        entry,
      ),
    );
  }

  return out;
}

/**
 * AGT006 — user-scope configuration applies to every project.
 *
 * Informational rather than a defect: a user-scope config is often exactly
 * what someone wants. It is reported because the blast radius is invisible at
 * the point of editing — nothing in `~/.claude/settings.json` says "this also
 * applies to the client repo you open next week".
 */
function checkUserScopeBlastRadius(site: AgentConfigSite): AgentFinding[] {
  if (site.scope !== "user") return [];
  const carried: string[] = [];
  if (site.mcpServers.length > 0) carried.push(`${site.mcpServers.length} MCP server${site.mcpServers.length === 1 ? "" : "s"}`);
  if (site.instructions.length > 0) carried.push(`${site.instructions.length} instruction file${site.instructions.length === 1 ? "" : "s"}`);
  if (site.skills.length > 0) carried.push(`${site.skills.length} skill${site.skills.length === 1 ? "" : "s"}`);
  if (carried.length === 0) return [];
  return [
    finding(
      site,
      "AGT006",
      "info",
      site.sources[0] ?? site.root,
      `User-scope ${site.runtime} config carries ${carried.join(", ")} into every project opened on this machine, including repos you don't own.`,
    ),
  ];
}

/**
 * AGT007 — an MCP server is declared in more than one file at the same scope.
 *
 * The harness silently takes one and ignores the rest, so the file a user opens
 * to check what a server does may not be the file that decides what it runs.
 */
function checkShadowedDeclarations(site: AgentConfigSite, declarations: McpServerDecl[]): AgentFinding[] {
  const bySource = new Map<string, Set<string>>();
  for (const decl of declarations) {
    if (!bySource.has(decl.name)) bySource.set(decl.name, new Set());
    bySource.get(decl.name)!.add(decl.source);
  }
  const out: AgentFinding[] = [];
  for (const [name, sources] of bySource) {
    if (sources.size < 2) continue;
    const winner = site.mcpServers.find((s) => s.name === name);
    if (!winner) continue;
    const losers = [...sources].filter((s) => s !== winner.source);
    out.push(
      finding(
        site,
        "AGT007",
        "warning",
        winner.source,
        `MCP server "${name}" is declared in ${sources.size} files; ${winner.source} wins and ${losers.join(", ")} ${losers.length === 1 ? "is" : "are"} ignored.`,
        name,
      ),
    );
  }
  return out;
}

/** AGT008 — an instruction file is large enough that the agent will not reliably follow all of it. */
function checkInstructionSize(site: AgentConfigSite): AgentFinding[] {
  return site.instructions
    .filter((file) => file.bytes > INSTRUCTION_SIZE_BUDGET)
    .map((file) =>
      finding(
        site,
        "AGT008",
        "info",
        file.path,
        `${(file.bytes / 1024).toFixed(0)} KB of standing instructions load into every session. Past roughly ${INSTRUCTION_SIZE_BUDGET / 1024} KB, later rules compete with earlier ones for attention — move the situational parts into skills that load on demand.`,
      ),
    );
}

/**
 * Run every agent-config check over a scan result.
 *
 * Findings are ordered by severity, then site, then rule — so the report leads
 * with what executes unreviewed rather than with instruction-file hygiene.
 */
export function checkAgentConfigs(scan: AgentScanResult): AgentFinding[] {
  const findings: AgentFinding[] = [];
  for (const site of scan.sites) {
    findings.push(
      ...checkUnpinnedMcp(site),
      ...checkLiteralSecrets(site),
      ...checkCleartextMcp(site),
      ...checkUnpinnedRemoteSkills(site),
      ...checkBlanketPermissions(site),
      ...checkUserScopeBlastRadius(site),
      ...checkShadowedDeclarations(site, scan.declarations[site.id] ?? []),
      ...checkInstructionSize(site),
    );
  }

  const rank = { error: 0, warning: 1, info: 2 } as const;
  return findings.sort(
    (a, b) => rank[a.severity] - rank[b.severity] || a.siteId.localeCompare(b.siteId) || a.checkId.localeCompare(b.checkId),
  );
}
