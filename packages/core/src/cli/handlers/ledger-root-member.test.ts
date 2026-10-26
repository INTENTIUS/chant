/**
 * #4482 (B4 of #4477): a local `chant run` of a TerraformApplyOp lands on the
 * Op run ledger of the member that declares the Op, and `chant ledger runs`
 * names the member whose directory holds the root it applied in
 * `root_member`. That is the read behold's member run card takes for a
 * choudoufu member applied from a chant one.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { ActivityFn, ActivityProfile } from "../../op/activity-registry";
import { runOpLocally } from "../../op/local-executor";
import type { OpConfig } from "../../op/types";
import { clearMemberLedgerCache } from "../../lifecycle/member-ledger";
import { readLedgerTable } from "../../lifecycle/ledger-read";
import { queryLedgers } from "./query";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
beforeEach(() => clearMemberLedgerCache());

function git(args: string[], cwd: string): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

function workspace(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-root-member-")));
  scratch.push(root);
  const files: Record<string, string> = {
    "chant.workspace.json": JSON.stringify({
      name: "estate",
      schema: 1,
      members: [
        { name: "app", dir: "app", kind: "chant" },
        { name: "aws", dir: "estates/aws", kind: "choudoufu" },
      ],
    }),
    "app/chant.config.json": JSON.stringify({ lexicons: ["terraform"], terraform: { roots: { aws: { dir: "../estates/aws" } } } }),
    "estates/aws/main.tf": "",
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  git(["init", "-q", "-b", "main"], root);
  git(["config", "user.email", "test@chant.dev"], root);
  git(["config", "user.name", "Test"], root);
  git(["add", "-A"], root);
  git(["commit", "-q", "-m", "init"], root);
  return root;
}

const PROFILES: Record<string, ActivityProfile> = { single: { timeout: "5m", retry: { maximumAttempts: 1 } } };

// The phases TerraformApplyOp builds with `gate: "never"`, with the Init step's #4482 outcome.
const config: OpConfig = {
  name: "aws-apply",
  overview: "",
  labels: { Apply: "true", TerraformRoot: "aws" },
  phases: [
    { name: "Init", steps: [{ kind: "activity", fn: "terraformInit", args: { root: "aws" }, outcomeAttribute: { name: "TerraformRootPath", from: "rootPath" } }] },
    { name: "Plan", steps: [{ kind: "activity", fn: "terraformPlan", args: { root: "aws" } }] },
    { name: "Apply", steps: [{ kind: "activity", fn: "terraformApply", args: { root: "aws" } }] },
  ],
};

describe("chant ledger runs: root_member (#4482)", () => {
  it("lists a local TerraformApplyOp run under the member whose root it applied", async () => {
    const root = workspace();
    const activities = new Map<string, ActivityFn>([
      // terraformInit's own result: the root's directory relative to the workspace.
      ["terraformInit", async () => ({ dir: join(root, "estates/aws"), rootPath: "estates/aws" })],
      ["terraformPlan", async () => ({ changed: true })],
      ["terraformApply", async () => ({ applied: true })],
    ]);
    const result = await runOpLocally(config, activities, PROFILES, undefined, { ledger: { cwd: join(root, "app") } });
    expect(result.status).toBe("ok");

    const doc = await readLedgerTable("runs", () => queryLedgers(root), { where: ["root_member=aws"] });
    if ("error" in doc) throw new Error(doc.error.message);
    expect(doc.rows).toHaveLength(1);
    expect(doc.rows[0]).toMatchObject({
      member: "app",
      op: "aws-apply",
      status: "ok",
      root_member: "aws",
      labels: { Apply: "true", TerraformRoot: "aws" },
      outcomes: { TerraformRootPath: "estates/aws" },
    });
  });

  it("leaves root_member null for a run with no root path", async () => {
    const root = workspace();
    const plain: OpConfig = { name: "plain", overview: "", phases: [{ name: "Only", steps: [{ kind: "activity", fn: "noop" }] }] };
    await runOpLocally(plain, new Map<string, ActivityFn>([["noop", async () => undefined]]), PROFILES, undefined, { ledger: { cwd: join(root, "app") } });
    const doc = await readLedgerTable("runs", () => queryLedgers(root), {});
    if ("error" in doc) throw new Error(doc.error.message);
    expect(doc.rows.map((r) => [r.op, r.root_member])).toEqual([["plain", null]]);
  });
});
