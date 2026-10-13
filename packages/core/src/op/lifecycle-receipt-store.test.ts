import { describe, test, expect } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { lifecycleReceiptFile, lifecycleReceiptStore } from "./lifecycle-receipt-store";
import { receiptActivities, type EffectReceiptRef } from "./receipt-store";

function git(args: string[], cwd: string): { stdout: string; exitCode: number } {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  return { stdout: r.stdout ?? "", exitCode: r.status ?? -1 };
}

function initRepo(dir: string): void {
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "test@chant.dev"], dir);
  git(["config", "user.name", "Test"], dir);
  writeFileSync(join(dir, "README.md"), "fixture\n");
  git(["add", "README.md"], dir);
  git(["commit", "-q", "-m", "init"], dir);
}

const RECEIPT: EffectReceiptRef = { name: "fly-migration:shop/001_init.sql", effect: "fly-migrate", flavor: "hash", inputs: {} };

describe("lifecycleReceiptStore", () => {
  test("a receipt is absent, then written under <env>/receipts on chant/lifecycle", async () => {
    await withTestDir(async (dir) => {
      initRepo(dir);
      const store = lifecycleReceiptStore({ environment: "prod", cwd: dir });
      expect(await store.read(RECEIPT)).toBeUndefined();
      await store.write(RECEIPT, "sha256:abc");
      expect(await store.read(RECEIPT)).toBe("sha256:abc");
      const shown = git(["show", `chant/lifecycle:prod/${lifecycleReceiptFile(RECEIPT.name)}`], dir);
      expect(shown.exitCode).toBe(0);
      expect(shown.stdout.trim()).toBe("sha256:abc");
      // Another environment has its own receipts.
      expect(await lifecycleReceiptStore({ environment: "dev", cwd: dir }).read(RECEIPT)).toBeUndefined();
    });
  });

  test("bound to core's receipt activities, the effect step's read-compare-write goes through it", async () => {
    await withTestDir(async (dir) => {
      initRepo(dir);
      const acts = receiptActivities(lifecycleReceiptStore({ environment: "prod", cwd: dir }));
      const first = await acts.receiptRead({ receipt: RECEIPT, expectation: "sha256:1" });
      expect(first).toEqual({ current: null, expectation: "sha256:1", applied: false });
      await acts.receiptWrite({ receipt: RECEIPT, expectation: "sha256:1" });
      expect((await acts.receiptRead({ receipt: RECEIPT, expectation: "sha256:1" })).applied).toBe(true);
    });
  });

  test("with no environment and no CHANT_ENV it refuses rather than guessing", async () => {
    const store = lifecycleReceiptStore({ env: {} });
    await expect(store.read(RECEIPT)).rejects.toThrow(/no environment/);
  });

  test("receipt names become safe file names", () => {
    expect(lifecycleReceiptFile("fly-migration:app/002 add.sql")).toBe("receipts/fly-migration_app_002_add.sql.receipt");
  });
});
