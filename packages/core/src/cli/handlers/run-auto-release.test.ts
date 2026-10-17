/**
 * What `recordAutoReleasesForRun` hands the release record (#4020): the run
 * and its origin, and for a component that passed a gate, who approved it and
 * which resolution admitted it.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

const maybeRecordAutoReleaseMock = vi.fn();
vi.mock("../../components/auto-release", async () => {
  const actual = await vi.importActual<typeof import("../../components/auto-release")>("../../components/auto-release");
  return { ...actual, maybeRecordAutoRelease: (...args: unknown[]) => maybeRecordAutoReleaseMock(...args) };
});
vi.mock("../../components/manifest-persistence", async () => {
  const actual = await vi.importActual<typeof import("../../components/manifest-persistence")>("../../components/manifest-persistence");
  return { ...actual, maybePersistBuildManifest: async () => ({ persisted: false, reason: "no-manifest" }) };
});

import { autoReleaseRun, recordAutoReleasesForRun } from "./run";
import type { DriverComponentResult } from "../../components/driver";

const gatedResult = {
  component: "api",
  ok: true,
  status: "ok",
  records: [
    { component: "api", phase: "Deploy", kind: "gate:approve-prod", status: "ok", durationMs: 1, approval: { gate: "approve-prod", resolvedBy: "alice", timestamp: "2026-10-16T10:05:00.000Z" } },
    { component: "api", phase: "Deploy", kind: "apply", status: "ok", durationMs: 1 },
  ],
} as unknown as DriverComponentResult;
const plainResult = { component: "worker", ok: true, status: "ok", records: [] } as unknown as DriverComponentResult;

beforeEach(() => {
  maybeRecordAutoReleaseMock.mockReset().mockResolvedValue({ recorded: false, reason: "no-digest" });
});
afterEach(() => vi.unstubAllEnvs());

describe("recordAutoReleasesForRun", () => {
  test("a component that passed a gate records its approver and admission, one that did not records neither", async () => {
    await recordAutoReleasesForRun([gatedResult, plainResult], "prod", "9001", false, { forge: "github", repo: "acme/app" });
    const [gated, plain] = maybeRecordAutoReleaseMock.mock.calls.map((c) => c[0]);
    expect(gated).toMatchObject({
      component: "api", runId: "9001", runOrigin: { forge: "github", repo: "acme/app" },
      approver: "alice", admission: { op: "api", gate: "approve-prod", resolvedAt: "2026-10-16T10:05:00.000Z" },
    });
    expect(plain).not.toHaveProperty("approver");
    expect(plain).not.toHaveProperty("admission");
  });

  test("a run under --release records the release digest on each component, one without it records none (#4043)", async () => {
    const release = `jcs1-sha256:${"c".repeat(64)}`;
    await recordAutoReleasesForRun([plainResult], "dev", "9001", false, { forge: "local" }, release);
    expect(maybeRecordAutoReleaseMock.mock.calls[0][0]).toMatchObject({ releaseDigest: release });
    maybeRecordAutoReleaseMock.mockClear();
    await recordAutoReleasesForRun([plainResult], "dev", "9001", false, { forge: "local" });
    expect(maybeRecordAutoReleaseMock.mock.calls[0][0]).not.toHaveProperty("releaseDigest");
  });

  test("the origin defaults to local", async () => {
    await recordAutoReleasesForRun([plainResult], "prod", "local-1", false);
    expect(maybeRecordAutoReleaseMock.mock.calls[0][0]).toMatchObject({ runId: "local-1", runOrigin: { forge: "local" } });
  });
});

describe("autoReleaseRun", () => {
  test("in CI it names the CI run, so the release and the gate it passed name one run", () => {
    vi.stubEnv("GITHUB_RUN_ID", "9001");
    vi.stubEnv("GITHUB_REPOSITORY", "acme/app");
    vi.stubEnv("GITHUB_SERVER_URL", "https://github.example");
    expect(autoReleaseRun("local-1")).toEqual({
      runId: "9001",
      runOrigin: { forge: "github", repo: "acme/app", url: "https://github.example/acme/app/actions/runs/9001" },
    });
  });

  test("outside CI it keeps the local id", () => {
    vi.stubEnv("GITHUB_RUN_ID", "");
    vi.stubEnv("CI_PIPELINE_ID", "");
    expect(autoReleaseRun("local-1")).toEqual({ runId: "local-1", runOrigin: { forge: "local" } });
  });
});
