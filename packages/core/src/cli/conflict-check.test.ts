import { describe, test, expect } from "bun:test";
import { checkConflicts } from "./conflict-check";
import type { LexiconPlugin } from "../lexicon";

const mockSerializer = { name: "test", serialize: () => ({}) } as any;

const noopAsync = async () => {};

function makePlugin(
  name: string,
  opts: {
    rules?: { id: string }[];
    skills?: { name: string }[];
    mcpTools?: { name: string }[];
    mcpResources?: { uri: string }[];
  } = {},
): LexiconPlugin {
  const plugin: LexiconPlugin = {
    name,
    serializer: { ...mockSerializer, name },
    generate: noopAsync,
    validate: noopAsync,
    coverage: noopAsync,
    package: noopAsync,
    rollback: noopAsync,
  };

  if (opts.rules) {
    const rules = opts.rules.map((r) => ({
      id: r.id,
      severity: "error" as const,
      category: "correctness" as const,
      check: () => [],
    }));
    (plugin as any).lintRules = () => rules;
  }

  if (opts.skills) {
    const skills = opts.skills.map((s) => ({
      name: s.name,
      description: "",
      content: "",
    }));
    (plugin as any).skills = () => skills;
  }

  if (opts.mcpTools) {
    const tools = opts.mcpTools.map((t) => ({
      name: t.name,
      description: "",
      inputSchema: { type: "object" as const, properties: {} },
      handler: async () => "",
    }));
    (plugin as any).mcpTools = () => tools;
  }

  if (opts.mcpResources) {
    const resources = opts.mcpResources.map((r) => ({
      uri: r.uri,
      name: "",
      description: "",
      handler: async () => "",
    }));
    (plugin as any).mcpResources = () => resources;
  }

  return plugin;
}

describe("checkConflicts", () => {
  // -----------------------------------------------------------------------
  // No conflicts
  // -----------------------------------------------------------------------

  test("returns clean report when no conflicts exist", () => {
    const plugins = [
      makePlugin("aws", { rules: [{ id: "AWS001" }] }),
      makePlugin("gcp", { rules: [{ id: "GCP001" }] }),
    ];
    const report = checkConflicts(plugins);
    expect(report.conflicts).toHaveLength(0);
    expect(report.warnings).toHaveLength(0);
  });

  test("handles plugins with no optional methods", () => {
    const plugins = [
      makePlugin("aws"),
      makePlugin("gcp"),
    ];
    const report = checkConflicts(plugins);
    expect(report.conflicts).toHaveLength(0);
    expect(report.warnings).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Rule ID conflicts (hard)
  // -----------------------------------------------------------------------

  test("detects duplicate rule IDs as hard conflicts", () => {
    const plugins = [
      makePlugin("aws", { rules: [{ id: "SHARED001" }, { id: "AWS001" }] }),
      makePlugin("gcp", { rules: [{ id: "SHARED001" }, { id: "GCP001" }] }),
    ];
    const report = checkConflicts(plugins);
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0]).toEqual({
      type: "rule-id",
      key: "SHARED001",
      plugins: ["aws", "gcp"],
    });
    expect(report.warnings).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Skill conflicts (warnings)
  // -----------------------------------------------------------------------

  test("detects duplicate skill names as warnings", () => {
    const plugins = [
      makePlugin("aws", { skills: [{ name: "scaffold" }] }),
      makePlugin("gcp", { skills: [{ name: "scaffold" }] }),
    ];
    const report = checkConflicts(plugins);
    expect(report.conflicts).toHaveLength(0);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toEqual({
      type: "skill-name",
      key: "scaffold",
      plugins: ["aws", "gcp"],
    });
  });

  // -----------------------------------------------------------------------
  // MCP tool conflicts (warnings)
  // -----------------------------------------------------------------------

  test("detects duplicate MCP tool names as warnings", () => {
    const plugins = [
      makePlugin("aws", { mcpTools: [{ name: "diff" }] }),
      makePlugin("gcp", { mcpTools: [{ name: "diff" }] }),
    ];
    const report = checkConflicts(plugins);
    expect(report.conflicts).toHaveLength(0);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toEqual({
      type: "mcp-tool",
      key: "diff",
      plugins: ["aws", "gcp"],
    });
  });

  test("no MCP tool conflict when names differ", () => {
    const plugins = [
      makePlugin("aws", { mcpTools: [{ name: "diff" }] }),
      makePlugin("gcp", { mcpTools: [{ name: "deploy" }] }),
    ];
    const report = checkConflicts(plugins);
    expect(report.warnings.filter((w) => w.type === "mcp-tool")).toHaveLength(0);
  });

  test("MCP tool conflict across three plugins", () => {
    const plugins = [
      makePlugin("aws", { mcpTools: [{ name: "scan" }] }),
      makePlugin("gcp", { mcpTools: [{ name: "scan" }] }),
      makePlugin("azure", { mcpTools: [{ name: "scan" }] }),
    ];
    const report = checkConflicts(plugins);
    const toolWarnings = report.warnings.filter((w) => w.type === "mcp-tool");
    expect(toolWarnings).toHaveLength(1);
    expect(toolWarnings[0].plugins).toEqual(["aws", "gcp", "azure"]);
  });

  // -----------------------------------------------------------------------
  // MCP resource conflicts (warnings)
  // -----------------------------------------------------------------------

  test("detects duplicate MCP resource URIs as warnings", () => {
    const plugins = [
      makePlugin("aws", { mcpResources: [{ uri: "catalog" }] }),
      makePlugin("gcp", { mcpResources: [{ uri: "catalog" }] }),
    ];
    const report = checkConflicts(plugins);
    expect(report.conflicts).toHaveLength(0);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toEqual({
      type: "mcp-resource",
      key: "catalog",
      plugins: ["aws", "gcp"],
    });
  });

  test("no MCP resource conflict when URIs differ", () => {
    const plugins = [
      makePlugin("aws", { mcpResources: [{ uri: "aws-catalog" }] }),
      makePlugin("gcp", { mcpResources: [{ uri: "gcp-catalog" }] }),
    ];
    const report = checkConflicts(plugins);
    expect(report.warnings.filter((w) => w.type === "mcp-resource")).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Combined
  // -----------------------------------------------------------------------

  test("detects multiple conflict types simultaneously", () => {
    const plugins = [
      makePlugin("aws", {
        rules: [{ id: "DUPE_RULE" }],
        skills: [{ name: "scaffold" }],
      }),
      makePlugin("gcp", {
        rules: [{ id: "DUPE_RULE" }],
        skills: [{ name: "scaffold" }],
      }),
    ];
    const report = checkConflicts(plugins);
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0].type).toBe("rule-id");
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings.map((w) => w.type)).toContain("skill-name");
  });

  test("detects all four conflict types at once", () => {
    const plugins = [
      makePlugin("aws", {
        rules: [{ id: "SHARED" }],
        skills: [{ name: "scaffold" }],
        mcpTools: [{ name: "scan" }],
        mcpResources: [{ uri: "catalog" }],
      }),
      makePlugin("gcp", {
        rules: [{ id: "SHARED" }],
        skills: [{ name: "scaffold" }],
        mcpTools: [{ name: "scan" }],
        mcpResources: [{ uri: "catalog" }],
      }),
    ];
    const report = checkConflicts(plugins);
    expect(report.conflicts).toHaveLength(1);
    expect(report.warnings).toHaveLength(3);
    const warningTypes = report.warnings.map((w) => w.type).sort();
    expect(warningTypes).toEqual(["mcp-resource", "mcp-tool", "skill-name"]);
  });

  test("detects conflict across three plugins", () => {
    const plugins = [
      makePlugin("aws", { rules: [{ id: "SHARED" }] }),
      makePlugin("gcp", { rules: [{ id: "SHARED" }] }),
      makePlugin("azure", { rules: [{ id: "SHARED" }] }),
    ];
    const report = checkConflicts(plugins);
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0].plugins).toEqual(["aws", "gcp", "azure"]);
  });
});
