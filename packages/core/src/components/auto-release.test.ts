import { describe, test, expect, vi, beforeEach } from "vitest";
import type { DriverStepRecord } from "./driver";

const getHeadCommitMock = vi.fn();
const pushLifecycleMock = vi.fn();
const appendReleaseRecordMock = vi.fn();

vi.mock("../lifecycle/git", () => ({
  getHeadCommit: (...args: unknown[]) => getHeadCommitMock(...args),
  pushLifecycle: (...args: unknown[]) => pushLifecycleMock(...args),
  StaleLifecycleBranchError: class StaleLifecycleBranchError extends Error {},
}));

vi.mock("../lifecycle/release-ledger", async () => {
  const actual = await vi.importActual<typeof import("../lifecycle/release-ledger")>("../lifecycle/release-ledger");
  return {
    ...actual,
    appendReleaseRecord: (...args: unknown[]) => appendReleaseRecordMock(...args),
  };
});

const {
  maybeRecordAutoRelease,
  extractRunDigest,
  extractRunDigestFromPhaseOutputs,
} = await import("./auto-release");

function publishRecord(digest: string): DriverStepRecord {
  return { component: "svc", phase: "Publish", kind: "publish-image", status: "ok", durationMs: 5, output: { digest, uri: `repo@${digest}` } };
}

function applyRecord(): DriverStepRecord {
  return { component: "svc", phase: "Apply", kind: "cfn-deploy", status: "ok", durationMs: 5, output: { ok: true } };
}

describe("extractRunDigest", () => {
  test("finds the digest from a publish-shaped step output", () => {
    expect(extractRunDigest([publishRecord("sha256:abc"), applyRecord()])).toBe("sha256:abc");
  });

  test("returns undefined when no step published a digest", () => {
    expect(extractRunDigest([applyRecord()])).toBeUndefined();
  });

  test("ignores failed/skipped steps", () => {
    const failed: DriverStepRecord = { component: "svc", phase: "Publish", kind: "publish-image", status: "fail", durationMs: 5, error: "boom" };
    expect(extractRunDigest([failed])).toBeUndefined();
  });

  test("takes the last digest-bearing output when multiple steps publish", () => {
    expect(extractRunDigest([publishRecord("sha256:first"), publishRecord("sha256:second")])).toBe("sha256:second");
  });
});

describe("extractRunDigestFromPhaseOutputs", () => {
  test("finds the digest across phase outputs (Temporal workflow result shape)", () => {
    expect(extractRunDigestFromPhaseOutputs({ Publish: { digest: "sha256:abc", uri: "repo@sha256:abc" }, Apply: { ok: true } })).toBe("sha256:abc");
  });

  test("returns undefined for undefined/empty phaseOutputs", () => {
    expect(extractRunDigestFromPhaseOutputs(undefined)).toBeUndefined();
    expect(extractRunDigestFromPhaseOutputs({})).toBeUndefined();
  });
});

describe("maybeRecordAutoRelease", () => {
  beforeEach(() => {
    getHeadCommitMock.mockReset().mockResolvedValue("abc123headsha");
    pushLifecycleMock.mockReset().mockResolvedValue(true);
    appendReleaseRecordMock.mockReset();
    delete process.env.GITHUB_ACTOR;
    delete process.env.GITLAB_USER_LOGIN;
    delete process.env.USER;
  });

  test("success -> writes exactly one record and pushes", async () => {
    appendReleaseRecordMock.mockResolvedValue({
      commit: "a".repeat(40),
      record: {
        version: 1, component: "svc", env: "prod", digest: "sha256:abc",
        gitSha: "abc123headsha", runId: "run-1", timestamp: "2026-01-01T00:00:00.000Z", actor: "alice",
      },
    });

    const outcome = await maybeRecordAutoRelease(
      { component: "svc", env: "prod", success: true, records: [publishRecord("sha256:abc")], runId: "run-1" },
      { actor: "alice" },
    );

    expect(outcome.recorded).toBe(true);
    expect(appendReleaseRecordMock).toHaveBeenCalledTimes(1);
    const [input] = appendReleaseRecordMock.mock.calls[0];
    expect(input).toMatchObject({ component: "svc", env: "prod", digest: "sha256:abc", gitSha: "abc123headsha", runId: "run-1", actor: "alice" });
    expect(typeof input.timestamp).toBe("string");
    expect(pushLifecycleMock).toHaveBeenCalledTimes(1);
  });

  test("a pre-resolved digest (Temporal path) takes precedence and is used directly", async () => {
    appendReleaseRecordMock.mockResolvedValue({
      commit: "b".repeat(40),
      record: { version: 1, component: "svc", env: "prod", digest: "sha256:temporal", gitSha: "x", runId: "r", timestamp: "t", actor: "a" },
    });

    await maybeRecordAutoRelease(
      { component: "svc", env: "prod", success: true, digest: "sha256:temporal", records: [publishRecord("sha256:ignored")], runId: "run-1" },
      { actor: "alice" },
    );

    const [input] = appendReleaseRecordMock.mock.calls[0];
    expect(input.digest).toBe("sha256:temporal");
  });

  test("failure (run.success = false) -> writes nothing", async () => {
    const outcome = await maybeRecordAutoRelease(
      { component: "svc", env: "prod", success: false, records: [publishRecord("sha256:abc")], runId: "run-1" },
      { actor: "alice" },
    );
    expect(outcome).toEqual({ recorded: false, reason: "run-not-successful" });
    expect(appendReleaseRecordMock).not.toHaveBeenCalled();
    expect(pushLifecycleMock).not.toHaveBeenCalled();
  });

  test("opt-out (options.disabled) -> writes nothing, even on a successful run with a digest", async () => {
    const outcome = await maybeRecordAutoRelease(
      { component: "svc", env: "prod", success: true, records: [publishRecord("sha256:abc")], runId: "run-1" },
      { actor: "alice", disabled: true },
    );
    expect(outcome).toEqual({ recorded: false, reason: "opted-out" });
    expect(appendReleaseRecordMock).not.toHaveBeenCalled();
    expect(pushLifecycleMock).not.toHaveBeenCalled();
    expect(getHeadCommitMock).not.toHaveBeenCalled();
  });

  test("no digest in the run's records -> skipped, not an error", async () => {
    const outcome = await maybeRecordAutoRelease(
      { component: "svc", env: "prod", success: true, records: [applyRecord()], runId: "run-1" },
      { actor: "alice" },
    );
    expect(outcome).toMatchObject({ recorded: false, reason: "no-digest" });
    expect(appendReleaseRecordMock).not.toHaveBeenCalled();
  });

  test("no resolvable actor -> skipped, not an error", async () => {
    const outcome = await maybeRecordAutoRelease(
      { component: "svc", env: "prod", success: true, records: [publishRecord("sha256:abc")], runId: "run-1" },
    );
    expect(outcome).toMatchObject({ recorded: false, reason: "no-actor" });
    expect(appendReleaseRecordMock).not.toHaveBeenCalled();
  });

  test("falls back to GITHUB_ACTOR/GITLAB_USER_LOGIN/USER when --actor is not passed", async () => {
    process.env.GITHUB_ACTOR = "octocat";
    appendReleaseRecordMock.mockResolvedValue({
      commit: "c".repeat(40),
      record: { version: 1, component: "svc", env: "prod", digest: "sha256:abc", gitSha: "x", runId: "r", timestamp: "t", actor: "octocat" },
    });

    await maybeRecordAutoRelease(
      { component: "svc", env: "prod", success: true, records: [publishRecord("sha256:abc")], runId: "run-1" },
    );

    const [input] = appendReleaseRecordMock.mock.calls[0];
    expect(input.actor).toBe("octocat");
  });

  test("git sha resolution failure -> reported as an error result, not thrown", async () => {
    getHeadCommitMock.mockRejectedValue(new Error("not a git repo"));
    const outcome = await maybeRecordAutoRelease(
      { component: "svc", env: "prod", success: true, records: [publishRecord("sha256:abc")], runId: "run-1" },
      { actor: "alice" },
    );
    expect(outcome).toMatchObject({ recorded: false, reason: "error" });
    expect(appendReleaseRecordMock).not.toHaveBeenCalled();
  });

  test("ledger write failure -> reported as an error result, not thrown, and never masks the successful deploy", async () => {
    appendReleaseRecordMock.mockRejectedValue(new Error("ledger write failed"));
    const outcome = await expect(maybeRecordAutoRelease(
      { component: "svc", env: "prod", success: true, records: [publishRecord("sha256:abc")], runId: "run-1" },
      { actor: "alice" },
    )).resolves.toMatchObject({ recorded: false, reason: "error", error: "ledger write failed" });
    void outcome;
    expect(pushLifecycleMock).not.toHaveBeenCalled();
  });

  test("an explicit gitSha override skips getHeadCommit entirely", async () => {
    appendReleaseRecordMock.mockResolvedValue({
      commit: "d".repeat(40),
      record: { version: 1, component: "svc", env: "prod", digest: "sha256:abc", gitSha: "override-sha", runId: "r", timestamp: "t", actor: "alice" },
    });

    await maybeRecordAutoRelease(
      { component: "svc", env: "prod", success: true, records: [publishRecord("sha256:abc")], runId: "run-1" },
      { actor: "alice", gitSha: "override-sha" },
    );

    expect(getHeadCommitMock).not.toHaveBeenCalled();
    const [input] = appendReleaseRecordMock.mock.calls[0];
    expect(input.gitSha).toBe("override-sha");
  });
});
