/**
 * #4644 — a merge queue: a decided attempt of a job is never replaced by a
 * later skipped or cancelled one (the push run on the commit the queue
 * landed), and `chant ci verdict` judges a group's commit as the tick would.
 */

import { afterAll, describe, expect, test } from "vitest";
import { cleanScratch, declaration, git, scratchDir, writeFiles } from "./__fixtures__/contract-repo";
import { ciVerdict, evaluateCommit, latestAttempts } from "./ci-green";
import type { CheckRun, CiForge } from "./ci-green-forge";
import { parseDeclaration } from "./declaration";

afterAll(cleanScratch);

const run = (id: number, name: string, conclusion: string | null, status = "completed"): CheckRun => ({ id, name, status, conclusion: status === "completed" ? conclusion : null, completedAt: null, url: null });

describe("a job's attempts on one commit (#4644)", () => {
  test("a later skipped or cancelled attempt doesn't replace a decided one, and a later decided one does", () => {
    expect(latestAttempts([run(1, "test", "success"), run(2, "test", "skipped")]).map((r) => r.id)).toEqual([1]);
    expect(latestAttempts([run(1, "test", "failure"), run(2, "test", "cancelled")]).map((r) => r.id)).toEqual([1]);
    expect(latestAttempts([run(2, "test", "cancelled"), run(1, "test", "success")]).map((r) => r.id)).toEqual([1]);
    expect(latestAttempts([run(1, "test", "success"), run(2, "test", "failure")]).map((r) => r.id)).toEqual([2]);
    expect(latestAttempts([run(1, "test", "skipped"), run(2, "test", "success")]).map((r) => r.id)).toEqual([2]);
    // With nothing decided the latest still wins, and a run in progress replaces a decided one, as a re-run does.
    expect(latestAttempts([run(1, "test", "skipped"), run(2, "test", "cancelled")]).map((r) => r.id)).toEqual([2]);
    expect(latestAttempts([run(1, "test", "failure"), run(2, "test", null, "in_progress")]).map((r) => r.id)).toEqual([2]);
  });

  test("the group's run decides the commit the queue landed, whatever the push run did after", () => {
    const green = parseDeclaration(JSON.stringify({ name: "w", schema: 1, members: [], ci: { green: { branch: "main", phases: { test: { runs: ["test"], build: "newest" } }, require: ["test"] } } }), "chant.workspace.json").ci!.green!;
    // The group's test passed; main's push run on the same commit was cancelled by a newer push.
    expect(evaluateCommit(green, [run(1, "test", "success"), run(2, "test", "cancelled")]).verdict).toBe("pass");
  });
});

describe("chant ci verdict (#4644)", () => {
  function workspace(): string {
    const root = scratchDir("chant-verdict-");
    git(root, "init", "-q");
    writeFiles(root, { "chant.workspace.json": declaration([], { ci: { green: { branch: "main", phases: { lint: ["lint"], test: ["test"] }, require: ["lint", "test"], mergeQueue: true } } }) });
    return root;
  }
  const forgeOf = (answers: CheckRun[][]): CiForge & { reads: number } => {
    const f = { kind: "github" as const, reads: 0, checkRuns: async () => answers[Math.min(f.reads++, answers.length - 1)]! };
    return f;
  };

  test("waits while a phase is pending, then passes; its own check run doesn't count", async () => {
    const root = workspace();
    const forge = forgeOf([
      [run(1, "lint", "success"), run(2, "test", null, "in_progress"), run(9, "chant-verdict", null, "in_progress")],
      [run(1, "lint", "success"), run(2, "test", "success"), run(9, "chant-verdict", null, "in_progress")],
    ]);
    const pending: string[][] = [];
    const out = await ciVerdict({ cwd: root, sha: "a".repeat(40), forge, wait: true, sleep: async () => {}, onPending: (v) => pending.push(v.phases.filter((p) => p.verdict === "pending").map((p) => p.phase)) });
    expect(out.verdict.verdict).toBe("pass");
    expect(pending).toEqual([["test"]]);
    expect(forge.reads).toBe(2);
  });

  test("fails on a failed phase, and without --wait answers pending at once", async () => {
    const root = workspace();
    expect((await ciVerdict({ cwd: root, sha: "b".repeat(40), forge: forgeOf([[run(1, "lint", "success"), run(2, "test", "failure")]]), wait: true, sleep: async () => {} })).verdict).toMatchObject({ verdict: "fail", failure: { phase: "test" } });
    expect((await ciVerdict({ cwd: root, sha: "c".repeat(40), forge: forgeOf([[run(1, "lint", "success")]]) })).verdict.verdict).toBe("pending");
  });
});
