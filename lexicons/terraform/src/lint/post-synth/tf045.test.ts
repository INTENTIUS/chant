import { describe, expect, test } from "vitest";
import { loadTreeFixture } from "./fixtures/load";
import { tf045 } from "./tf045";

describe("TF045: no Terragrunt config sets terragrunt_version_constraint", () => {
  test("flags a root.hcl with none, once, anchored on root.hcl", async () => {
    const ctx = await loadTreeFixture("TF045", "positive");
    const diags = tf045.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ checkId: "TF045", severity: "warning", lexicon: "terraform" });
    expect((ctx.entities.get(diags[0].entity!) as unknown as { props: { file: string } }).props.file).toBe("root.hcl");
    expect(diags[0].message).toContain("root.hcl");
  });

  test("a constraint in root.hcl passes", async () => {
    expect(tf045.check(await loadTreeFixture("TF045", "negative"))).toEqual([]);
  });

  test("a unit that includes a parent that was not read is not determined", async () => {
    expect(tf045.check(await loadTreeFixture("TF045", "unit-only"))).toEqual([]);
  });

  test("a repo with no Terragrunt config reports nothing", async () => {
    expect(tf045.check({ outputs: new Map(), entities: new Map() } as never)).toEqual([]);
  });

  test("check metadata", () => {
    expect(tf045.id).toBe("TF045");
  });
});
