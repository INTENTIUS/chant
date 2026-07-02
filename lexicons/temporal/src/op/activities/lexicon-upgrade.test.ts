import { describe, test, expect, vi } from "vitest";
import {
  lexiconUpgrade,
  isPinned,
  isRolling,
  severityToLabel,
  upgradeBranchName,
  upgradePrTitle,
  buildUpgradeSummary,
  type CheckPinnedFn,
  type CheckRollingFn,
} from "./lexicon-upgrade";
import type { UpgradeCheckResult } from "@intentius/chant/codegen/pinned-upgrade";
import type { RollingUpgradeResult } from "@intentius/chant/codegen/rolling-upgrade";

// ── Classification ────────────────────────────────────────────────────

describe("pinned vs rolling classification", () => {
  test("pinned lexicons", () => {
    for (const l of ["k8s", "gcp", "docker", "gitlab"] as const) {
      expect(isPinned(l)).toBe(true);
      expect(isRolling(l)).toBe(false);
    }
  });

  test("rolling lexicons", () => {
    for (const l of ["aws", "azure", "github"] as const) {
      expect(isRolling(l)).toBe(true);
      expect(isPinned(l)).toBe(false);
    }
  });
});

// ── Semver label mapping ──────────────────────────────────────────────

describe("severityToLabel", () => {
  test("additive → minor", () => expect(severityToLabel("additive")).toBe("minor"));
  test("breaking → breaking", () => expect(severityToLabel("breaking")).toBe("breaking"));
  test("none → null", () => expect(severityToLabel("none")).toBeNull());
  test("unknown → null", () => expect(severityToLabel("wibble")).toBeNull());
});

// ── Naming helpers ────────────────────────────────────────────────────

describe("branch / PR naming", () => {
  test("long-lived branch per lexicon", () => {
    expect(upgradeBranchName("k8s")).toBe("lexicon-upgrade/k8s");
    expect(upgradeBranchName("aws")).toBe("lexicon-upgrade/aws");
  });

  test("PR title with from/to", () => {
    expect(upgradePrTitle("k8s", "v1.32.0", "v1.33.0")).toBe(
      "feat(k8s): upgrade spec v1.32.0 to v1.33.0",
    );
  });

  test("PR title without version (rolling)", () => {
    expect(upgradePrTitle("aws")).toBe("feat(aws): upgrade to latest spec");
  });
});

// ── Summary builder ───────────────────────────────────────────────────

describe("buildUpgradeSummary", () => {
  test("additive upgrade renders delta + label", () => {
    const s = buildUpgradeSummary({
      lexicon: "aws",
      deltaText: "Added: AWS::S3::Bucket",
      semverLabel: "minor",
      validationOk: true,
    });
    expect(s).toContain("Lexicon upgrade: aws");
    expect(s).toContain("minor");
    expect(s).toContain("Added: AWS::S3::Bucket");
  });

  test("validation failure renders failures block", () => {
    const s = buildUpgradeSummary({
      lexicon: "gitlab",
      deltaText: "",
      semverLabel: null,
      validationOk: false,
      failures: [{ step: "build", output: "tsc exploded" }],
    });
    expect(s).toContain("Validation failures");
    expect(s).toContain("tsc exploded");
  });
});

// ── Mock builders ─────────────────────────────────────────────────────

function pinnedResult(over: Partial<UpgradeCheckResult> = {}): UpgradeCheckResult {
  return {
    lexicon: "k8s",
    hasUpgrade: true,
    from: "v1.32.0",
    to: "v1.33.0",
    validation: {
      ok: true,
      changed: true,
      severity: "additive",
      delta: { added: [], changed: [], removed: [], severity: "additive" },
      deltaText: "Added: apps/v1 Deployment field",
      failures: [],
      freshSnapshot: null,
    },
    fetchError: null,
    ...over,
  };
}

function rollingResult(over: Partial<RollingUpgradeResult> = {}): RollingUpgradeResult {
  return {
    lexicon: "aws",
    hasUpgrade: true,
    severity: "breaking",
    delta: { added: [], changed: [], removed: [], severity: "breaking" },
    deltaText: "Removed: AWS::Foo::Bar",
    validationOk: true,
    failures: [],
    apiVersionDelta: [],
    freshSnapshot: null,
    ...over,
  };
}

// A gh runner that records the commands it was asked to run.
function recordingGh() {
  const calls: string[] = [];
  const gh = vi.fn(async (cmd: string) => {
    calls.push(cmd);
    if (cmd.includes("gh pr create")) return { stdout: "https://gh/pr/1", stderr: "" };
    if (cmd.includes("gh issue create")) return { stdout: "https://gh/issue/1", stderr: "" };
    // gh pr view with no open PR → empty
    return { stdout: "", stderr: "" };
  });
  return { gh, calls };
}

// ── report mode (default, no external services) ───────────────────────

describe("lexiconUpgrade report mode", () => {
  test("pinned: dispatches to checkPinnedUpgrade, reports delta + label", async () => {
    const checkPinned: CheckPinnedFn = vi.fn(async () => pinnedResult());
    const { gh, calls } = recordingGh();

    const r = await lexiconUpgrade({
      lexicon: "k8s",
      mode: "report",
      _checkPinned: checkPinned,
      _gh: gh,
    });

    expect(checkPinned).toHaveBeenCalledOnce();
    expect(r.hasUpgrade).toBe(true);
    expect(r.semverLabel).toBe("minor");
    expect(r.validationOk).toBe(true);
    expect(r.deltaText).toContain("apps/v1");
    // report mode must not touch gh
    expect(calls).toHaveLength(0);
  });

  test("rolling: dispatches to checkRollingUpgrade, breaking → breaking label", async () => {
    const checkRolling: CheckRollingFn = vi.fn(async () => rollingResult());
    const { gh } = recordingGh();

    const r = await lexiconUpgrade({
      lexicon: "aws",
      mode: "report",
      _checkRolling: checkRolling,
      _gh: gh,
    });

    expect(checkRolling).toHaveBeenCalledOnce();
    expect(r.semverLabel).toBe("breaking");
    expect(r.deltaText).toContain("AWS::Foo::Bar");
  });

  test("no upgrade → hasUpgrade false, no label", async () => {
    const checkRolling: CheckRollingFn = vi.fn(async () =>
      rollingResult({ hasUpgrade: false, severity: "none", deltaText: "" }),
    );
    const r = await lexiconUpgrade({
      lexicon: "github",
      mode: "report",
      _checkRolling: checkRolling,
    });
    expect(r.hasUpgrade).toBe(false);
    expect(r.semverLabel).toBeNull();
  });
});

// ── issue mode ────────────────────────────────────────────────────────

describe("lexiconUpgrade issue mode", () => {
  test("opens an issue for a ready upgrade", async () => {
    const checkPinned: CheckPinnedFn = vi.fn(async () => pinnedResult());
    const { gh, calls } = recordingGh();

    const r = await lexiconUpgrade({
      lexicon: "gcp",
      mode: "issue",
      _checkPinned: checkPinned,
      _gh: gh,
    });

    expect(r.issueUrl).toBe("https://gh/issue/1");
    expect(calls.some((c) => c.includes("gh issue create"))).toBe(true);
    expect(calls.some((c) => c.includes("gh pr create"))).toBe(false);
  });
});

// ── validation failure never becomes a PR ─────────────────────────────

describe("lexiconUpgrade breakage handling", () => {
  test("failing validation in pull-request mode falls back to an issue, never a PR", async () => {
    const checkPinned: CheckPinnedFn = vi.fn(async () =>
      pinnedResult({
        validation: {
          ok: false,
          changed: true,
          severity: "breaking",
          delta: { added: [], changed: [], removed: [], severity: "breaking" },
          deltaText: "Removed: v1 Pod",
          failures: [{ step: "build", output: "type error" }],
          freshSnapshot: null,
        },
      }),
    );
    const { gh, calls } = recordingGh();

    const r = await lexiconUpgrade({
      lexicon: "k8s",
      mode: "pull-request",
      _checkPinned: checkPinned,
      _gh: gh,
    });

    expect(r.validationOk).toBe(false);
    expect(r.issueUrl).toBe("https://gh/issue/1");
    expect(r.prUrl).toBeUndefined();
    // must NOT open a PR, must NOT push
    expect(calls.some((c) => c.includes("gh pr create"))).toBe(false);
    expect(calls.some((c) => c.includes("gh issue create"))).toBe(true);
    // the issue body carries the failure diff
    expect(r.summary).toContain("type error");
  });

  test("upstream fetch error surfaces as a non-upgrade report, never a PR", async () => {
    const checkPinned: CheckPinnedFn = vi.fn(async () =>
      pinnedResult({ hasUpgrade: false, validation: null, fetchError: "GitHub 403" }),
    );
    const { gh, calls } = recordingGh();

    const r = await lexiconUpgrade({
      lexicon: "docker",
      mode: "pull-request",
      _checkPinned: checkPinned,
      _gh: gh,
    });

    expect(r.hasUpgrade).toBe(false);
    expect(r.validationOk).toBe(false);
    expect(r.summary).toContain("GitHub 403");
    expect(calls).toHaveLength(0);
  });
});

// ── out-of-scope rejection ────────────────────────────────────────────

describe("out-of-scope lexicons", () => {
  test("helm/temporal/forgejo throw", async () => {
    for (const l of ["helm", "temporal", "forgejo"]) {
      await expect(
        lexiconUpgrade({ lexicon: l as never, mode: "report" }),
      ).rejects.toThrow(/not supported/);
    }
  });
});

// ── pull-request idempotency short-circuit ────────────────────────────

describe("lexiconUpgrade pull-request idempotency", () => {
  test("when the open PR body already matches, skip git entirely and return the existing PR", async () => {
    const checkRolling: CheckRollingFn = vi.fn(async () => rollingResult());
    // Compute what the summary will be so the mock can echo it back.
    const expectedSummary = buildUpgradeSummary({
      lexicon: "aws",
      deltaText: "Removed: AWS::Foo::Bar",
      semverLabel: "breaking",
      validationOk: true,
    });

    const calls: string[] = [];
    const gh = vi.fn(async (cmd: string) => {
      calls.push(cmd);
      // Body query returns the current summary → idempotent, no re-PR.
      if (cmd.includes("gh pr view") && cmd.includes("body")) {
        return { stdout: expectedSummary, stderr: "" };
      }
      if (cmd.includes("gh pr view") && cmd.includes("url")) {
        return { stdout: "https://gh/pr/existing", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const r = await lexiconUpgrade({
      lexicon: "aws",
      mode: "pull-request",
      _checkRolling: checkRolling,
      _gh: gh,
    });

    expect(r.prUrl).toBe("https://gh/pr/existing");
    // Idempotent path must not create or edit a PR, and must not push.
    expect(calls.some((c) => c.includes("gh pr create"))).toBe(false);
    expect(calls.some((c) => c.includes("gh pr edit"))).toBe(false);
    expect(calls.every((c) => c.startsWith("gh pr view"))).toBe(true);
  });
});
