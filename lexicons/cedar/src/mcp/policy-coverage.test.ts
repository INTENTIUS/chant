import { describe, expect, it } from "vitest";
import { computePolicyCoverage, formatPolicyCoverage } from "./policy-coverage";
import { cedarMcpResources, cedarMcpTools } from "./index";
import { mcpNameViolations } from "@intentius/chant/cli/commands/check-lexicon-mcp";

// No projectRoot and no config, so every call resolves the bundled default
// schema — the same one the examples build against.
const against = (policySetText: string) => computePolicyCoverage({ policySetText, projectRoot: "/nonexistent" });

const ownerRead = `@id("owner-read")
permit (
  principal is App::User,
  action == App::Action::"read",
  resource is App::Document
)
when { resource.owner == principal };`;

const secretFloor = `@id("secret-floor")
forbid (
  principal,
  action,
  resource is App::Folder
)
when { resource.name == "secrets" };`;

describe("computePolicyCoverage", () => {
  it("reports nothing covered for an empty policy set", () => {
    const report = against("");

    expect(report.policyCount).toBe(0);
    expect(report.entityTypesCovered).toBe(0);
    expect(report.actionsCovered).toBe(0);
    expect(report.uncovered).toContain("App::Document");
    expect(report.uncovered).toContain('App::Action::"read"');
  });

  it("counts the declarations one policy can apply to", () => {
    const report = against(ownerRead);

    expect(report.policyCount).toBe(1);
    const document = report.items.find((i) => i.name === "App::Document");
    expect(document?.policies).toBe(1);
    expect(document?.policyIds).toEqual(["owner-read"]);
    expect(document?.permitted).toBe(true);
    expect(document?.forbidden).toBe(false);

    // `read` also applies to Folder in the schema, but this policy's resource
    // scope excludes it — the resolver, not the scope text, is what decides.
    expect(report.items.find((i) => i.name === "App::Folder")?.policies).toBe(0);
  });

  it("resolves an action group rather than reading the scope literally", () => {
    const report = against(ownerRead);

    expect(report.items.find((i) => i.name === 'App::Action::"read"')?.policies).toBe(1);
    expect(report.items.find((i) => i.name === 'App::Action::"write"')?.policies).toBe(0);
  });

  it("flags a declaration reachable only from a forbid", () => {
    const report = against(secretFloor);

    expect(report.forbidOnly).toContain("App::Folder");
    expect(report.items.find((i) => i.name === "App::Folder")?.forbidden).toBe(true);
    expect(report.uncovered).not.toContain("App::Folder");
  });

  it("stops flagging it once a permit reaches it too", () => {
    const report = against(`${ownerRead}\n\n${secretFloor}`);

    expect(report.policyCount).toBe(2);
    expect(report.forbidOnly).toContain("App::Folder");
    expect(report.forbidOnly).not.toContain("App::Document");
  });

  it("names a bare permit as covering every action and every reachable entity type", () => {
    const report = against("permit (principal, action, resource);");

    expect(report.actionsCovered).toBe(report.actions);

    // Group and Team appear in no action's `appliesTo` — they exist only as
    // containers to be `in`. Not even `permit (principal, action, resource)`
    // reaches them, which is the resolver telling the truth: no request can
    // ever name them as a principal or a resource. Reporting them as covered
    // would be the more comfortable answer and the wrong one.
    expect(report.uncovered).toEqual(["App::Group", "App::Team"]);
    expect(report.entityTypesCovered).toBe(report.entityTypes - 2);
  });

  it("reads the effect from Cedar's parse, not from the surrounding text", () => {
    // A permit whose annotation contains the word `forbid` at the start of a
    // line, and a policy id containing an escaped quote. Both defeated the
    // text-scanning version of this.
    const report = against(`@id("say \\"forbid\\" here")
@note("
forbid (this is prose)")
permit (
  principal is App::User,
  action == App::Action::"read",
  resource is App::Document
);`);

    const document = report.items.find((i) => i.name === "App::Document");
    expect(document?.permitted).toBe(true);
    expect(document?.forbidden).toBe(false);
    expect(document?.policyIds).toEqual(['say "forbid" here']);
    expect(report.forbidOnly).not.toContain("App::Document");
  });

  it("falls back to a positional id when a policy carries no @id", () => {
    const report = against("permit (principal, action, resource);");

    expect(report.items.find((i) => i.name === "App::Document")?.policyIds).toEqual(["policy-1"]);
  });

  it("distinguishes a policy set that will not parse from one with no policies", () => {
    const report = against("permit (principal, action");

    expect(report.parseErrors.length).toBeGreaterThan(0);
    expect(report.policyCount).toBe(0);
    // Same counts as an empty set — the parseErrors field is the only thing
    // that tells the two apart, which is why it exists.
    expect(report.uncovered).toContain("App::Document");
  });

  it("names a policy that can never fire", () => {
    // App::Ghost parses — it is a syntactically valid entity type — and the
    // resolver answers "success, nothing" rather than failing. A permit no
    // request can ever match is almost always a typo'd entity type, so the
    // empty envelope is reported rather than swallowed.
    const report = against(`@id("ghost")
permit (
  principal,
  action,
  resource is App::Ghost
);`);

    expect(report.inert).toEqual(["ghost"]);
    expect(report.unresolved).toEqual([]);
    expect(report.uncovered).toContain("App::Document");
    expect(formatPolicyCoverage(report)).toContain("Never fires:  ghost");
  });
});

describe("formatPolicyCoverage", () => {
  it("summarises counts, uncovered declarations and forbid-only ones", () => {
    const text = formatPolicyCoverage(against(`${ownerRead}\n\n${secretFloor}`));

    expect(text).toContain("2 policy/policies");
    expect(text).toContain("Entity types:");
    expect(text).toContain("Uncovered:");
    expect(text).toMatch(/Forbid only:.*App::Folder/);
  });
});

describe("MCP contributions", () => {
  it("registers three contributions under one well-formed cedar namespace", () => {
    const tools = cedarMcpTools();
    const resources = cedarMcpResources(import.meta.url);

    expect(tools).toHaveLength(2);
    expect(resources).toHaveLength(1);
    expect(mcpNameViolations("cedar", tools, resources)).toEqual([]);
  });

  it("ships the conventional diff tool and catalog resource beside the cedar-specific one", () => {
    expect(cedarMcpTools().map((t) => t.name)).toEqual(["cedar:diff", "coverage"]);
    expect(cedarMcpResources(import.meta.url).map((r) => r.uri)).toEqual(["cedar:resource-catalog"]);
  });

  it("declares an input schema the agent can fill in", () => {
    const coverage = cedarMcpTools().find((t) => t.name === "coverage");

    expect(coverage?.inputSchema.properties).toHaveProperty("path");
    expect(coverage?.inputSchema.properties).toHaveProperty("format");
  });
});
