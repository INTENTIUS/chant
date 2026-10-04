import { describe, expect, test } from "vitest";
import { loadTreeFixture } from "./fixtures/load";
import { tf042 } from "./tf042";

describe("TF042: Terragrunt dependency sets skip_outputs together with mock_outputs", () => {
  test("flags the pair", async () => {
    const diags = tf042.check(await loadTreeFixture("TF042", "positive"));
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ checkId: "TF042", severity: "warning", entity: "TF042/dependency.vpc", lexicon: "terraform" });
  });

  test("skip_outputs alone, and skip_outputs = false with mocks, pass", async () => {
    expect(tf042.check(await loadTreeFixture("TF042", "negative"))).toEqual([]);
  });

  test("check metadata", () => {
    expect(tf042.id).toBe("TF042");
  });
});
