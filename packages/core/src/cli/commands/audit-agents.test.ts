/**
 * The command's job is to keep `chant audit --agents` reading like a chant
 * audit report while auditing a different subject, and to be honest about the
 * edges of what it scanned.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import Ajv from "ajv";
import { auditAgentsCommand, toAuditFindings, siteSummary } from "./audit-agents";
import type { AgentConfigSite } from "../../agents/types";

let home: string;
let project: string;

function writeIn(root: string, rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf-8");
}

beforeEach(() => {
  home = join(tmpdir(), `chant-aa-home-${Math.random().toString(36).slice(2)}`);
  project = join(tmpdir(), `chant-aa-proj-${Math.random().toString(36).slice(2)}`);
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

const run = (opts: Parameters<typeof auditAgentsCommand>[0] = {}) =>
  auditAgentsCommand({ home, projectRoots: [project], platform: "linux", now: "2026-01-01T00:00:00Z", toolVersion: "1.2.3", ...opts });

/** A config with one unpinned MCP server — an AGT001 error. */
function seedUnpinned(): void {
  writeIn(home, ".claude/mcp.json", JSON.stringify({ mcpServers: { a: { command: "npx", args: ["-y", "floating-server"] } } }));
}

describe("toAuditFindings", () => {
  test("projects an agent finding onto the shared audit shape", () => {
    const [f] = toAuditFindings([
      { checkId: "AGT001", severity: "error", message: "m", file: "/f", siteId: "user-claude", scope: "user", runtime: "claude", entity: "srv" },
    ]);
    expect(f).toEqual({ checkId: "AGT001", severity: "error", message: "m", file: "/f", lexicon: "agents", entity: "user-claude › srv" });
  });

  test("falls back to the site id when a finding names no entity", () => {
    const [f] = toAuditFindings([
      { checkId: "AGT005", severity: "error", message: "m", file: "/f", siteId: "user-claude", scope: "user", runtime: "claude" },
    ]);
    expect(f.entity).toBe("user-claude");
  });
});

describe("siteSummary", () => {
  test("pluralizes and omits empty categories", () => {
    const base: AgentConfigSite = {
      id: "x", scope: "user", runtime: "claude", root: "/", sources: [],
      instructions: [{ path: "/a", content: "x", bytes: 1 }],
      mcpServers: [{ name: "a", transport: "stdio", source: "/c" }],
      skills: [], subagents: [], commands: [], plugins: [], env: {}, settings: {},
    };
    expect(siteSummary(base)).toBe("1 instruction file · 1 MCP server");
  });

  test("says so when a site carries nothing", () => {
    const empty: AgentConfigSite = {
      id: "x", scope: "user", runtime: "claude", root: "/", sources: [],
      instructions: [], mcpServers: [], skills: [], subagents: [], commands: [], plugins: [], env: {}, settings: {},
    };
    expect(siteSummary(empty)).toBe("no content");
  });
});

describe("stylish output", () => {
  test("leads with the inventory, so a clean machine still reports what is configured", () => {
    writeIn(home, "CLAUDE.md", "be brief");
    const result = run();
    expect(result.output).toContain("Found 1 agent config");
    expect(result.output).toContain("user:");
    expect(result.output).toContain("1 instruction file");
  });

  test("says plainly when nothing is configured", () => {
    expect(run().output).toContain("No agent configuration found.");
  });

  test("separates merge-worthy from report-only", () => {
    seedUnpinned();
    const output = run().output;
    expect(output).toContain("Merge-worthy:");
    expect(output).toContain("AGT001");
  });
});

describe("coverage notes", () => {
  test("reports registered projects it did not visit", () => {
    const a = join(project, "a");
    const b = join(project, "b");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    writeIn(home, ".claude.json", JSON.stringify({ projects: { [a]: {}, [b]: {} } }));
    writeIn(home, "CLAUDE.md", "x");
    expect(run().output).toContain("2 more are registered in ~/.claude.json");
  });

  test("does not count registrations whose directory is gone", () => {
    // A deleted project is not a gap the user can close, so counting it would
    // overstate what the scan missed.
    writeIn(home, ".claude.json", JSON.stringify({ projects: { "/definitely/not/here": {} } }));
    writeIn(home, "CLAUDE.md", "x");
    expect(run().output).not.toContain("registered in ~/.claude.json");
  });

  test("reports a file it could not parse", () => {
    writeIn(home, ".claude/settings.json", "{ broken");
    writeIn(home, "CLAUDE.md", "x");
    expect(run().output).toContain("could not be parsed");
  });

  test("names the scopes it was told to skip", () => {
    writeIn(home, "CLAUDE.md", "x");
    expect(run({ scopes: ["user"] }).output).toContain("Scopes not scanned: system, project");
  });

  test("points at --all-projects when projects were missed", () => {
    writeIn(home, ".claude.json", JSON.stringify({ projects: { [home]: {} } }));
    writeIn(home, "CLAUDE.md", "x");
    expect(run().output).toContain("--all-projects");
  });

  test("states the breadth when many roots were scanned and none were missed", () => {
    // With --all-projects there is no gap to report, but "5 findings" reads very
    // differently across one project than across sixty-five.
    const a = join(project, "a");
    const b = join(project, "b");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    writeIn(a, "CLAUDE.md", "x");
    const output = run({ projectRoots: [a, b] }).output;
    expect(output).toContain("Scanned 2 project roots");
    expect(output).not.toContain("--all-projects");
  });
});

describe("tier and fail-on", () => {
  test("--tier merge-worthy drops report-only findings", () => {
    seedUnpinned();
    const all = run({ tier: "all" }).findings.length;
    const mw = run({ tier: "merge-worthy" }).findings;
    expect(mw.length).toBeLessThan(all);
    expect(mw.every((f) => f.checkId !== "AGT006")).toBe(true);
  });

  test("exit code is 0 by default even with findings — the scan is read-only friendly", () => {
    seedUnpinned();
    expect(run().exitCode).toBe(0);
  });

  test("--fail-on merge-worthy exits 1 when a merge-worthy finding exists", () => {
    seedUnpinned();
    expect(run({ failOn: "merge-worthy" }).exitCode).toBe(1);
  });

  test("--fail-on merge-worthy exits 0 on a clean machine", () => {
    expect(run({ failOn: "merge-worthy" }).exitCode).toBe(0);
  });
});

describe("formats", () => {
  test("json carries the full inventory alongside the findings", () => {
    seedUnpinned();
    const report = JSON.parse(run({ format: "json" }).output);
    expect(report.subject).toBe("agent-configuration");
    expect(report.tool.version).toBe("1.2.3");
    expect(report.sites[0].id).toBe("user-claude");
    expect(report.sites[0].mcpServers[0].name).toBe("a");
    expect(report.coverage.probed.length).toBeGreaterThan(0);
  });

  test("json reports env var names, never their values", () => {
    writeIn(home, ".claude/settings.json", JSON.stringify({ env: { SECRET_THING: "hunter2" } }));
    const report = JSON.parse(run({ format: "json" }).output);
    expect(report.sites[0].env).toEqual(["SECRET_THING"]);
    expect(run({ format: "json" }).output).not.toContain("hunter2");
  });

  test("sarif is valid and links each rule to its docs anchor", () => {
    seedUnpinned();
    const sarif = JSON.parse(run({ format: "sarif" }).output);
    expect(sarif.version).toBe("2.1.0");
    const rule = sarif.runs[0].tool.driver.rules.find((r: { id: string }) => r.id === "AGT001");
    expect(rule.helpUri).toBe("https://intentius.io/chant/lint-rules/audit-rules/#agt001");
  });

  test("sarif carries the same tier/dimension property bag the repository audit emits (#442, #444)", () => {
    seedUnpinned();
    const sarif = JSON.parse(run({ format: "sarif" }).output) as {
      runs: Array<{
        tool: { driver: { rules: Array<{ id: string; help?: { text: string }; properties?: { category?: string; dimension?: string } }> } };
        results: Array<{ ruleId: string; properties?: { tier?: string } }>;
      }>;
    };
    const one = sarif.runs[0];
    expect(one.results.length).toBeGreaterThan(0);
    for (const r of one.results) expect(r.properties?.tier).toMatch(/^(merge-worthy|report-only)$/);
    expect(one.tool.driver.rules.length).toBeGreaterThan(0);
    for (const rule of one.tool.driver.rules) {
      expect(rule.properties?.category).toMatch(/^(security|correctness|best-practice|efficiency)$/);
      expect(rule.properties?.dimension).toBe(rule.properties?.category);
      expect(rule.help?.text.length).toBeGreaterThan(0);
    }
  });

  test("sarif validates against the real, vendored SARIF 2.1.0 JSON Schema", () => {
    seedUnpinned();
    const schemaPath = fileURLToPath(new URL("./__fixtures__/schemas/sarif-2.1.0.schema.json", import.meta.url));
    const ajv = new Ajv({ strict: false, allErrors: true });
    const validate = ajv.compile(JSON.parse(readFileSync(schemaPath, "utf-8")) as object);
    const valid = validate(JSON.parse(run({ format: "sarif" }).output));
    if (!valid) throw new Error(ajv.errorsText(validate.errors));
    expect(valid).toBe(true);
  });

  test("markdown and html render without throwing", () => {
    seedUnpinned();
    expect(run({ format: "markdown" }).output).toContain("# Agent configuration audit");
    expect(run({ format: "html" }).output).toContain("<html");
  });

  test("markdown is one document — the embedded findings report is a section, not a second H1", () => {
    seedUnpinned();
    const md = run({ format: "markdown" }).output;
    expect(md.split("\n").filter((l) => /^# /.test(l))).toEqual(["# Agent configuration audit"]);
    expect(md).toContain("## Inventory");
    expect(md).toContain("## Findings");
  });
});

describe("--output", () => {
  test("writes the report to a file instead of returning it for stdout", () => {
    writeIn(home, "CLAUDE.md", "x");
    const out = join(project, "report.md");
    const result = run({ format: "markdown", output: out });
    expect(result.wroteTo).toBe(out);
    expect(readFileSync(out, "utf-8")).toContain("Agent configuration audit");
  });

  test("reports a write failure instead of throwing", () => {
    const result = run({ output: join(project, "no", "such", "dir", "r.txt") });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Failed to write");
  });
});
