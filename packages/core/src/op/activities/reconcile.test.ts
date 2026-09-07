import { describe, test, expect, vi } from "vitest";
import {
  reconcilePr,
  reconcileSummary,
  reconcileBranchName,
  entriesFromPlan,
  commentMarker,
  pullRequestContextFrom,
} from "./reconcile";

const entries = [
  { name: "bucket", action: "adopt", type: "AWS::S3::Bucket" },
  { name: "queue", action: "update", type: "AWS::SQS::Queue" },
];

describe("reconcileBranchName (#122)", () => {
  test("deterministic, slugified per env", () => {
    expect(reconcileBranchName("prod")).toBe("chant/reconcile-prod");
    expect(reconcileBranchName("us-east/1")).toBe("chant/reconcile-us-east-1");
  });
});

describe("reconcileSummary (#122)", () => {
  test("summarizes which entries triggered the reconcile", () => {
    const body = reconcileSummary("prod", entries);
    expect(body).toContain("live environment `prod`");
    expect(body).toContain("| bucket | adopt | AWS::S3::Bucket |");
    expect(body).toContain("| queue | update | AWS::SQS::Queue |");
  });

  test("handles an empty entry set", () => {
    expect(reconcileSummary("prod", [])).toContain("_(none)_");
  });
});

describe("entriesFromPlan (#123)", () => {
  test("maps a ChangeSet, dropping noop entries", () => {
    const plan = JSON.stringify({
      env: "prod",
      entries: [
        { name: "a", action: "create", type: "T1", evidence: {}, ownership: "unknown" },
        { name: "b", action: "noop", type: "T2", evidence: {}, ownership: "unknown" },
        { name: "c", action: "delete", type: "T3", evidence: {}, ownership: "owned" },
      ],
    });
    expect(entriesFromPlan(plan)).toEqual([
      { name: "a", action: "create", type: "T1" },
      { name: "c", action: "delete", type: "T3" },
    ]);
  });

  test("tolerates an empty / entry-less plan", () => {
    expect(entriesFromPlan(JSON.stringify({ env: "prod" }))).toEqual([]);
  });
});

describe("reconcilePr report mode (#122)", () => {
  test("returns the summary without any git/network IO", async () => {
    const result = await reconcilePr({ env: "prod", entries, mode: "report" });
    expect(result.mode).toBe("report");
    expect(result.prUrl).toBeUndefined();
    expect(result.branch).toBeUndefined();
    expect(result.summary).toContain("| bucket | adopt | AWS::S3::Bucket |");
    expect(result.entries).toEqual(entries);
  });
});

describe("reconcilePr pre-built body (#2087)", () => {
  test("a caller-supplied body is used verbatim, in place of the change-set table", async () => {
    const plan = "Terraform will perform the following actions:\n\n  # null_resource.first will be created";
    const result = await reconcilePr({ env: "app", mode: "report", body: plan });
    expect(result.summary).toBe(plan);
    expect(result.summary).not.toContain("| Entry | Action | Type |");
  });

  test("supplying a body derives no plan, so nothing shells to `chant lifecycle plan`", async () => {
    // No `entries`, no mock, no network: if the derivation still ran this
    // would spawn `chant lifecycle plan --json` and reject.
    const result = await reconcilePr({ env: "app", mode: "report", body: "drift" });
    expect(result.entries).toEqual([]);
  });

  test("explicit entries still ride alongside a supplied body", async () => {
    const result = await reconcilePr({ env: "prod", mode: "report", entries, body: "drift" });
    expect(result.summary).toBe("drift");
    expect(result.entries).toEqual(entries);
  });
});

describe("reconcilePr comment mode: the marker (#2231)", () => {
  test("the marker is deterministic per env, so a re-run finds its own comment", () => {
    expect(commentMarker("app")).toBe("<!-- chant-reconcile:app -->");
    expect(commentMarker("app")).toBe(commentMarker("app"));
    expect(commentMarker("app")).not.toBe(commentMarker("db"));
  });

  test("the marker slugifies the env, so nothing it is interpolated next to can be escaped out of", () => {
    // The marker is interpolated into a jq `startswith("…")` string and into a
    // shell word. A quote or a backslash surviving into it would break both.
    const marker = commentMarker('us-east/1" or true; #');
    expect(marker).toBe("<!-- chant-reconcile:us-east-1-or-true- -->");
    expect(marker).not.toMatch(/["'\\]/);
  });
});

describe("pullRequestContextFrom (#2231)", () => {
  const repo = "INTENTIUS/chant";

  test("reads the number off a pull_request event payload", () => {
    expect(pullRequestContextFrom({ GITHUB_REPOSITORY: repo }, { number: 2231 })).toEqual({
      repo,
      number: 2231,
    });
  });

  test("accepts the nested pull_request.number the same payload also carries", () => {
    expect(
      pullRequestContextFrom({ GITHUB_REPOSITORY: repo }, { pull_request: { number: 7 } }),
    ).toEqual({ repo, number: 7 });
  });

  test("falls back to GITHUB_REF when the payload is unreadable", () => {
    expect(
      pullRequestContextFrom({ GITHUB_REPOSITORY: repo, GITHUB_REF: "refs/pull/42/merge" }),
    ).toEqual({ repo, number: 42 });
  });

  test("a push run has no pull request", () => {
    expect(
      pullRequestContextFrom(
        { GITHUB_REPOSITORY: repo, GITHUB_REF: "refs/heads/main" },
        { ref: "refs/heads/main", after: "abc" },
      ),
    ).toBeUndefined();
  });

  test("a cron run off any forge has neither variable", () => {
    expect(pullRequestContextFrom({})).toBeUndefined();
    expect(pullRequestContextFrom({ GITHUB_REF: "refs/pull/1/merge" })).toBeUndefined();
  });
});

describe("reconcilePr comment mode refuses a run with no pull request (#2231)", () => {
  test("the message names the mode and every variable it looked for", async () => {
    vi.stubEnv("GITHUB_REPOSITORY", "");
    vi.stubEnv("GITHUB_REF", "");
    vi.stubEnv("GITHUB_EVENT_PATH", "");
    try {
      // No `gh` is ever reached: the context check runs first, so a failure
      // here is the refusal rather than a missing binary.
      await expect(reconcilePr({ env: "app", mode: "comment", body: "plan" })).rejects.toThrow(
        /mode "comment".*GITHUB_REPOSITORY.*GITHUB_EVENT_PATH.*GITHUB_REF/s,
      );
      await expect(reconcilePr({ env: "app", mode: "comment", body: "plan" })).rejects.toThrow(
        /findingMode "issue" or "report"/,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
