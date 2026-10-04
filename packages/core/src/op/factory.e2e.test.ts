/**
 * The factory reference Op (#3406, ws-087), run through the local executor
 * with stub hooks on a small workspace that carries the reference
 * workspace's decision, work and answer kinds and its points: one item from
 * pick to done, one retry after a failed build, and one ask the understand
 * point refuses. The rules themselves are tested in
 * ./factory-rules.test.ts.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import * as coreActivities from "./activities";
import type { ActivityFn } from "./activity-registry";
import { ACTIVITY_PROFILES } from "./activity-profiles";
import { factoryOpConfig } from "./factory";
import { OpRunFailure, runOpLocally, type OpRunResult } from "./local-executor";
import { answerPoint } from "../workspace/decide";
import { workspacePoints } from "../workspace/points-cli";
import { amendRecord } from "../workspace/records-write";
import { parseFrontMatter } from "../workspace/records";

const REF = join(import.meta.dirname, "..", "..", "..", "..", "reference-workspace");

const activities = new Map<string, ActivityFn>(Object.entries(coreActivities).filter(([, v]) => typeof v === "function") as [string, ActivityFn][]);

function git(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

const item = (id: string, fields: Record<string, unknown>, body = "") =>
  `---\n${JSON.stringify({ schema: 1, id, title: `Item ${id}`, state: "open", implements: [], needs: [], constrains: ["member:app"], evidence: [], opened_on: "2026-10-01", source: { kind: "workspace", member: "app" }, supersedes: [], ...fields }, null, 2)}\n---\n\n# Item ${id}\n${body}`;

/**
 * The builder stub: writes app/<item>.txt, and fails while .fail-<item> exists in the checkout
 * the test controls (FACTORY_FAIL_DIR), so a retry can succeed.
 */
const BUILDER = `
const fs = require("node:fs");
const item = process.env.FACTORY_ITEM;
if (fs.existsSync(require("node:path").join(process.env.FACTORY_FAIL_DIR, ".fail-" + item))) { console.error("the build broke"); process.exit(1); }
fs.mkdirSync("app", { recursive: true });
fs.writeFileSync("app/" + item + ".txt", "built at tier " + process.env.FACTORY_TIER + "\\n");
`;
const CHECK = `const fs = require("node:fs"); process.exit(fs.existsSync("app/" + process.env.FACTORY_ITEM + ".txt") ? 0 : 1);`;

function workspace(dir: string): void {
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "t@chant.dev"], dir);
  git(["config", "user.name", "T"], dir);
  git(["config", "commit.gpgsign", "false"], dir);
  for (const d of ["decisions", "work", "answers"]) mkdirSync(join(dir, d), { recursive: true });
  for (const f of ["decisions/decision.kind.mjs", "decisions/decision.schema.json", "decisions/points.json", "work/work.kind.mjs", "work/work.schema.json", "answers/answer.kind.mjs", "answers/answer.schema.json"]) {
    cpSync(join(REF, f), join(dir, f));
  }
  writeFileSync(
    join(dir, "chant.workspace.json"),
    JSON.stringify({
      name: "factory",
      schema: 1,
      records: [{ kind: "decisions/decision.kind.mjs" }, { kind: "work/work.kind.mjs" }, { kind: "answers/answer.kind.mjs" }],
      members: [{ name: "app", dir: "app", kind: "other", because: "the app" }],
    }),
  );
  mkdirSync(join(dir, "app"), { recursive: true });
  writeFileSync(join(dir, "app", "README.md"), "# app\n");
  mkdirSync(join(dir, "hooks"), { recursive: true });
  writeFileSync(join(dir, "hooks", "builder.cjs"), BUILDER);
  writeFileSync(join(dir, "hooks", "check.cjs"), CHECK);
  writeFileSync(join(dir, "work", "W-101-the-feature.md"), item("W-101", { acceptance: [{ id: "AC-1", text: "app/W-101.txt exists", verification: "unit" }] }));
  writeFileSync(join(dir, "work", "W-102-the-retried-one.md"), item("W-102", { acceptance: [{ id: "AC-1", text: "app/W-102.txt exists", verification: "unit" }] }));
  writeFileSync(join(dir, "work", "W-103-an-ask.md"), item("W-103", { state: "proposed", source: { ask: { said: "Make the page purple.", by: "alice", via: "hud" } } }));
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "the workspace"], dir);
}

async function run(dir: string, work?: string, extra: Partial<Parameters<typeof factoryOpConfig>[0]> = {}): Promise<OpRunResult> {
  const config = factoryOpConfig({ cwd: dir, backends: { systemone: { url: "http://127.0.0.1:9", timeoutMs: 200 } }, builder: `${process.execPath} hooks/builder.cjs`, check: `${process.execPath} hooks/check.cjs`, ...extra });
  const prev = process.env.FACTORY_FAIL_DIR;
  process.env.FACTORY_FAIL_DIR = dir;
  try {
    return await runOpLocally(config, activities, ACTIVITY_PROFILES, undefined, { cwd: dir, ledger: { cwd: dir }, ...(work ? { work: { item: work } } : {}) });
  } catch (err) {
    if (err instanceof OpRunFailure) return err.result;
    throw err;
  } finally {
    if (prev === undefined) delete process.env.FACTORY_FAIL_DIR;
    else process.env.FACTORY_FAIL_DIR = prev;
  }
}

const onBranch = (dir: string, id: string, path: string) => {
  const fm = parseFrontMatter(git(["show", `chant/work/${id}:${path}`], dir));
  if (!fm.ok) throw new Error(fm.message);
  return fm.value;
};

describe("the factory reference Op (#3406)", () => {
  test("builds an item from pick to done, retries a failed build only on a person's request, and drops an ask understand refuses", async () => {
    await withTestDir(async (dir) => {
      workspace(dir);
      writeFileSync(join(dir, ".fail-W-102"), "");

      // W-101: picked first, tier from slice-tier's table, built, checked, recorded done on its branch.
      const first = await run(dir);
      expect(first.workLease).toMatchObject({ item: "W-101", released: true, outcome: "done" });
      const w101 = onBranch(dir, "W-101", "work/W-101-the-feature.md");
      expect(w101).toMatchObject({ state: "done", result: { lease: first.workLease!.token } });
      expect(git(["show", "chant/work/W-101:app/W-101.txt"], dir)).toBe("built at tier small");
      const msg = git(["log", "-1", "--format=%B", "chant/work/W-101"], dir);
      expect(msg).toContain("Chant-Record: work:W-101");
      expect(msg).toContain(`Chant-Lease: ${first.workLease!.token}`);

      // W-101 waits to be applied, so W-102 is next; its builder fails, and the attempt is kept.
      const second = await run(dir);
      expect(second.workLease).toMatchObject({ item: "W-102", outcome: "not_done" });
      const failed = second.workLease!.token!;

      // Neither W-101 (built, not applied) nor W-102 (failed, no retry) is picked; W-103 is an ask,
      // and understand escalates it to people, so the run waits on the question.
      const third = await run(dir);
      expect(third.workLease).toMatchObject({ item: "W-103", outcome: "waiting" });

      // A person asks for W-102 again, naming the failed build; the next run builds it.
      const retry = await amendRecord({ kind: join(dir, "work", "work.kind.mjs"), id: "W-102", fields: JSON.stringify({ retry: { after: failed, by: "alice", at: "2026-10-03T10:00:00Z" } }), cwd: dir });
      expect("error" in retry).toBe(false);
      git(["add", "-A"], dir);
      git(["commit", "-q", "-m", "retry W-102"], dir);
      unlinkSync(join(dir, ".fail-W-102"));
      const fourth = await run(dir, "W-102");
      expect(fourth.workLease).toMatchObject({ item: "W-102", outcome: "done" });

      // The understand question about W-103 is answered refuse; the next run drops it on its branch.
      const points = await workspacePoints({ cwd: dir });
      if ("error" in points) throw new Error(points.error.message);
      const open = points.questions.find((q) => q.point === "understand" && q.open);
      expect(open).toBeDefined();
      const answered = await answerPoint({ cwd: dir, id: open!.id, answer: "refuse", by: ["alice"] });
      expect("error" in answered).toBe(false);
      git(["add", "-A"], dir);
      git(["commit", "-q", "-m", "refuse W-103"], dir);
      const fifth = await run(dir, "W-103");
      expect(fifth.workLease).toMatchObject({ item: "W-103", outcome: "dropped" });
      expect(onBranch(dir, "W-103", "work/W-103-an-ask.md")).toMatchObject({ state: "dropped" });
      expect(existsSync(join(dir, "app", "W-103.txt"))).toBe(false);
      expect(readFileSync(join(dir, "work", "W-101-the-feature.md"), "utf-8")).toContain('"state": "open"');
    });
  }, 120_000);
});

describe("the factory Op's seams for an orchestrator (studio#382)", () => {
  test("prepare runs before Pick, an uncommitted item is carried into the worktree, the reports pass through, the check ticks each criterion by its own result, and after sees the outcome", async () => {
    await withTestDir(async (dir) => {
      workspace(dir);
      // A builder that reports a run and a check that reports per criterion.
      writeFileSync(join(dir, "hooks", "builder2.cjs"), `${BUILDER}\nconsole.log(JSON.stringify({ ok: true, run: { id: "run-7" }, agent: "builder-small", chantAgent: "factory", records: ["contract:C-1"] }));\n`);
      writeFileSync(join(dir, "hooks", "check2.cjs"), `console.log(JSON.stringify({ criteria: { "AC-1": "pass", "AC-2": "fail" }, built: JSON.parse(process.env.FACTORY_BUILD).agent }));`);
      writeFileSync(join(dir, "hooks", "after.cjs"), `require("node:fs").writeFileSync(require("node:path").join(process.env.FACTORY_FAIL_DIR, "after.json"), JSON.stringify({ outcome: process.env.FACTORY_OUTCOME, commit: process.env.FACTORY_COMMIT, reason: process.env.FACTORY_REASON, check: JSON.parse(process.env.FACTORY_CHECK) }));`);
      // The prepare hook writes W-110 in the checkout and leaves it uncommitted; the others are taken out of the way.
      writeFileSync(
        join(dir, "hooks", "prepare.cjs"),
        `require("node:fs").writeFileSync("work/W-110-prepared.md", ${JSON.stringify(item("W-110", { acceptance: [{ id: "AC-1", text: "one", verification: "unit" }, { id: "AC-2", text: "two", verification: "unit" }] }))});`,
      );
      for (const id of ["W-101", "W-102"]) writeFileSync(join(dir, ".fail-" + id), "");
      git(["add", "-A"], dir);
      git(["commit", "-q", "-m", "hooks"], dir);
      const result = await run(dir, "W-110", {
        kind: "./work/work.kind.mjs",
        prepare: `${process.execPath} hooks/prepare.cjs`,
        builder: `${process.execPath} hooks/builder2.cjs`,
        check: `${process.execPath} hooks/check2.cjs`,
        after: `${process.execPath} hooks/after.cjs`,
      });
      // AC-2 failed its own check, so the item is not done, though the check exited 0.
      expect(result.workLease).toMatchObject({ item: "W-110", outcome: "not_done" });
      const after = JSON.parse(readFileSync(join(dir, "after.json"), "utf-8"));
      expect(after).toMatchObject({ outcome: "not_done", commit: "", check: { built: "builder-small" } });
      // The kept attempt holds the carried item with AC-1 ticked and AC-2 failed.
      const kept = git(["for-each-ref", "--format=%(refname)", "refs/chant/kept/"], dir).split("\n").find((r) => r.includes("W-110"))!;
      const fm = parseFrontMatter(git(["show", `${kept}:work/W-110-prepared.md`], dir));
      if (!fm.ok) throw new Error(fm.message);
      const results = Object.fromEntries((fm.value.evidence as { criterion: string; result: string }[]).map((e) => [e.criterion, e.result]));
      expect(results).toEqual({ "AC-1": "pass", "AC-2": "fail" });

      // With both criteria passing, the item is done and its commit carries the builder's run.
      writeFileSync(join(dir, "hooks", "check2.cjs"), `console.log(JSON.stringify({ criteria: { "AC-1": "pass", "AC-2": "pass" } }));`);
      git(["add", "-A"], dir);
      git(["commit", "-q", "-m", "a passing check"], dir);
      const { readLeaseHistory } = await import("../lifecycle/work-lease");
      const failed = (await readLeaseHistory("W-110", { cwd: dir })).records.filter((r) => r.event === "claim").at(-1) as { token: string };
      const amended = await amendRecord({ kind: join(dir, "work", "work.kind.mjs"), id: "W-110", fields: JSON.stringify({ retry: { after: failed.token, by: "alice" } }), cwd: dir });
      expect("error" in amended).toBe(false);
      const done = await run(dir, "W-110", { builder: `${process.execPath} hooks/builder2.cjs`, check: `${process.execPath} hooks/check2.cjs`, after: `${process.execPath} hooks/after.cjs` });
      expect(done.workLease).toMatchObject({ item: "W-110", outcome: "done" });
      const body = git(["log", "-1", "--format=%B", "chant/work/W-110"], dir);
      expect(body).toContain("Chant-Run: run-7");
      expect(body).toContain("Chant-Agent: factory");
      expect(body).toContain("Chant-Record: work:W-110\nChant-Record: contract:C-1");
      expect(JSON.parse(readFileSync(join(dir, "after.json"), "utf-8")).outcome).toBe("done");
    });
  }, 120_000);
});

