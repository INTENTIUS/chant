import { describe, test, expect } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  appendGateResolution, appendPendingGate, readGateResolutions, readGateLedger,
  latestResolutionSince, latestPendingGate, isPendingGateExpired,
  resolveApprovalUrl, isApprovalUrl, latestResolutionForPlan, parseGateLedger,
  type PendingGateRecord, type GateResolutionRecord,
} from "./gate-ledger";
import { readBlobFromPath, writeBlobToPath } from "./git";

function git(args: string[], cwd: string): { stdout: string; exitCode: number } {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  return { stdout: r.stdout ?? "", exitCode: r.status ?? -1 };
}

async function initRepo(dir: string): Promise<void> {
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "test@chant.dev"], dir);
  git(["config", "user.name", "Test"], dir);
  writeFileSync(join(dir, "README.md"), "fixture\n");
  git(["add", "README.md"], dir);
  git(["commit", "-q", "-m", "init"], dir);
}

describe("lifecycle/gate-ledger", () => {
  test("appendGateResolution + readGateResolutions round-trip", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      const { record } = await appendGateResolution(
        { op: "fountain-apply", gate: "rollout-gate", resolvedBy: "alex", timestamp: "2026-01-01T00:00:00.000Z" },
        { cwd: dir },
      );
      expect(record.version).toBe(1);

      const { records, malformed } = await readGateResolutions("fountain-apply", { cwd: dir });
      expect(malformed).toBe(0);
      expect(records).toEqual([record]);
    });
  });

  test("stores under a global _gates namespace, keyed by op — not per-environment", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      await appendGateResolution(
        { op: "fountain-apply", gate: "rollout-gate", resolvedBy: "alex", timestamp: "2026-01-01T00:00:00.000Z" },
        { cwd: dir },
      );
      const raw = await readBlobFromPath("_gates", "fountain-apply.jsonl", { cwd: dir });
      expect(raw).toContain("rollout-gate");
    });
  });

  test("readGateResolutions returns [] for an op with no resolutions yet", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      expect(await readGateResolutions("no-such-op", { cwd: dir })).toEqual({ records: [], malformed: 0 });
    });
  });

  test("appends without clobbering — multiple gates/resolutions on the same op accumulate", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      await appendGateResolution(
        { op: "fountain-apply", gate: "rollout-gate", resolvedBy: "alex", timestamp: "2026-01-01T00:00:00.000Z" },
        { cwd: dir },
      );
      await appendGateResolution(
        { op: "fountain-apply", gate: "prod-gate", resolvedBy: "sam", timestamp: "2026-01-02T00:00:00.000Z", note: "https://github.com/x/y/pull/1" },
        { cwd: dir },
      );
      const { records } = await readGateResolutions("fountain-apply", { cwd: dir });
      expect(records.map((r) => r.gate)).toEqual(["rollout-gate", "prod-gate"]);
      expect(records[1].note).toBe("https://github.com/x/y/pull/1");
    });
  });

  describe("latestResolutionSince", () => {
    test("finds a resolution recorded after the gated tick's own timestamp", () => {
      const records = [
        { version: 1 as const, op: "x", gate: "g1", resolvedBy: "a", timestamp: "2026-01-01T00:00:00.000Z" },
        { version: 1 as const, op: "x", gate: "g1", resolvedBy: "b", timestamp: "2026-01-03T00:00:00.000Z" },
      ];
      const found = latestResolutionSince(records, "g1", "2026-01-02T00:00:00.000Z");
      expect(found?.resolvedBy).toBe("b");
    });

    test("returns undefined when the only resolution predates the gated tick (a stale, superseded approval)", () => {
      const records = [
        { version: 1 as const, op: "x", gate: "g1", resolvedBy: "a", timestamp: "2026-01-01T00:00:00.000Z" },
      ];
      expect(latestResolutionSince(records, "g1", "2026-01-02T00:00:00.000Z")).toBeUndefined();
    });

    test("ignores resolutions for a different gate", () => {
      const records = [
        { version: 1 as const, op: "x", gate: "other-gate", resolvedBy: "a", timestamp: "2026-01-05T00:00:00.000Z" },
      ];
      expect(latestResolutionSince(records, "g1", "2026-01-01T00:00:00.000Z")).toBeUndefined();
    });

    test("undefined when there are no resolutions at all", () => {
      expect(latestResolutionSince([], "g1", "2026-01-01T00:00:00.000Z")).toBeUndefined();
    });
  });
  // ── Gate-as-fact carries an address (#2028) ──────────────────────────────

  describe("resolveApprovalUrl", () => {
    test("a GitHub Actions pull_request run resolves to that PR", () => {
      expect(resolveApprovalUrl({
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_REPOSITORY: "INTENTIUS/chant",
        GITHUB_REF_NAME: "2028/merge",
      })).toBe("https://github.com/INTENTIUS/chant/pull/2028");
    });

    test("honours a GitHub Enterprise server url, trailing slash and all", () => {
      expect(resolveApprovalUrl({
        GITHUB_SERVER_URL: "https://ghe.example.com/",
        GITHUB_REPOSITORY: "org/repo",
        GITHUB_REF_NAME: "7/head",
      })).toBe("https://ghe.example.com/org/repo/pull/7");
    });

    test("a GitLab merge-request pipeline resolves to that MR", () => {
      expect(resolveApprovalUrl({
        CI_MERGE_REQUEST_PROJECT_URL: "https://gitlab.com/org/repo",
        CI_MERGE_REQUEST_IID: "42",
      })).toBe("https://gitlab.com/org/repo/-/merge_requests/42");
    });

    test("a push-event CI run, or no CI at all, has no address — undefined, never a guess", () => {
      expect(resolveApprovalUrl({ GITHUB_REPOSITORY: "org/repo", GITHUB_REF_NAME: "main" })).toBeUndefined();
      expect(resolveApprovalUrl({ GITHUB_REF_NAME: "3/merge" })).toBeUndefined();
      expect(resolveApprovalUrl({ CI_MERGE_REQUEST_PROJECT_URL: "https://gitlab.com/org/repo" })).toBeUndefined();
      expect(resolveApprovalUrl({})).toBeUndefined();
    });
  });

  describe("isApprovalUrl", () => {
    test("accepts absolute http/https", () => {
      expect(isApprovalUrl("https://github.com/org/repo/pull/1")).toBe(true);
      expect(isApprovalUrl("http://localhost:3000/pr/1")).toBe(true);
    });

    test("refuses anything a reader could not follow as a link", () => {
      for (const bad of ["", "org/repo/pull/1", "/pull/1", "file:///etc/passwd", "javascript:alert(1)", "not a url"]) {
        expect(isApprovalUrl(bad)).toBe(false);
      }
    });
  });

  test("a resolution round-trips its typed url alongside free-text note", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      const { record } = await appendGateResolution(
        {
          op: "fountain-apply",
          gate: "rollout-gate",
          resolvedBy: "alex",
          timestamp: "2026-01-01T00:00:00.000Z",
          note: "rolled staging first",
          url: "https://github.com/INTENTIUS/chant/pull/2028",
        },
        { cwd: dir },
      );
      const { records } = await readGateResolutions("fountain-apply", { cwd: dir });
      expect(records).toEqual([record]);
      expect(records[0].url).toBe("https://github.com/INTENTIUS/chant/pull/2028");
      expect(records[0].note).toBe("rolled staging first");
    });
  });

  test("a pre-#2028 resolution with no url still reads", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      await appendGateResolution(
        { op: "fountain-apply", gate: "g", resolvedBy: "alex", timestamp: "2026-01-01T00:00:00.000Z" },
        { cwd: dir },
      );
      const { records, malformed } = await readGateResolutions("fountain-apply", { cwd: dir });
      expect(malformed).toBe(0);
      expect(records[0].url).toBeUndefined();
    });
  });
});

describe("lifecycle/gate-ledger — pending facts (#2119)", () => {
  test("pending facts and resolutions share the file and read back separately", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      const { record: pending } = await appendPendingGate(
        {
          op: "fountain-apply", gate: "rollout-gate",
          description: "release manager signs off",
          runId: "local-1",
          timestamp: "2026-01-01T00:00:00.000Z",
          expiresAt: "2026-01-03T00:00:00.000Z",
        },
        { cwd: dir },
      );
      await appendGateResolution(
        { op: "fountain-apply", gate: "rollout-gate", resolvedBy: "alex", timestamp: "2026-01-02T00:00:00.000Z" },
        { cwd: dir },
      );

      const { resolutions, pending: pendings, malformed } = await readGateLedger("fountain-apply", { cwd: dir });
      expect(malformed).toBe(0);
      expect(pendings).toEqual([pending]);
      expect(resolutions.map((r) => r.resolvedBy)).toEqual(["alex"]);

      // A pending line is not a malformed resolution to the narrow reader.
      const narrow = await readGateResolutions("fountain-apply", { cwd: dir });
      expect(narrow.malformed).toBe(0);
      expect(narrow.records).toHaveLength(1);
    });
  });

  test("latestPendingGate picks the newest fact for the gate, expired or not", () => {
    const at = (timestamp: string, gate = "g"): PendingGateRecord => ({
      version: 1, kind: "pending", op: "o", gate, timestamp,
      expiresAt: "2026-01-09T00:00:00.000Z",
    });
    const records = [at("2026-01-01T00:00:00.000Z"), at("2026-01-05T00:00:00.000Z"), at("2026-01-07T00:00:00.000Z", "other")];
    expect(latestPendingGate(records, "g")?.timestamp).toBe("2026-01-05T00:00:00.000Z");
    expect(latestPendingGate(records, "absent")).toBeUndefined();
  });

  test("isPendingGateExpired is true at and after expiresAt", () => {
    const record: PendingGateRecord = {
      version: 1, kind: "pending", op: "o", gate: "g",
      timestamp: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-03T00:00:00.000Z",
    };
    expect(isPendingGateExpired(record, "2026-01-02T23:59:59.000Z")).toBe(false);
    expect(isPendingGateExpired(record, "2026-01-03T00:00:00.000Z")).toBe(true);
    expect(isPendingGateExpired(record, "2026-01-04T00:00:00.000Z")).toBe(true);
  });

  test("a pending line missing expiresAt is malformed, not read as a resolution", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      await writeBlobToPath(
        "_gates", "fountain-apply.jsonl",
        JSON.stringify({ version: 1, kind: "pending", op: "fountain-apply", gate: "g", timestamp: "2026-01-01T00:00:00.000Z" }),
        "hand-written",
        { cwd: dir },
      );
      const { resolutions, pending, malformed } = await readGateLedger("fountain-apply", { cwd: dir });
      expect(malformed).toBe(1);
      expect(pending).toEqual([]);
      expect(resolutions).toEqual([]);
    });
  });

  // #2574: an environment that is present but not a string would read as an
  // approval bound to no environment, which a component gate treats differently.
  test("a line whose environment is not a string is malformed", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      await writeBlobToPath(
        "_gates", "search-service.jsonl",
        [
          JSON.stringify({ version: 1, op: "search-service", gate: "g", resolvedBy: "alex", timestamp: "2026-01-01T00:00:00.000Z", environment: 7 }),
          JSON.stringify({ version: 1, op: "search-service", gate: "g", resolvedBy: "alex", timestamp: "2026-01-01T00:00:00.000Z", environment: "prod" }),
        ].join("\n"),
        "hand-written",
        { cwd: dir },
      );
      const { resolutions, malformed } = await readGateLedger("search-service", { cwd: dir });
      expect(malformed).toBe(1);
      expect(resolutions.map((r) => r.environment)).toEqual(["prod"]);
    });
  });
});

/**
 * #2300. `latestResolutionSince` asks "is there a newer approval", which a run
 * answers yes to however much has changed since it was written. That is the
 * rule INTENTIUS/choudoufu#1026 measured applying a renamed resource without
 * complaint. `latestResolutionForPlan` asks "is there an approval of *this*",
 * with recency demoted from the criterion to the tiebreak.
 */
describe("latestResolutionForPlan (#2300)", () => {
  const EPOCH = new Date(0).toISOString();
  const PLAN_A = `sha256:${"a".repeat(64)}`;
  const PLAN_B = `sha256:${"b".repeat(64)}`;

  const resolution = (over: Partial<GateResolutionRecord>): GateResolutionRecord => ({
    version: 1, op: "live-apply", gate: "approve-live-apply", resolvedBy: "alex",
    timestamp: "2026-01-02T00:00:00.000Z", ...over,
  });

  test("a resolution for this plan answers the gate", () => {
    const found = latestResolutionForPlan([resolution({ planDigest: PLAN_A })], "approve-live-apply", EPOCH, PLAN_A);
    expect(found.resolution?.resolvedBy).toBe("alex");
    expect(found.mismatched).toBeUndefined();
  });

  // #2547: plan digests carry a version prefix now. An approval written under
  // the bare prefix is still an approval of the same plan.
  test("a resolution recorded under the bare sha256: prefix answers the same plan's jcs1 digest", () => {
    const found = latestResolutionForPlan([resolution({ planDigest: PLAN_A })], "approve-live-apply", EPOCH, `jcs1-${PLAN_A}`);
    expect(found.resolution?.resolvedBy).toBe("alex");
    expect(found.mismatched).toBeUndefined();
  });

  test("the prefix never makes a different plan match", () => {
    const found = latestResolutionForPlan([resolution({ planDigest: PLAN_B })], "approve-live-apply", EPOCH, `jcs1-${PLAN_A}`);
    expect(found.resolution).toBeUndefined();
    expect(found.mismatched?.planDigest).toBe(PLAN_B);
  });

  test("a resolution for another plan does not, and comes back named", () => {
    const found = latestResolutionForPlan([resolution({ planDigest: PLAN_B })], "approve-live-apply", EPOCH, PLAN_A);
    expect(found.resolution).toBeUndefined();
    expect(found.mismatched?.planDigest).toBe(PLAN_B);
  });

  // The migration, and the safe reading of it: a record with no digest proves
  // someone approved something, and nothing about what.
  test("a resolution written before #2300 never matches a plan-bound gate", () => {
    const found = latestResolutionForPlan([resolution({})], "approve-live-apply", EPOCH, PLAN_A);
    expect(found.resolution).toBeUndefined();
    expect(found.mismatched).toBeDefined();
    expect(found.mismatched?.planDigest).toBeUndefined();
  });

  // Recency is the tiebreak, not the criterion: a newer approval of the wrong
  // plan does not shadow an older approval of the right one.
  test("an older resolution for this plan beats a newer one for another", () => {
    const found = latestResolutionForPlan(
      [
        resolution({ planDigest: PLAN_A, resolvedBy: "right", timestamp: "2026-01-02T00:00:00.000Z" }),
        resolution({ planDigest: PLAN_B, resolvedBy: "wrong", timestamp: "2026-01-09T00:00:00.000Z" }),
      ],
      "approve-live-apply", EPOCH, PLAN_A,
    );
    expect(found.resolution?.resolvedBy).toBe("right");
  });

  test("among several for this plan, the newest wins", () => {
    const found = latestResolutionForPlan(
      [
        resolution({ planDigest: PLAN_A, resolvedBy: "first", timestamp: "2026-01-02T00:00:00.000Z" }),
        resolution({ planDigest: PLAN_A, resolvedBy: "second", timestamp: "2026-01-03T00:00:00.000Z" }),
      ],
      "approve-live-apply", EPOCH, PLAN_A,
    );
    expect(found.resolution?.resolvedBy).toBe("second");
  });

  test("the staleness rule still applies — a resolution older than the pending fact is no answer to it", () => {
    const found = latestResolutionForPlan(
      [resolution({ planDigest: PLAN_A, timestamp: "2026-01-01T00:00:00.000Z" })],
      "approve-live-apply", "2026-01-05T00:00:00.000Z", PLAN_A,
    );
    expect(found.resolution).toBeUndefined();
    expect(found.mismatched).toBeUndefined();
  });

  test("a gate that binds no plan decides exactly as latestResolutionSince does", () => {
    const records = [resolution({}), resolution({ resolvedBy: "newer", timestamp: "2026-01-04T00:00:00.000Z" })];
    expect(latestResolutionForPlan(records, "approve-live-apply", EPOCH, undefined).resolution?.resolvedBy)
      .toBe(latestResolutionSince(records, "approve-live-apply", EPOCH)?.resolvedBy);
  });

  test("another gate's resolutions are not read as this one's", () => {
    const found = latestResolutionForPlan(
      [resolution({ gate: "approve-live-adopt", planDigest: PLAN_A })],
      "approve-live-apply", EPOCH, PLAN_A,
    );
    expect(found.resolution).toBeUndefined();
    expect(found.mismatched).toBeUndefined();
  });
});

/**
 * A `planDigest` that is present but not a string is a malformed line, not a
 * line with a field to ignore (#2300) — ignoring it would demote a plan-bound
 * record to a digest-less one, which is the shape a plan-bound gate refuses.
 */
describe("readGateLedger — a corrupted planDigest is malformed (#2300)", () => {
  test("a non-string planDigest is counted, not read as an approval of nothing", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      await writeBlobToPath(
        "_gates", "live-apply.jsonl",
        JSON.stringify({
          version: 1, op: "live-apply", gate: "g", resolvedBy: "alex",
          timestamp: "2026-01-01T00:00:00.000Z", planDigest: { sha: "…" },
        }),
        "hand-written",
        { cwd: dir },
      );
      const { resolutions, malformed } = await readGateLedger("live-apply", { cwd: dir });
      expect(malformed).toBe(1);
      expect(resolutions).toEqual([]);
    });
  });

  test("a string planDigest round-trips onto both kinds of record", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      const digest = `sha256:${"a".repeat(64)}`;
      await appendPendingGate(
        { op: "live-apply", gate: "g", timestamp: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-03T00:00:00.000Z", planDigest: digest },
        { cwd: dir },
      );
      await appendGateResolution(
        { op: "live-apply", gate: "g", resolvedBy: "alex", timestamp: "2026-01-02T00:00:00.000Z", planDigest: digest },
        { cwd: dir },
      );
      const { resolutions, pending, malformed } = await readGateLedger("live-apply", { cwd: dir });
      expect(malformed).toBe(0);
      expect(pending[0].planDigest).toBe(digest);
      expect(resolutions[0].planDigest).toBe(digest);
    });
  });
});

describe("applied approvals on chant/lifecycle (#3784)", () => {
  test("the git port appends and reads _gates/<op>/applied.jsonl, which the gate ledger reader never sees", async () => {
    const { gitGateLedgerPort } = await import("../op/gate");
    await withTestDir(async (dir) => {
      await initRepo(dir);
      const port = gitGateLedgerPort({ cwd: dir });
      await appendGateResolution({ op: "migrations", gate: "migrations-wave-1", resolvedBy: "alice", timestamp: "2026-10-10T00:00:00.000Z", planDigest: "sha256:aa" }, { cwd: dir });
      const line = {
        version: 1 as const, kind: "applied" as const, op: "migrations", gate: "migrations-wave-1", planDigest: "sha256:aa",
        approvedAt: "2026-10-10T00:00:00.000Z", approvedBy: "alice", timestamp: "2026-10-11T00:00:00.000Z",
      };
      await port.appendApplied!(line);
      await port.appendApplied!({ ...line, timestamp: "2026-10-11T01:00:00.000Z" });
      expect(await port.readApplied!("migrations")).toEqual([line, { ...line, timestamp: "2026-10-11T01:00:00.000Z" }]);
      expect(await readBlobFromPath("_gates/migrations", "applied.jsonl", { cwd: dir })).toMatch(/^\{.*\}\n\{.*\}\n$/);
      const ledger = await port.read("migrations");
      expect(ledger.resolutions).toHaveLength(1);
      expect(ledger.pending).toHaveLength(0);
    });
  });
});

describe("gate ledger newline termination (#3849)", () => {
  test("every append ends the file in a newline, with no blank or merged lines", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      await appendPendingGate(
        {
          op: "nl-op", gate: "g1", planDigest: "sha256:" + "a".repeat(64),
          timestamp: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-08T00:00:00.000Z",
        },
        { cwd: dir },
      );
      const one = await readBlobFromPath("_gates", "nl-op.jsonl", { cwd: dir });
      expect(one!.endsWith("\n")).toBe(true);
      await appendGateResolution(
        { op: "nl-op", gate: "g1", resolvedBy: "alex", timestamp: "2026-01-01T00:00:00.000Z" },
        { cwd: dir },
      );
      const raw = (await readBlobFromPath("_gates", "nl-op.jsonl", { cwd: dir }))!;
      expect(raw.endsWith("\n")).toBe(true);
      expect(raw.endsWith("\n\n")).toBe(false);
      const lines = raw.slice(0, -1).split("\n");
      expect(lines).toHaveLength(2);
      for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
      const { malformed } = await readGateLedger("nl-op", { cwd: dir });
      expect(malformed).toBe(0);
    });
  });

  test("a legacy ledger whose last line has no newline still reads and appends cleanly", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      await writeBlobToPath("_gates", "legacy.jsonl", JSON.stringify({ kind: "x" }), "seed", { cwd: dir });
      await appendGateResolution(
        { op: "legacy", gate: "g", resolvedBy: "alex", timestamp: "2026-01-01T00:00:00.000Z" },
        { cwd: dir },
      );
      const raw = (await readBlobFromPath("_gates", "legacy.jsonl", { cwd: dir }))!;
      expect(raw.endsWith("\n")).toBe(true);
      expect(raw.split("\n").filter(Boolean)).toHaveLength(2);
    });
  });
});

describe("pending fact wave and heldBy (#3886, #3887)", () => {
  const line = (o: Record<string, unknown>) =>
    JSON.stringify({ version: 1, kind: "pending", op: "tg", gate: "g", timestamp: "2026-10-01T00:00:00Z", expiresAt: "2026-10-02T00:00:00Z", ...o });
  test("the reader types wave, heldBy and approvalMode", () => {
    const { pending } = parseGateLedger(line({ approvalMode: "pr-review", wave: { number: 2, name: "prod", op: "tg" }, heldBy: { hook: "migrate", moment: "before-apply", target: "vpc" } }));
    const p: PendingGateRecord = pending[0]!;
    expect(p.wave).toEqual({ number: 2, name: "prod", op: "tg" });
    expect(p.heldBy).toEqual({ hook: "migrate", moment: "before-apply", target: "vpc" });
    expect(p.approvalMode).toBe("pr-review");
  });
  test("a wave or heldBy of the wrong shape is dropped, the line is kept", () => {
    const { pending, malformed } = parseGateLedger(line({ wave: { number: "2" }, heldBy: "migrate" }));
    expect(malformed).toBe(0);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.wave).toBeUndefined();
    expect(pending[0]!.heldBy).toBeUndefined();
  });
});

describe("commit and run on gate records (#4020)", () => {
  const base = { version: 1, op: "tg", gate: "g", timestamp: "2026-10-01T00:00:00Z" };
  const parse = (...lines: Record<string, unknown>[]) => parseGateLedger(lines.map((l) => JSON.stringify(l)).join("\n"));
  test("a pending fact and a resolution read back with their commit and run", () => {
    const { pending, resolutions, malformed } = parse(
      { ...base, kind: "pending", expiresAt: "2026-10-02T00:00:00Z", gitSha: "a".repeat(40), runId: "9001" },
      { ...base, resolvedBy: "alice", gitSha: "a".repeat(40), runId: "9001" },
    );
    expect(malformed).toBe(0);
    expect(pending[0]).toMatchObject({ gitSha: "a".repeat(40), runId: "9001" });
    expect(resolutions[0]).toMatchObject({ gitSha: "a".repeat(40), runId: "9001" });
  });
  test("lines written before the fields existed still read, with neither", () => {
    const { pending, resolutions, malformed } = parse(
      { ...base, kind: "pending", expiresAt: "2026-10-02T00:00:00Z" },
      { ...base, resolvedBy: "alice" },
    );
    expect(malformed).toBe(0);
    expect(pending[0]).not.toHaveProperty("gitSha");
    expect(resolutions[0]).not.toHaveProperty("runId");
  });
  test("a commit or run of the wrong type is dropped and the line is kept", () => {
    const { pending, resolutions, malformed } = parse(
      { ...base, kind: "pending", expiresAt: "2026-10-02T00:00:00Z", gitSha: 7, runId: { id: 1 } },
      { ...base, resolvedBy: "alice", gitSha: ["x"] },
    );
    expect(malformed).toBe(0);
    expect(pending[0]!.gitSha).toBeUndefined();
    expect(pending[0]!.runId).toBeUndefined();
    expect(resolutions[0]!.gitSha).toBeUndefined();
  });
});
