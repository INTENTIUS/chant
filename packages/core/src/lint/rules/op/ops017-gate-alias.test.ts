/**
 * OPS017 (#3949) — a gate's aliases, checked over every Op in the build and
 * the workspace's `identity.gates`.
 */

import { afterEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PostSynthContext } from "../../post-synth";
import { DECLARABLE_MARKER } from "../../../declarable";
import { ops017, ops017Check, workspaceIdentityGates } from "./ops017-gate-alias";

const PLAN = `jcs1-sha256:${"a".repeat(64)}`;

function ctxWith(ops: Array<{ name: string; phases: unknown[] }>): PostSynthContext {
  const entities = new Map<string, unknown>(ops.map((op) => [op.name, {
    [DECLARABLE_MARKER]: true,
    entityType: "Chant::Op",
    lexicon: "chant",
    kind: "resource",
    props: { name: op.name, overview: "test", phases: op.phases },
    attributes: {},
  }]));
  return {
    outputs: new Map([["chant", ""]]),
    entities: entities as Map<string, never>,
    buildResult: { outputs: new Map([["chant", ""]]), entities: entities as Map<string, never>, warnings: [], errors: [], sourceFileCount: 1 },
  };
}

const merged = (gate: Record<string, unknown> = {}) => ({
  name: "upgrade",
  phases: [{ name: "Wave 1", steps: [{ kind: "gate", gate: "approve-tier-1", plan: PLAN, aliases: [{ op: "upgrade-tier-1", gate: "approve" }], ...gate }] }],
});
const tier1 = { name: "upgrade-tier-1", phases: [{ name: "Gate", steps: [{ kind: "gate", gate: "approve" }] }] };

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

function workspace(gates: Record<string, { class?: string }>): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-ops017-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, "chant.workspace.json"), JSON.stringify({ name: "acme", schema: 1, members: [], identity: { gates } }));
  return dir;
}

describe("OPS017", () => {
  test("an alias of a gate that is gone passes", () => {
    expect(ops017.check(ctxWith([merged()]))).toEqual([]);
  });

  test("an alias of a gate still in the build is an error", () => {
    const [d] = ops017.check(ctxWith([merged(), tier1]));
    expect(d).toMatchObject({ checkId: "OPS017", severity: "error", entity: "upgrade" });
    expect(d!.message).toBe(
      'Op "upgrade", phase "Wave 1", gate:approve-tier-1: alias upgrade-tier-1/approve is still a gate; remove that gate, or this alias, so one approval doesn\'t answer two gates',
    );
  });

  test("aliases on a gate with no plan are an error", () => {
    expect(ops017.check(ctxWith([merged({ plan: undefined })]))[0]!.message).toContain("aliases need a plan");
  });

  test("a gate that drops its alias's identity.gates rule is an error", async () => {
    const check = async (gates: Record<string, { class?: string }>) => {
      const ctx = ctxWith([merged()]);
      return ops017Check(await workspaceIdentityGates(workspace(gates), ctx.entities)).check(ctx);
    };
    expect((await check({ approve: {} }))[0]!.message).toContain("identity.gates names its alias approve");
    expect((await check({ approve: { class: "human" }, "approve-tier-1": {} }))[0]!.message).toContain("must keep its alias's class");
    expect(await check({ approve: {}, "approve-tier-1": {} })).toEqual([]);
  });

  test("the identity rules are read only when an Op has aliases, and only in a workspace", async () => {
    const dir = workspace({ approve: {} });
    expect(await workspaceIdentityGates(dir, ctxWith([tier1]).entities)).toBeUndefined();
    expect(await workspaceIdentityGates(tmpdir(), ctxWith([merged()]).entities)).toBeUndefined();
    expect(await workspaceIdentityGates(dir, ctxWith([merged()]).entities)).toEqual(new Map([["approve", null]]));
  });
});
