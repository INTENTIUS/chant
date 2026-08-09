/**
 * The mapper's contract is that generated code is safe to commit and faithful
 * to the config it came from — in that order.
 *
 * The redaction tests are the load-bearing ones. Running the importer against a
 * real machine produced `Authorization: "Bearer rnd_…"` in the output: a live
 * token written into a file whose whole point is to be checked into version
 * control. Every path that can carry a credential is covered here.
 */

import { describe, test, expect } from "vitest";
import { sitesToTemplateIR, derivedAllowedHosts, canonicalModel, buildSystem, toSkills, DEFAULT_MODEL } from "./local-agents";
import { FountainGenerator } from "./generator";
import type { AgentConfigSite } from "@intentius/chant/agents";

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

/** The generated `Agent` resource for a single-site conversion. */
function agentOf(s: AgentConfigSite) {
  const { ir } = sitesToTemplateIR([s]);
  const agent = ir.resources.find((r) => r.type === "Fountain::V1::Agent");
  if (!agent) throw new Error("no Agent resource generated");
  return agent;
}

describe("runtime mapping", () => {
  test("maps the four runtimes fountain accepts", () => {
    for (const runtime of ["claude", "codex", "gemini", "opencode"] as const) {
      const { ir, skipped } = sitesToTemplateIR([site({ id: `user-${runtime}`, runtime })]);
      expect(skipped).toEqual([]);
      expect(ir.resources[0].properties.runtime).toBe(runtime);
    }
  });

  test("skips cursor with a stated reason rather than mapping it onto another runtime", () => {
    const { ir, skipped } = sitesToTemplateIR([site({ id: "user-cursor", runtime: "cursor" })]);
    expect(ir.resources).toEqual([]);
    expect(skipped[0].siteId).toBe("user-cursor");
    expect(skipped[0].reason).toContain("cursor");
  });
});

describe("model canonicalization", () => {
  test("expands a harness alias to fountain's provider/model_id form", () => {
    expect(canonicalModel("opus", "claude")).toEqual({ model: "anthropic/claude-opus-4-6", defaulted: false });
  });

  test("passes an already-qualified model through untouched", () => {
    expect(canonicalModel("anthropic/claude-sonnet-4-6", "claude").model).toBe("anthropic/claude-sonnet-4-6");
  });

  test("defaults when the local config pins no model, and reports having done so", () => {
    const { unmappedModel } = sitesToTemplateIR([site()]);
    expect(unmappedModel).toEqual(["user-claude"]);
    expect(agentOf(site()).properties.model).toBe(DEFAULT_MODEL.claude);
  });
});

describe("secret redaction", () => {
  test("replaces a literal token in env with an env reference", () => {
    const s = site({ mcpServers: [{ name: "api", transport: "stdio", source: "/c", command: "x", env: { API_KEY: "sk-ant-abcdefghijklmnopqrstuvwxyz01" } }] });
    const servers = agentOf(s).properties.mcp_servers as Record<string, { env: Record<string, string> }>;
    expect(servers.api.env.API_KEY).toBe("${API_KEY}");
    expect(sitesToTemplateIR([s]).redactedSecrets).toEqual(["user-claude"]);
  });

  test("replaces a bearer token in headers, which arrive via `extra`", () => {
    // The regression that motivated this file: `extra` was copied verbatim, so
    // a live token landed in code destined for version control.
    const s = site({
      mcpServers: [{ name: "nebula", transport: "http", source: "/c", url: "https://n/mcp", extra: { headers: { Authorization: "Bearer nbla_xbIEER2743B8Csrs" } } }],
    });
    const servers = agentOf(s).properties.mcp_servers as Record<string, { headers: Record<string, string> }>;
    expect(servers.nebula.headers.Authorization).toBe("${NEBULA_AUTH_TOKEN}");
  });

  test("namespaces a redacted header by server, so two servers don't collide", () => {
    const s = site({
      mcpServers: [
        { name: "render", transport: "http", source: "/c", url: "https://r/mcp", extra: { headers: { Authorization: "Bearer rnd_aaaaaaaaaaaaaaaaa" } } },
        { name: "xhawk", transport: "http", source: "/c", url: "https://x/mcp", extra: { headers: { Authorization: "Bearer xhk_bbbbbbbbbbbbbbbbb" } } },
      ],
    });
    const servers = agentOf(s).properties.mcp_servers as Record<string, { headers: Record<string, string> }>;
    expect(servers.render.headers.Authorization).toBe("${RENDER_AUTH_TOKEN}");
    expect(servers.xhawk.headers.Authorization).toBe("${XHAWK_AUTH_TOKEN}");
  });

  test("does not double-prefix a key that already names its server", () => {
    const s = site({
      mcpServers: [{ name: "cleanjobdata", transport: "stdio", source: "/c", command: "x", env: { CLEANJOBDATA_API_KEY: "0123456789abcdefghijklmnopqrstuvwxyz" } }],
    });
    const servers = agentOf(s).properties.mcp_servers as Record<string, { env: Record<string, string> }>;
    expect(servers.cleanjobdata.env.CLEANJOBDATA_API_KEY).toBe("${CLEANJOBDATA_API_KEY}");
  });

  test("leaves non-secret configuration alone", () => {
    const s = site({ mcpServers: [{ name: "api", transport: "stdio", source: "/c", command: "x", env: { LOG_LEVEL: "debug" } }] });
    const servers = agentOf(s).properties.mcp_servers as Record<string, { env: Record<string, string> }>;
    expect(servers.api.env.LOG_LEVEL).toBe("debug");
    expect(sitesToTemplateIR([s]).redactedSecrets).toEqual([]);
  });

  test("no generated output contains a value that looked like a credential", () => {
    const s = site({
      env: { GLOBAL_TOKEN: "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      mcpServers: [{ name: "a", transport: "http", source: "/c", url: "https://a/mcp", extra: { headers: { Authorization: "Bearer secret-value-here-000" } } }],
    });
    const [file] = new FountainGenerator().generate(sitesToTemplateIR([s]).ir);
    expect(file.content).not.toContain("ghp_");
    expect(file.content).not.toContain("secret-value-here");
  });
});

describe("environment derivation", () => {
  test("derives the egress allowlist from the config's own remote MCP hosts", () => {
    expect(
      derivedAllowedHosts([
        { name: "a", transport: "http", source: "/c", url: "https://mcp.posthog.com/mcp" },
        { name: "b", transport: "http", source: "/c", url: "https://mcp.render.com/mcp" },
        { name: "c", transport: "stdio", source: "/c", command: "local" },
      ]),
    ).toEqual(["mcp.posthog.com", "mcp.render.com"]);
  });

  test("emits an Environment with explicit limited networking (FTN010)", () => {
    const s = site({ mcpServers: [{ name: "a", transport: "http", source: "/c", url: "https://x.dev/mcp" }] });
    const { ir } = sitesToTemplateIR([s]);
    const env = ir.resources.find((r) => r.type === "Fountain::V1::Environment");
    expect(env?.properties.networking_type).toBe("limited");
    expect(env?.properties.networking_config).toEqual({ allowed_hosts: ["x.dev"] });
  });

  test("omits the Environment when there is nothing environmental to declare", () => {
    const { ir } = sitesToTemplateIR([site()]);
    expect(ir.resources.filter((r) => r.type === "Fountain::V1::Environment")).toEqual([]);
    expect(ir.resources[0].properties.environment).toBeUndefined();
  });

  test("links the Agent to its Environment by reference, not by copy", () => {
    const s = site({ env: { A: "1" } });
    const [file] = new FountainGenerator().generate(sitesToTemplateIR([s]).ir);
    // A typed ref renders as the variable name the Environment was declared under.
    expect(file.content).toContain("environment: userClaudeEnv");
  });
});

describe("system prompt", () => {
  test("uses the single instruction file verbatim", () => {
    expect(buildSystem(site({ instructions: [{ path: "/a", content: "be brief\n", bytes: 9 }] }))).toBe("be brief");
  });

  test("keeps per-file provenance when several files merge", () => {
    const system = buildSystem(
      site({ instructions: [{ path: "/a", content: "one", bytes: 3 }, { path: "/b", content: "two", bytes: 3 }] }),
    );
    expect(system).toContain("# /a");
    expect(system).toContain("# /b");
  });

  test("is undefined when there are no instructions", () => {
    expect(buildSystem(site())).toBeUndefined();
  });
});

describe("skills", () => {
  test("inlines a local skill's content, the only form that reproduces it elsewhere", () => {
    expect(toSkills([{ name: "s", origin: "local", path: "/p", content: "do the thing" }])).toEqual([
      { name: "s", content: "do the thing" },
    ]);
  });

  test("keeps a remote skill as a source, with its ref when pinned", () => {
    expect(toSkills([{ name: "s", origin: "marketplace", source: "o/r", ref: "v1" }])).toEqual([
      { source: "o/r", name: "s", ref: "v1" },
    ]);
  });

  test("drops a skill with neither content nor source rather than emitting one fountain would reject", () => {
    expect(toSkills([{ name: "s", origin: "local" }])).toBeUndefined();
  });
});

describe("end-to-end", () => {
  test("generates compilable-shaped chant code with the ownership marker", () => {
    const s = site({
      model: "opus",
      instructions: [{ path: "/home/u/CLAUDE.md", content: "be brief", bytes: 8 }],
      mcpServers: [{ name: "posthog", transport: "http", source: "/c", url: "https://mcp.posthog.com/mcp" }],
      skills: [{ name: "deploy", origin: "local", path: "/p", content: "steps" }],
    });
    const [file] = new FountainGenerator().generate(sitesToTemplateIR([s]).ir);
    expect(file.path).toBe("main.ts");
    expect(file.content).toContain('import { Agent, Environment } from "@intentius/chant-lexicon-fountain";');
    expect(file.content).toContain("export const userClaude = new Agent({");
    expect(file.content).toContain('"managed-by": "chant"');
    expect(file.content).toContain('runtime: "claude"');
  });
});
