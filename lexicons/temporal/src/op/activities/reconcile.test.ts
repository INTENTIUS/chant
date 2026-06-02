import { describe, test, expect } from "vitest";
import { reconcilePr, reconcileSummary, reconcileBranchName, entriesFromPlan } from "./reconcile";

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
