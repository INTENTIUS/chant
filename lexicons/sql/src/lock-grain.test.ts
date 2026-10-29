/**
 * The lock grain of a SQL member (#4571): both kinds default to `target`,
 * refuse `resource` naming the engine, and leave `repo` alone. Resolved
 * through core's `resolvePlannedLock`, as pr-apply and op waves resolve it.
 */
import { describe, expect, test } from "vitest";
import { LockGrainRefusedError, resolvePlannedLock } from "@intentius/chant/lifecycle/lock-rows";
import { createSqlApplyCapability, createSqlMigrateCapability } from "./capability-plugin";
import { sqlDefaultLockGrain, sqlLockGrainRefusal } from "./lock-grain";

const migrate = createSqlMigrateCapability({ run: async () => ({ code: 0, stdout: "", stderr: "" }) });
const apply = createSqlApplyCapability({
  plan: async (_input, dialect) => ({ dialect, changes: [], refused: [], holes: [], problems: [] }),
  apply: async () => ({ applied: [], pruned: [], notAttempted: [] }),
});
const migrateInput = { environment: "prod", spec: "yodel-waves.json" };
const applyInput = { environment: "prod", build: "dist/schema.json" };
const plan = { member: "prod" };

describe("the SQL lock grain (#4571)", () => {
  test("the default is target, the environment's history", () => {
    expect(sqlDefaultLockGrain()).toBe("target");
    expect(migrate.defaultLockGrain?.(migrateInput)).toBe("target");
    expect(apply.defaultLockGrain?.(applyInput)).toBe("target");
  });

  test("an undeclared member resolves to target from the lexicon, with no rows", async () => {
    for (const [cap, input] of [
      [migrate, migrateInput],
      [apply, applyInput],
    ] as const) {
      const lock = await resolvePlannedLock(cap, input, plan, undefined);
      expect(lock).toEqual({ grain: "target", source: "lexicon", rows: [] });
    }
  });

  test("resource is refused by name, for both kinds", async () => {
    expect(sqlLockGrainRefusal("sql-migrate", "resource")).toMatch(/SQL Yodeler.*KeeperMap.*advisory lock/);
    expect(sqlLockGrainRefusal("sql-apply", "resource")).toMatch(/creation order/);
    const refused = await resolvePlannedLock(migrate, migrateInput, plan, "resource").catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(LockGrainRefusedError);
    expect((refused as Error).message).toMatch(/^"prod": the resource lock grain is refused: SQL Yodeler/);
    await expect(resolvePlannedLock(apply, applyInput, plan, "resource")).rejects.toThrow(/the resource lock grain is refused: the sql lexicon's applier/);
  });

  test("target and repo, declared, are taken as declared", async () => {
    expect(sqlLockGrainRefusal("sql-migrate", "target")).toBeUndefined();
    expect(sqlLockGrainRefusal("sql-apply", "repo")).toBeUndefined();
    // The ruling for ci-products (2026-10-28): repo waits for the repo row on chant's ledger; target names no row for SQL.
    expect(await resolvePlannedLock(migrate, migrateInput, plan, "repo")).toEqual({
      grain: "repo",
      source: "declared",
      rows: [],
      queue: [{ key: "repo", target: plan.member, address: "the repository" }],
    });
    expect(await resolvePlannedLock(apply, applyInput, plan, "target")).toEqual({ grain: "target", source: "declared", rows: [] });
  });

  test("neither kind names rows", () => {
    expect(migrate.lockRows).toBeUndefined();
    expect(apply.lockRows).toBeUndefined();
  });
});
