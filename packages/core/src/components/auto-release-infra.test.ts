/**
 * #4274: a component that only deploys infrastructure gets a release record
 * from `pr-apply` and `chant run --components`. Its digest is the plan digest
 * its approval bound, or its deploy-input digest when nothing planned, and
 * `digestKind` says which. Written into a workspace member's ledger, under
 * the member's prefix on chant/lifecycle.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appliedDigestOf } from "./auto-release";
import { recordAutoReleasesForRun } from "../cli/handlers/run";
import { clearMemberLedgerCache } from "../lifecycle/member-ledger";
import { readReleaseLedger } from "../lifecycle/release-ledger";
import type { DriverComponent, DriverComponentResult } from "./driver";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

function git(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

/** A workspace whose member `infra` deploys one CloudFormation template and publishes nothing. */
function workspace(): { root: string; member: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-infra-record-")));
  scratch.push(root);
  const files: Record<string, string> = {
    "chant.workspace.json": JSON.stringify({ name: "acme", schema: 1, members: [{ name: "infra", dir: "services/infra", kind: "chant" }] }),
    "services/infra/chant.config.json": JSON.stringify({ lexicons: ["aws"] }),
    "services/infra/dist/infra.template.json": JSON.stringify({ Resources: {} }),
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
  return { root, member: join(root, "services/infra") };
}

const infra: DriverComponent = {
  name: "infra",
  deploy: [{ name: "Deploy", steps: [{ kind: "cfn-deploy", stackName: "infra", template: "dist/infra.template.json" }] }],
} as unknown as DriverComponent;

const applied = {
  component: "infra",
  ok: true,
  status: "ok",
  records: [{ component: "infra", phase: "Deploy", kind: "cfn-deploy", status: "ok", durationMs: 1, output: { stackId: "arn:aws:cloudformation:infra" } }],
} as unknown as DriverComponentResult;

const planDigest = `jcs1-sha256:${"a".repeat(64)}`;

let cwd: string;
beforeEach(() => {
  cwd = process.cwd();
  clearMemberLedgerCache();
  process.env.GITHUB_ACTOR = "alice";
});
afterEach(() => {
  process.chdir(cwd);
  delete process.env.GITHUB_ACTOR;
});

describe("appliedDigestOf", () => {
  test("a component with one planned member gets that member's plan digest", () => {
    const of = appliedDigestOf({ components: [infra], env: "staging", projectRoot: "/nowhere", members: [{ member: "infra", component: "infra", planDigest }] });
    expect(of("infra")).toEqual({ digest: planDigest, kind: "plan" });
  });

  test("a component with several planned members gets the set digest over them, the same whatever their order", () => {
    const members = [
      { member: "infra/a", component: "infra", planDigest },
      { member: "infra/b", component: "infra", planDigest: `jcs1-sha256:${"b".repeat(64)}` },
    ];
    const one = appliedDigestOf({ components: [infra], env: "staging", projectRoot: "/nowhere", members })("infra");
    const two = appliedDigestOf({ components: [infra], env: "staging", projectRoot: "/nowhere", members: [...members].reverse() })("infra");
    expect(one?.kind).toBe("plan");
    expect(one?.digest).not.toBe(planDigest);
    expect(two).toEqual(one);
  });

  test("a component that planned nothing gets its deploy-input digest, which moves with the template it deploys", () => {
    const { member } = workspace();
    const before = appliedDigestOf({ components: [infra], env: "staging", projectRoot: member })("infra");
    expect(before?.kind).toBe("deploy-input");
    writeFileSync(join(member, "dist/infra.template.json"), JSON.stringify({ Resources: { Bucket: {} } }));
    const after = appliedDigestOf({ components: [infra], env: "staging", projectRoot: member })("infra");
    expect(after?.kind).toBe("deploy-input");
    expect(after?.digest).not.toBe(before?.digest);
  });

  test("a component the run doesn't know has none", () => {
    expect(appliedDigestOf({ components: [infra], env: "staging", projectRoot: "/nowhere" })("other")).toBeNull();
  });
});

describe("recordAutoReleasesForRun for an infrastructure-only component", () => {
  test("a pr-apply records the plan digest under the member's prefix", async () => {
    const { root, member } = workspace();
    process.chdir(member);
    const of = appliedDigestOf({ components: [infra], env: "staging", projectRoot: member, members: [{ member: "infra", component: "infra", planDigest }] });
    const recorded = await recordAutoReleasesForRun([applied], "staging", "run-1", false, { forge: "local" }, undefined, undefined, of);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ component: "infra", env: "staging", digest: planDigest, digestKind: "plan", actor: "alice" });

    const files = git(["ls-tree", "-r", "--name-only", "chant/lifecycle"], root).split("\n").filter(Boolean);
    expect(files).toContain("_members/infra/staging/releases.jsonl");
    const { records } = await readReleaseLedger("staging", { cwd: member });
    expect(records).toEqual([expect.objectContaining({ digest: planDigest, digestKind: "plan" })]);
  });

  test("without an applied digest it records nothing, as before", async () => {
    const { member } = workspace();
    process.chdir(member);
    const recorded = await recordAutoReleasesForRun([applied], "staging", "run-1", false);
    expect(recorded).toEqual([]);
  });
});
