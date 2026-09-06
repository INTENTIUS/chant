import { describe, expect, test } from "vitest";
import { tf004 } from "./tf004";
import { tf005 } from "./tf005";
import { loadFixture } from "./fixtures/load";

describe("TF004: registry-sourced module block has no version", () => {
  test("check metadata", () => {
    expect(tf004.id).toBe("TF004");
    expect(tf004.description.toLowerCase()).toContain("registry");
  });

  test("flags a registry module with no version", async () => {
    const diags = tf004.check(await loadFixture("TF004", "positive"));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("TF004");
    expect(diags[0].message).toContain("terraform-aws-modules/vpc/aws");
    expect(diags[0].entity).toBe("TF004/module.vpc");
    expect(diags[0].lexicon).toBe("terraform");
  });

  test("passes a registry module with a version", async () => {
    const diags = tf004.check(await loadFixture("TF004", "negative"));
    expect(diags).toHaveLength(0);
  });

  test("never fires on a local source", async () => {
    const diags = tf004.check(await loadFixture("TF004", "negative-local"));
    expect(diags).toHaveLength(0);
  });

  test("never fires on a git source", async () => {
    const diags = tf004.check(await loadFixture("TF004", "negative-git"));
    expect(diags).toHaveLength(0);
  });

  test("is exclusive of TF005 on a git-sourced module block", async () => {
    const ctx = await loadFixture("TF004", "negative-git");
    expect(tf004.check(ctx)).toHaveLength(0);
    expect(tf005.check(ctx)).toHaveLength(0); // pinned to a tag, so neither fires
  });

  test("is exclusive of TF005 on a registry-sourced module block", async () => {
    const ctx = await loadFixture("TF004", "positive");
    expect(tf004.check(ctx)).toHaveLength(1);
    expect(tf005.check(ctx)).toHaveLength(0);
  });
});
