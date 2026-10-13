import { describe, expect, test } from "vitest";
import { loadTreeFixture } from "./fixtures/load";
import { tf044 } from "./tf044";

describe("TF044: Terragrunt config keeps state in a local backend", () => {
  test("flags remote_state with backend = local", async () => {
    const diags = tf044.check(await loadTreeFixture("TF044", "positive"));
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ checkId: "TF044", severity: "warning", entity: "TF044/remote_state", lexicon: "terraform" });
    expect(diags[0].message).toContain("remote_state");
  });

  test("flags a generate block that writes a local backend", async () => {
    const diags = tf044.check(await loadTreeFixture("TF044", "positive-generate"));
    expect(diags).toHaveLength(1);
    expect(diags[0].entity).toBe("TF044/generate.backend");
    expect(diags[0].message).toContain('generate "backend"');
  });

  test("an s3 backend passes", async () => {
    expect(tf044.check(await loadTreeFixture("TF044", "negative"))).toEqual([]);
  });

  test("check metadata", () => {
    expect(tf044.id).toBe("TF044");
  });
});
