/**
 * Discovery is tested against a fixture home directory, never the real machine.
 *
 * That is not only for determinism: a test that read `~/.claude` would pass or
 * fail based on the developer's own config, and would quietly stop covering the
 * multi-file merge the moment someone deleted a settings file.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { scanAgentConfigs, normalizeMcpServers, frontmatter, systemSettingsPaths, unscannedProjectCount, registeredProjectRoots } from "./discover";

let home: string;
let project: string;

function write(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

function writeIn(root: string, rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf-8");
}

beforeEach(() => {
  home = join(tmpdir(), `chant-agents-home-${Math.random().toString(36).slice(2)}`);
  project = join(tmpdir(), `chant-agents-proj-${Math.random().toString(36).slice(2)}`);
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

/** Scan the fixture tree only — `platform` pins the system path off the real machine's. */
function scan(opts: Parameters<typeof scanAgentConfigs>[0] = {}) {
  return scanAgentConfigs({ home, projectRoots: [project], platform: "linux", ...opts });
}

describe("normalizeMcpServers", () => {
  test("classifies stdio, http, and sse from the declaration's shape", () => {
    const servers = normalizeMcpServers(
      {
        local: { command: "node", args: ["server.js"] },
        remote: { url: "https://example.com/mcp" },
        streamed: { url: "https://example.com/sse" },
        declared: { url: "https://example.com/x", type: "sse" },
      },
      "/cfg.json",
    );
    // Sorted by name, not declaration order — see the sort in normalizeMcpServers.
    expect(servers.map((s) => [s.name, s.transport])).toEqual([
      ["declared", "sse"],
      ["local", "stdio"],
      ["remote", "http"],
      ["streamed", "sse"],
    ]);
  });

  test("keeps unmodeled keys in `extra` rather than dropping them", () => {
    const [server] = normalizeMcpServers({ api: { url: "https://x/mcp", headers: { Authorization: "Bearer t" } } }, "/cfg.json");
    // `headers` is where remote servers keep credentials — losing it here would
    // blind both the secret check and the importer's redaction.
    expect(server.extra).toEqual({ headers: { Authorization: "Bearer t" } });
  });

  test("a non-object declaration is skipped, not crashed on", () => {
    expect(normalizeMcpServers({ bad: "nope", good: { command: "x" } }, "/c")).toHaveLength(1);
  });
});

describe("frontmatter", () => {
  test("parses YAML frontmatter", () => {
    expect(frontmatter("---\nname: x\ndescription: y\n---\n\nbody")).toEqual({ name: "x", description: "y" });
  });

  test("returns {} for a file without frontmatter, and for malformed frontmatter", () => {
    expect(frontmatter("# just a heading")).toEqual({});
    expect(frontmatter("---\n: : :\n---\n")).toEqual({});
  });
});

describe("systemSettingsPaths", () => {
  test("is platform-specific", () => {
    expect(systemSettingsPaths("darwin")[0]).toContain("/Library/Application Support");
    expect(systemSettingsPaths("linux")[0]).toBe("/etc/claude-code/managed-settings.json");
    expect(systemSettingsPaths("win32")[0]).toContain("ProgramData");
  });
});

describe("scanAgentConfigs — claude user scope", () => {
  test("merges settings, settings.local, mcp.json, and ~/.claude.json into one site", () => {
    writeIn(home, "CLAUDE.md", "be brief");
    writeIn(home, ".claude/settings.json", JSON.stringify({ model: "opus", env: { A: "1" } }));
    writeIn(home, ".claude/settings.local.json", JSON.stringify({ model: "sonnet" }));
    writeIn(home, ".claude/mcp.json", JSON.stringify({ mcpServers: { a: { command: "x" } } }));
    writeIn(home, ".claude.json", JSON.stringify({ mcpServers: { b: { url: "https://b/mcp" } } }));

    const { sites } = scan({ scopes: ["user"], runtimes: ["claude"] });
    expect(sites).toHaveLength(1);
    const site = sites[0];
    expect(site.id).toBe("user-claude");
    // settings.local.json is merged last, so it wins.
    expect(site.model).toBe("sonnet");
    expect(site.env).toEqual({ A: "1" });
    expect(site.mcpServers.map((s) => s.name)).toEqual(["a", "b"]);
    expect(site.instructions.map((i) => i.content)).toEqual(["be brief"]);
    expect(site.sources.length).toBeGreaterThanOrEqual(4);
  });

  test("reads the skills tree, preferring the frontmatter name", () => {
    writeIn(home, ".claude/skills/deploy/SKILL.md", "---\nname: deployer\ndescription: ships it\n---\n\nsteps");
    const [site] = scan({ scopes: ["user"], runtimes: ["claude"] }).sites;
    expect(site.skills).toEqual([
      expect.objectContaining({ name: "deployer", origin: "local", description: "ships it" }),
    ]);
    // The body is captured because inline skills are re-expressed by content.
    expect(site.skills[0].content).toContain("steps");
  });

  test("records every MCP declaration, including ones the first-wins merge shadowed", () => {
    writeIn(home, ".claude/mcp.json", JSON.stringify({ mcpServers: { dup: { command: "winner" } } }));
    writeIn(home, ".claude.json", JSON.stringify({ mcpServers: { dup: { command: "loser" } } }));

    const result = scan({ scopes: ["user"], runtimes: ["claude"] });
    const site = result.sites[0];
    expect(site.mcpServers).toHaveLength(1);
    expect(site.mcpServers[0].command).toBe("winner");
    // Both declarations survive in `declarations` so AGT007 can report the shadowing.
    expect(result.declarations["user-claude"]).toHaveLength(2);
  });

  test("a config with nothing in it produces no site", () => {
    expect(scan({ scopes: ["user"], runtimes: ["claude"] }).sites).toHaveLength(0);
  });
});

describe("scanAgentConfigs — project scope", () => {
  test("reads .mcp.json and CLAUDE.md from the project root", () => {
    writeIn(project, "CLAUDE.md", "project rules");
    writeIn(project, ".mcp.json", JSON.stringify({ mcpServers: { p: { command: "x" } } }));

    const [site] = scan({ scopes: ["project"], runtimes: ["claude"] }).sites;
    expect(site.scope).toBe("project");
    expect(site.id).toMatch(/^project-claude-/);
    expect(site.mcpServers.map((s) => s.name)).toEqual(["p"]);
  });

  test("picks up per-project MCP servers stored in the home directory's ~/.claude.json", () => {
    // The easy-to-miss case: config that governs a project but lives in $HOME.
    writeIn(home, ".claude.json", JSON.stringify({ projects: { [project]: { mcpServers: { hidden: { command: "x" } } } } }));

    const [site] = scan({ scopes: ["project"], runtimes: ["claude"] }).sites;
    expect(site.mcpServers.map((s) => s.name)).toEqual(["hidden"]);
    expect(site.sources).toContain(join(home, ".claude.json"));
  });
});

describe("scanAgentConfigs — system scope", () => {
  test("finds nothing when no managed policy is installed", () => {
    expect(scan({ scopes: ["system"] }).sites).toHaveLength(0);
  });
});

describe("scanAgentConfigs — codex", () => {
  test("reads mcp_servers tables, model, and .rules files from config.toml", () => {
    writeIn(
      home,
      ".codex/config.toml",
      [
        'model = "gpt-5.5"',
        "",
        "[mcp_servers.remote]",
        'url = "https://mcp.example.com/mcp"',
        "",
        "[mcp_servers.local]",
        'command = "run-me"',
        "",
        "[mcp_servers.local.env]",
        'TOKEN = "abc"',
        "",
        "[marketplaces.bundled]",
        'source_type = "local"',
        'source = "/opt/bundled"',
      ].join("\n"),
    );
    writeIn(home, ".codex/rules/default.rules", "always test");

    const [site] = scan({ scopes: ["user"], runtimes: ["codex"] }).sites;
    expect(site.runtime).toBe("codex");
    expect(site.model).toBe("gpt-5.5");
    expect(site.mcpServers.map((s) => s.name)).toEqual(["local", "remote"]);
    expect(site.mcpServers.find((s) => s.name === "local")?.env).toEqual({ TOKEN: "abc" });
    expect(site.instructions.some((i) => i.content === "always test")).toBe(true);
    // A bundled local directory is not a remote that can drift upstream.
    expect(site.plugins).toEqual([expect.objectContaining({ name: "bundled", remote: false })]);
  });
});

describe("scanAgentConfigs — resilience", () => {
  test("an unparseable file is reported, and the rest of the scan still runs", () => {
    writeIn(home, ".claude/settings.json", "{ not json");
    writeIn(home, ".claude/mcp.json", JSON.stringify({ mcpServers: { ok: { command: "x" } } }));

    const result = scan({ scopes: ["user"], runtimes: ["claude"] });
    expect(result.unreadable.map((u) => u.path)).toContain(join(home, ".claude/settings.json"));
    expect(result.sites[0].mcpServers.map((s) => s.name)).toEqual(["ok"]);
  });

  test("probed locations are recorded so the report can say what it looked for", () => {
    const result = scan({ scopes: ["user"], runtimes: ["claude"] });
    expect(result.probed).toContain(join(home, ".claude", "settings.json"));
  });
});

describe("scanAgentConfigs — ordering", () => {
  test("sites come back system → user → project, matching how harnesses merge them", () => {
    writeIn(home, "CLAUDE.md", "user");
    writeIn(project, "CLAUDE.md", "project");
    const scopes = scan({ runtimes: ["claude"] }).sites.map((s) => s.scope);
    expect(scopes).toEqual(["user", "project"]);
  });
});

describe("registeredProjectRoots", () => {
  test("returns registered project directories, sorted", () => {
    const a = join(project, "a");
    const b = join(project, "b");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    writeIn(home, ".claude.json", JSON.stringify({ projects: { [b]: {}, [a]: {} } }));
    expect(registeredProjectRoots(home)).toEqual([a, b]);
  });

  test("drops registrations whose directory no longer exists", () => {
    // A deleted project isn't something the user can act on, and counting it
    // would make the "N not scanned" note overstate the gap.
    writeIn(home, ".claude.json", JSON.stringify({ projects: { [project]: {}, "/definitely/not/here": {} } }));
    expect(registeredProjectRoots(home)).toEqual([project]);
  });

  test("is empty when there is no state file", () => {
    expect(registeredProjectRoots(home)).toEqual([]);
  });
});

describe("unscannedProjectCount", () => {
  test("counts registered projects the scan did not visit", () => {
    const a = join(project, "a");
    const b = join(project, "b");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    writeIn(home, ".claude.json", JSON.stringify({ projects: { [a]: {}, [b]: {}, [project]: {} } }));
    expect(unscannedProjectCount(home, [project])).toBe(2);
  });

  test("is zero once every registered project has been scanned", () => {
    writeIn(home, ".claude.json", JSON.stringify({ projects: { [project]: {} } }));
    expect(unscannedProjectCount(home, [project])).toBe(0);
  });

  test("is zero when there is no state file", () => {
    expect(unscannedProjectCount(home, [])).toBe(0);
  });
});

describe("site id uniqueness across many project roots", () => {
  /** Two projects that share a directory name under different parents. */
  function twoBeholds() {
    const one = join(project, "intentius", "behold");
    const two = join(project, "jhgaylor", "behold");
    mkdirSync(one, { recursive: true });
    mkdirSync(two, { recursive: true });
    writeIn(one, "CLAUDE.md", "one");
    writeIn(two, "CLAUDE.md", "two");
    return { one, two };
  }

  test("qualifies colliding ids with parent directory segments", () => {
    // Regression: `--all-projects` on a real machine hit this with two `behold`
    // and two `guild` checkouts. Colliding ids emit duplicate `export const`
    // identifiers in generated TypeScript.
    const { one, two } = twoBeholds();
    const { sites } = scanAgentConfigs({ home, projectRoots: [one, two], platform: "linux", scopes: ["project"], runtimes: ["claude"] });
    expect(sites.map((s) => s.id).sort()).toEqual(["project-claude-intentius-behold", "project-claude-jhgaylor-behold"]);
  });

  test("leaves already-unique ids untouched", () => {
    writeIn(project, "CLAUDE.md", "x");
    const { sites } = scanAgentConfigs({ home, projectRoots: [project], platform: "linux", scopes: ["project"], runtimes: ["claude"] });
    expect(sites[0].id).toBe(`project-claude-${project.split("/").pop()!.toLowerCase()}`);
  });

  test("declarations follow the renamed site rather than clobbering each other", () => {
    const { one, two } = twoBeholds();
    writeIn(one, ".mcp.json", JSON.stringify({ mcpServers: { only_in_one: { command: "a" } } }));
    writeIn(two, ".mcp.json", JSON.stringify({ mcpServers: { only_in_two: { command: "b" } } }));

    const result = scanAgentConfigs({ home, projectRoots: [one, two], platform: "linux", scopes: ["project"], runtimes: ["claude"] });
    const names = (id: string) => (result.declarations[id] ?? []).map((d) => d.name);
    expect(names("project-claude-intentius-behold")).toEqual(["only_in_one"]);
    expect(names("project-claude-jhgaylor-behold")).toEqual(["only_in_two"]);
  });
});
