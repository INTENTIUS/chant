/**
 * #4636: `pr-apply --before-merge --merge auto` merges the pull request once
 * its update applied and the records are pushed, with the head checked
 * again, on fake GitHub, GitLab and Forgejo forges. A refusal is posted and
 * never applies again.
 */

import { describe, expect, test } from "vitest";
import { parseArgs } from "./cli/parse-args";
import { prLoopJobs } from "./components/pr-pipeline";
import { ciLoopOptions } from "./workspace/ci-run";
import { mergeAfterApply, mergeTokenEnv, prMergeMarker } from "./pr-merge";
import type { MergeOptions, MergeResult, PullRequestHead } from "./pr-forge";

const HEAD = "a".repeat(40);

function fakeForge(kind: "github" | "gitlab" | "forgejo", o: { head?: PullRequestHead; merge?: MergeResult | Error } = {}) {
  const merges: Array<{ pr: number; opts: MergeOptions }> = [];
  const comments: Array<{ pr: number; marker: string; body: string }> = [];
  const forge = {
    kind,
    async pullRequestHead() {
      return o.head ?? { sha: HEAD, branch: "feature", open: true, sameRepo: true };
    },
    async mergePullRequest(pr: number, opts: MergeOptions) {
      merges.push({ pr, opts });
      if (o.merge instanceof Error) throw o.merge;
      return o.merge ?? { merged: true, sha: "b".repeat(40) };
    },
    async upsertComment(pr: number, marker: string, body: string) {
      comments.push({ pr, marker, body });
      return { action: "created" as const, id: 1 };
    },
  };
  return { forge, merges, comments };
}

const pushed = { pushed: true };

describe("the merge after an update before merge (#4636)", () => {
  for (const kind of ["github", "gitlab", "forgejo"] as const) {
    test(`merges only the head that applied, once the records are pushed (${kind})`, async () => {
      const { forge, merges, comments } = fakeForge(kind);
      expect(await mergeAfterApply({ forge, pr: 7, head: HEAD, method: "squash", recorded: pushed })).toEqual({ merged: true, sha: "b".repeat(40) });
      expect(merges).toEqual([{ pr: 7, opts: { sha: HEAD, method: "squash" } }]);
      expect(comments).toEqual([]);
    });

    test(`a refused merge posts the reason and is never retried (${kind})`, async () => {
      const { forge, merges, comments } = fakeForge(kind, { merge: { merged: false, reason: 'Required status check "ci" is expected' } });
      const r = await mergeAfterApply({ forge, pr: 7, head: HEAD, recorded: pushed });
      expect(r).toMatchObject({ merged: false, posted: true, reason: expect.stringContaining("Required status check") });
      expect(merges).toHaveLength(1);
      expect(comments[0]).toMatchObject({ pr: 7, marker: prMergeMarker(7) });
      expect(comments[0]!.body).toContain("stays applied and recorded; it is never applied again to merge");
    });
  }

  test("a new push since the apply, a closed pull request, or records that did not land stop the merge before it is asked", async () => {
    const moved = fakeForge("github", { head: { sha: "c".repeat(40), branch: "feature", open: true, sameRepo: true } });
    expect(await mergeAfterApply({ forge: moved.forge, pr: 7, head: HEAD, recorded: pushed })).toMatchObject({ merged: false, reason: expect.stringContaining("not aaaaaaaaaaaa, the commit that applied") });
    expect(moved.merges).toEqual([]);
    const closed = fakeForge("forgejo", { head: { sha: HEAD, branch: "feature", open: false, sameRepo: true } });
    expect((await mergeAfterApply({ forge: closed.forge, pr: 7, head: HEAD, recorded: pushed })).reason).toBe("it is no longer open");
    const unpushed = fakeForge("gitlab");
    const r = await mergeAfterApply({ forge: unpushed.forge, pr: 7, head: HEAD, recorded: { pushed: false, warning: "chant/lifecycle has no remote" } });
    expect(r.reason).toContain("records are not on the ledger's remote (chant/lifecycle has no remote)");
    expect(unpushed.merges).toEqual([]);
    expect(unpushed.comments[0]!.body).toContain("Merge request !7 was not merged");
  });

  test("a forge error is a refusal, posted", async () => {
    const { forge, comments } = fakeForge("github", { merge: new Error("500 Internal Server Error") });
    expect(await mergeAfterApply({ forge, pr: 7, head: HEAD, recorded: pushed })).toMatchObject({ merged: false, posted: true });
    expect(comments).toHaveLength(1);
  });

  test("the merge client holds the named token and no other", () => {
    const env = mergeTokenEnv("PLYWOOD_MERGE_TOKEN", { GITHUB_TOKEN: "job", CHANT_FORGE_TOKEN: "plan", PLYWOOD_MERGE_TOKEN: "merge", GITHUB_REPOSITORY: "acme/infra" });
    expect(env).toEqual({ CHANT_FORGE_TOKEN: "merge", PLYWOOD_MERGE_TOKEN: "merge", GITHUB_REPOSITORY: "acme/infra" });
    expect(mergeTokenEnv("PLYWOOD_MERGE_TOKEN", {})).toEqual({ error: expect.stringContaining("not set") });
  });
});

describe("the pipeline carries --merge auto (#4636)", () => {
  test("the apply before merge job runs with the merge flags and maps the secret on GitHub", () => {
    const [, apply] = prLoopJobs("github", "prod", { applyBeforeMerge: true, applyMerge: { tokenEnv: "PLYWOOD_MERGE_TOKEN", method: "squash" } });
    expect(apply!.command).toContain("pr-apply --before-merge --merge auto --merge-token-env PLYWOOD_MERGE_TOKEN --merge-method squash");
    expect(apply!.run.command).toContain("--apply-before-merge --merge auto --merge-token-env PLYWOOD_MERGE_TOKEN --merge-method squash");
    expect(apply!.env.PLYWOOD_MERGE_TOKEN).toBe("${{ secrets.PLYWOOD_MERGE_TOKEN }}");
    const [, gitlab] = prLoopJobs("gitlab", "prod", { applyBeforeMerge: true, applyMerge: { tokenEnv: "PLYWOOD_MERGE_TOKEN" } });
    expect(gitlab!.env.PLYWOOD_MERGE_TOKEN).toBeUndefined();
    expect(() => prLoopJobs("github", "prod", { applyMerge: { tokenEnv: "X" } })).toThrow(/apply-before-merge/);
  });

  test("chant ci run apply passes the flags on to pr-apply", () => {
    const args = parseArgs(["ci", "run", "apply", "--apply-before-merge", "--merge", "auto", "--merge-token-env", "PLYWOOD_MERGE_TOKEN"]);
    expect(ciLoopOptions(args).applyMerge).toEqual({ tokenEnv: "PLYWOOD_MERGE_TOKEN" });
  });
});
