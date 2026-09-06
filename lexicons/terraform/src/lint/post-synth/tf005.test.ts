import { describe, expect, test } from "vitest";
import { tf004 } from "./tf004";
import { tf005 } from "./tf005";
import { loadFixture } from "./fixtures/load";

describe("TF005: git/hg module source is unpinned, or pinned to a mutable ref", () => {
  test("check metadata", () => {
    expect(tf005.id).toBe("TF005");
    expect(tf005.description).toContain("Git/hg");
  });

  test("flags an unpinned git source", async () => {
    const diags = tf005.check(await loadFixture("TF005", "positive"));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("TF005");
    expect(diags[0].message).toContain("no `?ref=`");
    expect(diags[0].entity).toBe("TF005/module.vpc");
  });

  test("flags a ref pinned to a default branch", async () => {
    const diags = tf005.check(await loadFixture("TF005", "positive-branch"));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("mutable branch");
  });

  test("flags a ref that is neither a tag nor a full SHA (stricter than checkov's \\d\\.\\d)", async () => {
    const diags = tf005.check(await loadFixture("TF005", "positive-non-semver"));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("neither a tag nor a full commit SHA");
  });

  test("passes a ref pinned to a semver tag", async () => {
    const diags = tf005.check(await loadFixture("TF005", "negative"));
    expect(diags).toHaveLength(0);
  });

  test("passes a ref pinned to a full 40-hex commit SHA", async () => {
    const diags = tf005.check(await loadFixture("TF005", "negative-sha"));
    expect(diags).toHaveLength(0);
  });

  test("never fires on a local source", async () => {
    const diags = tf005.check(await loadFixture("TF005", "negative-local"));
    expect(diags).toHaveLength(0);
  });

  test("never fires on a registry source", async () => {
    const diags = tf005.check(await loadFixture("TF005", "negative-registry"));
    expect(diags).toHaveLength(0);
  });

  test("is exclusive of TF004 on a registry-sourced module block", async () => {
    const ctx = await loadFixture("TF005", "negative-registry");
    expect(tf005.check(ctx)).toHaveLength(0);
    expect(tf004.check(ctx)).toHaveLength(1); // no version set, so TF004 fires instead
  });
});
