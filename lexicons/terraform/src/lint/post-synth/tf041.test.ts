import { describe, expect, test } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { blocksToEntities } from "../../hcl/parse";
import { loadTreeFixture } from "./fixtures/load";
import { tf041 } from "./tf041";

async function withDependency(body: string): Promise<PostSynthContext> {
  const hcl = `dependency "vpc" {\n  config_path = "../vpc"\n${body}\n}\n`;
  const entities = await blocksToEntities([{ name: "terragrunt.hcl", source: hcl }], "unit");
  return { outputs: new Map(), entities } as unknown as PostSynthContext;
}

describe("TF041: Terragrunt dependency lets mock_outputs stand in for apply", () => {
  test("mocks with no allow-list", async () => {
    const diags = tf041.check(await loadTreeFixture("TF041", "positive"));
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ checkId: "TF041", severity: "warning", entity: "TF041/dependency.vpc", lexicon: "terraform" });
    expect(diags[0].message).toContain("no `mock_outputs_allowed_terraform_commands`");
  });

  test("an allow-list that names apply", async () => {
    const diags = tf041.check(await loadTreeFixture("TF041", "positive-apply"));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('lists "apply"');
  });

  test("a restricted list and a dependency with no mocks pass", async () => {
    expect(tf041.check(await loadTreeFixture("TF041", "negative"))).toEqual([]);
  });

  test("an empty list restricts nothing, so it is flagged", async () => {
    const diags = tf041.check(await withDependency("  mock_outputs = { id = \"x\" }\n  mock_outputs_allowed_terraform_commands = []"));
    expect(diags).toHaveLength(1);
  });

  test("a list built from an expression is not determined", async () => {
    const body = '  mock_outputs = { id = "x" }\n  mock_outputs_allowed_terraform_commands = local.mock_commands';
    expect(tf041.check(await withDependency(body))).toEqual([]);
  });

  test("the dependency block records its start line, which anchors chant-ignore", async () => {
    const ctx = await withDependency('  mock_outputs = { id = "x" }');
    const entity = ctx.entities.get("unit/dependency.vpc") as unknown as { props: { line?: number } };
    expect(entity.props.line).toBe(1);
  });

  test("check metadata", () => {
    expect(tf041.id).toBe("TF041");
  });
});
