/**
 * Checks are tested from hand-built sites rather than a scan, so a case can be
 * stated in one object.
 *
 * Several of these encode false positives found by running the tool against a
 * real machine — a SHA256 pin read as a leaked credential, a vendored local
 * plugin read as an unpinned remote, twenty findings for one unpinned
 * marketplace. Those are the cases most likely to regress, because each fix
 * narrowed a heuristic that still has to fire on the real thing.
 */

import { describe, test, expect } from "vitest";
import { checkAgentConfigs } from "./checks";
import type { AgentConfigSite, AgentScanResult, McpServerDecl } from "./types";

function site(overrides: Partial<AgentConfigSite> = {}): AgentConfigSite {
  return {
    id: "user-claude",
    scope: "user",
    runtime: "claude",
    root: "/home/u",
    sources: ["/home/u/.claude/settings.json"],
    instructions: [],
    mcpServers: [],
    skills: [],
    subagents: [],
    commands: [],
    plugins: [],
    env: {},
    settings: {},
    ...overrides,
  };
}

function scanOf(s: AgentConfigSite, declarations: McpServerDecl[] = []): AgentScanResult {
  return { sites: [s], probed: [], unreadable: [], declarations: { [s.id]: declarations } };
}

const ids = (s: AgentConfigSite, decls: McpServerDecl[] = []) => checkAgentConfigs(scanOf(s, decls)).map((f) => f.checkId);

function server(overrides: Partial<McpServerDecl> = {}): McpServerDecl {
  return { name: "srv", transport: "stdio", source: "/home/u/.claude/mcp.json", ...overrides };
}

describe("AGT001 — unpinned MCP package", () => {
  test("fires on a package runner with a floating spec", () => {
    const s = site({ mcpServers: [server({ command: "npx", args: ["-y", "some-server"] })] });
    expect(ids(s)).toContain("AGT001");
  });

  test("reads the spec through --from, as uvx uses it", () => {
    const s = site({ mcpServers: [server({ command: "uvx", args: ["--from", "pkg-name", "entry"] })] });
    expect(ids(s)).toContain("AGT001");
  });

  test("does not fire when the spec is pinned to an exact version", () => {
    const s = site({ mcpServers: [server({ command: "npx", args: ["-y", "some-server@1.2.3"] })] });
    expect(ids(s)).not.toContain("AGT001");
  });

  test("does not fire for a plain local executable", () => {
    const s = site({ mcpServers: [server({ command: "/usr/local/bin/my-server" })] });
    expect(ids(s)).not.toContain("AGT001");
  });

  test("does not fire for a remote server, which runs no local code", () => {
    const s = site({ mcpServers: [server({ transport: "http", command: undefined, url: "https://x/mcp" })] });
    expect(ids(s)).not.toContain("AGT001");
  });
});

describe("AGT002 — literal credentials", () => {
  test("fires on a vendor-prefixed token in env", () => {
    const s = site({ mcpServers: [server({ env: { API_KEY: "sk-ant-abcdefghijklmnopqrstuvwxyz012345" } })] });
    expect(ids(s)).toContain("AGT002");
  });

  test("fires on a bearer token hidden in headers", () => {
    // Regression: `headers` arrives via `extra`, which the first version of the
    // check never walked — the exact place remote MCP servers keep credentials.
    const s = site({
      mcpServers: [server({ transport: "http", command: undefined, url: "https://x/mcp", extra: { headers: { Authorization: "Bearer rnd_wwMfAFG8Xxw0fD6unZ2S" } } })],
    });
    expect(ids(s)).toContain("AGT002");
  });

  test("does not fire on an env-var reference", () => {
    const s = site({ mcpServers: [server({ env: { API_KEY: "${API_KEY}" } })] });
    expect(ids(s)).not.toContain("AGT002");
  });

  test("does not fire on a SHA256 digest", () => {
    // Regression: a digest pins trusted code. It matches every "long opaque
    // string" heuristic and is the opposite of a leaked secret.
    const s = site({
      mcpServers: [server({ env: { NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S: "eb55d24cf065cd5311af6f99b16bade2b7a670790ff2db9accf60d012dd55dd1" } })],
    });
    expect(ids(s)).not.toContain("AGT002");
  });

  test("does not fire on a short config value under a secret-sounding key", () => {
    const s = site({ mcpServers: [server({ env: { TOKEN_ENABLED: "true" } })] });
    expect(ids(s)).not.toContain("AGT002");
  });
});

describe("AGT003 — cleartext MCP", () => {
  test("fires on a plain http:// endpoint", () => {
    const s = site({ mcpServers: [server({ transport: "http", command: undefined, url: "http://example.com/mcp" })] });
    expect(ids(s)).toContain("AGT003");
  });

  test("does not fire on loopback, which never crosses the network", () => {
    const s = site({ mcpServers: [server({ transport: "http", command: undefined, url: "http://localhost:3000/mcp" })] });
    expect(ids(s)).not.toContain("AGT003");
  });

  test("does not fire on https", () => {
    const s = site({ mcpServers: [server({ transport: "http", command: undefined, url: "https://example.com/mcp" })] });
    expect(ids(s)).not.toContain("AGT003");
  });
});

describe("AGT004 — unpinned remote skills and plugins", () => {
  test("reports one finding per source, not per skill", () => {
    // Regression: fifteen skills from one marketplace is one decision to
    // revisit; fifteen findings would bury every other rule.
    const s = site({
      skills: Array.from({ length: 15 }, (_, i) => ({ name: `s${i}`, origin: "marketplace" as const, source: "Q00/ouroboros", path: `/p/s${i}` })),
    });
    const findings = checkAgentConfigs(scanOf(s)).filter((f) => f.checkId === "AGT004");
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("15 skills");
  });

  test("does not fire on a pinned source", () => {
    const s = site({ skills: [{ name: "s", origin: "marketplace", source: "o/r", ref: "v1.0.0", path: "/p" }] });
    expect(ids(s)).not.toContain("AGT004");
  });

  test("does not fire on a local skill, which has no upstream to drift", () => {
    const s = site({ skills: [{ name: "s", origin: "local", path: "/p", content: "x" }] });
    expect(ids(s)).not.toContain("AGT004");
  });

  test("does not fire on a plugin vendored from a local directory", () => {
    // Regression: harnesses ship bundled plugins from local paths; "pin it"
    // is not advice that applies to a directory the user already controls.
    const s = site({ plugins: [{ name: "bundled", marketplace: "/opt/bundled", enabled: true, remote: false }] });
    expect(ids(s)).not.toContain("AGT004");
  });

  test("fires on an enabled remote plugin with no ref", () => {
    const s = site({ plugins: [{ name: "p", marketplace: "owner/repo", enabled: true, remote: true }] });
    expect(ids(s)).toContain("AGT004");
  });
});

describe("AGT005 — permissions", () => {
  test("fires when the dangerous-operation prompt is disabled", () => {
    const s = site({ permissions: { bypassesPrompts: true } });
    const finding = checkAgentConfigs(scanOf(s)).find((f) => f.checkId === "AGT005");
    expect(finding?.severity).toBe("error");
    expect(finding?.message).toContain("every project");
  });

  test("fires on a blanket tool grant", () => {
    const s = site({ permissions: { allow: ["Bash", "Bash(*)", "Read(:*)"] } });
    expect(checkAgentConfigs(scanOf(s)).filter((f) => f.checkId === "AGT005")).toHaveLength(3);
  });

  test("does not fire on a scoped grant", () => {
    const s = site({ permissions: { allow: ["Bash(git status:*)", "Bash(npm test:*)"] } });
    expect(ids(s)).not.toContain("AGT005");
  });
});

describe("AGT006 — user-scope blast radius", () => {
  test("fires for a user-scope config that carries content", () => {
    const s = site({ mcpServers: [server()] });
    expect(ids(s)).toContain("AGT006");
  });

  test("does not fire at project scope, where the radius is the project", () => {
    const s = site({ scope: "project", mcpServers: [server()] });
    expect(ids(s)).not.toContain("AGT006");
  });
});

describe("AGT007 — shadowed declarations", () => {
  test("fires when one server name is declared in two files, naming the winner", () => {
    const winner = server({ name: "dup", source: "/a.json" });
    const s = site({ mcpServers: [winner] });
    const finding = checkAgentConfigs(scanOf(s, [winner, server({ name: "dup", source: "/b.json" })])).find((f) => f.checkId === "AGT007");
    expect(finding?.message).toContain("/a.json");
    expect(finding?.message).toContain("/b.json");
  });

  test("does not fire when each server is declared once", () => {
    const only = server({ name: "solo" });
    expect(ids(site({ mcpServers: [only] }), [only])).not.toContain("AGT007");
  });
});

describe("AGT008 — instruction size", () => {
  test("fires past the attention budget", () => {
    const big = "x".repeat(40 * 1024);
    const s = site({ instructions: [{ path: "/home/u/CLAUDE.md", content: big, bytes: big.length }] });
    expect(ids(s)).toContain("AGT008");
  });

  test("does not fire on a normal instruction file", () => {
    const s = site({ instructions: [{ path: "/home/u/CLAUDE.md", content: "be brief", bytes: 8 }] });
    expect(ids(s)).not.toContain("AGT008");
  });
});

describe("ordering", () => {
  test("errors sort before warnings and infos", () => {
    const s = site({
      mcpServers: [server({ command: "npx", args: ["-y", "floating"] })],
      instructions: [{ path: "/p", content: "x".repeat(40 * 1024), bytes: 40 * 1024 }],
      plugins: [{ name: "p", marketplace: "o/r", enabled: true, remote: true }],
    });
    const severities = checkAgentConfigs(scanOf(s)).map((f) => f.severity);
    expect(severities).toEqual([...severities].sort((a, b) => ({ error: 0, warning: 1, info: 2 })[a] - ({ error: 0, warning: 1, info: 2 })[b]));
  });
});
