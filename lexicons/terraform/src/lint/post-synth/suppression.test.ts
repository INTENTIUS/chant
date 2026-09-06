/**
 * End-to-end suppression (chant #2111): real `.tf` text, through
 * `blocksToEntities` (the exact parse `chant build`'s `buildRoots()` and
 * `chant audit`'s `auditEntities()` both call), into TF001, then through
 * `applyInlineSuppressions`. TF001 is the issue's named test subject because
 * it is the one rule with nothing to anchor a finding to but the entity that
 * is missing something, and proving both `# chant-ignore` and
 * `# chant-ignore-block` reach it validates the block-anchored form for
 * exactly the case it exists for.
 */
import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { applyInlineSuppressions, SUPPRESSION_EXPIRED_ID, SUPPRESSION_MISPLACED_FILE_ID, SUPPRESSION_UNIGNORABLE_ID } from "@intentius/chant/lint/suppressions";
import type { RuleConfig } from "@intentius/chant/lint/rule";
import { tf001 } from "./tf001";
import { blocksToEntities } from "../../hcl/parse";

async function ctxFor(source: string): Promise<PostSynthContext> {
  const entities = await blocksToEntities([{ name: "main.tf", source }], "app");
  return { outputs: new Map(), entities } as unknown as PostSynthContext;
}

/** A `terraform` block with no backend: TF001's positive case, undecorated. */
const BACKENDLESS = `terraform {\n  required_version = ">= 1.5.0"\n}\n`;

describe("TF001 through inline suppression", () => {
  test("chant-ignore-block suppresses TF001 on the terraform block", async () => {
    const ctx = await ctxFor(`# chant-ignore-block: TF001\n${BACKENDLESS}`);
    const diags = tf001.check(ctx);
    expect(diags).toHaveLength(1);
    const { diagnostics, suppressed } = applyInlineSuppressions(diags, ctx.entities);
    expect(diagnostics).toHaveLength(0);
    expect(suppressed).toHaveLength(1);
  });

  test("a plain chant-ignore on the same block also suppresses TF001", async () => {
    const ctx = await ctxFor(`# chant-ignore: TF001\n${BACKENDLESS}`);
    const diags = tf001.check(ctx);
    const { diagnostics, suppressed } = applyInlineSuppressions(diags, ctx.entities);
    expect(diagnostics).toHaveLength(0);
    expect(suppressed).toHaveLength(1);
  });

  test('"all" suppresses TF001 too, not just an explicit id', async () => {
    const ctx = await ctxFor(`# chant-ignore-block: all\n${BACKENDLESS}`);
    const diags = tf001.check(ctx);
    const { diagnostics, suppressed } = applyInlineSuppressions(diags, ctx.entities);
    expect(diagnostics).toHaveLength(0);
    expect(suppressed).toHaveLength(1);
  });

  test("a directive naming a different rule id does not suppress TF001", async () => {
    const ctx = await ctxFor(`# chant-ignore-block: TF010\n${BACKENDLESS}`);
    const diags = tf001.check(ctx);
    const { diagnostics, suppressed } = applyInlineSuppressions(diags, ctx.entities);
    expect(diagnostics).toHaveLength(1);
    expect(suppressed).toHaveLength(0);
  });

  test("chant-ignore-file suppresses TF001 for the whole root when placed at the top", async () => {
    const ctx = await ctxFor(`# chant-ignore-file: TF001\n${BACKENDLESS}`);
    const diags = tf001.check(ctx);
    const { diagnostics, suppressed } = applyInlineSuppressions(diags, ctx.entities);
    expect(diagnostics).toHaveLength(0);
    expect(suppressed).toHaveLength(1);
  });

  test("a chant-ignore-file NOT on the first non-blank line does not suppress, and is reported", async () => {
    const ctx = await ctxFor(`# a header\n# chant-ignore-file: TF001\n${BACKENDLESS}`);
    const diags = tf001.check(ctx);
    const { diagnostics, suppressed, meta } = applyInlineSuppressions(diags, ctx.entities);
    expect(diagnostics).toHaveLength(1); // TF001 still fires: the misplaced directive has no effect
    expect(suppressed).toHaveLength(0);
    expect(meta.map((m) => m.checkId)).toEqual([SUPPRESSION_MISPLACED_FILE_ID]);
  });

  test("an expired directive no longer suppresses TF001, and is reported once", async () => {
    const ctx = await ctxFor(`# chant-ignore-block: TF001 exp:2020-01-01\n${BACKENDLESS}`);
    const diags = tf001.check(ctx);
    const { diagnostics, suppressed, meta } = applyInlineSuppressions(diags, ctx.entities, undefined, new Date("2026-01-01"));
    expect(diagnostics).toHaveLength(1);
    expect(suppressed).toHaveLength(0);
    expect(meta.map((m) => m.checkId)).toEqual([SUPPRESSION_EXPIRED_ID]);
  });

  test("a not-yet-expired directive still suppresses TF001", async () => {
    const ctx = await ctxFor(`# chant-ignore-block: TF001 exp:2099-01-01\n${BACKENDLESS}`);
    const diags = tf001.check(ctx);
    const { diagnostics, suppressed, meta } = applyInlineSuppressions(diags, ctx.entities, undefined, new Date("2026-01-01"));
    expect(diagnostics).toHaveLength(0);
    expect(suppressed).toHaveLength(1);
    expect(meta).toHaveLength(0);
  });

  test("ignorable: false denies an explicit chant-ignore of TF001, and reports the attempt", async () => {
    const rules: Record<string, RuleConfig> = { TF001: ["warning", { ignorable: false }] };
    const ctx = await ctxFor(`# chant-ignore-block: TF001\n${BACKENDLESS}`);
    const diags = tf001.check(ctx);
    const { diagnostics, suppressed, meta } = applyInlineSuppressions(diags, ctx.entities, rules);
    expect(diagnostics).toHaveLength(1); // TF001 still fires
    expect(suppressed).toHaveLength(0);
    expect(meta.map((m) => m.checkId)).toEqual([SUPPRESSION_UNIGNORABLE_ID]);
  });

  test("TF001 with a backend block never fires, suppressed or not", async () => {
    const withBackend = `terraform {\n  backend "s3" {\n    bucket = "tfstate"\n  }\n}\n`;
    const ctx = await ctxFor(withBackend);
    expect(tf001.check(ctx)).toHaveLength(0);
  });
});
