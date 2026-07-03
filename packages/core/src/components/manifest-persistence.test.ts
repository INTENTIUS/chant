import { describe, test, expect, vi, beforeEach } from "vitest";
import type { DriverStepRecord } from "./driver";
import { createBuildArchiveManifest, addArchiveEntry, type BuildArchiveManifest } from "./verbs/build-archive";

const persistBuildManifestMock = vi.fn();
const pushLifecycleMock = vi.fn();

vi.mock("../lifecycle/build-ledger-store", () => ({
  persistBuildManifest: (...args: unknown[]) => persistBuildManifestMock(...args),
}));

vi.mock("../lifecycle/git", () => ({
  pushLifecycle: (...args: unknown[]) => pushLifecycleMock(...args),
}));

const {
  maybePersistBuildManifest,
  extractRunManifest,
  extractRunManifestFromPhaseOutputs,
} = await import("./manifest-persistence");

function makeManifest(component: string, digest: string): BuildArchiveManifest {
  let manifest = createBuildArchiveManifest(component, { now: () => new Date("2026-01-01T00:00:00.000Z") });
  manifest = addArchiveEntry(manifest, { kind: "image", path: "image.tar", digest });
  return manifest;
}

function buildRecord(manifest: BuildArchiveManifest): DriverStepRecord {
  return {
    component: manifest.component,
    phase: "Build",
    kind: "docker-build",
    status: "ok",
    durationMs: 5,
    output: { archivePath: "image.tar", digest: manifest.contents[0]!.digest, manifest },
  };
}

function applyRecord(): DriverStepRecord {
  return { component: "svc", phase: "Apply", kind: "cfn-deploy", status: "ok", durationMs: 5, output: { ok: true } };
}

describe("extractRunManifest", () => {
  test("finds the manifest from a build-shaped step output", () => {
    const manifest = makeManifest("svc", "sha256:abc");
    expect(extractRunManifest([buildRecord(manifest)])).toEqual(manifest);
  });

  test("returns undefined when no step produced a manifest", () => {
    expect(extractRunManifest([applyRecord()])).toBeUndefined();
  });

  test("ignores failed/skipped steps", () => {
    const manifest = makeManifest("svc", "sha256:abc");
    const failed: DriverStepRecord = { ...buildRecord(manifest), status: "fail", output: undefined };
    expect(extractRunManifest([failed])).toBeUndefined();
  });

  test("takes the last (most-accumulated) manifest when multiple build steps ran", () => {
    const first = makeManifest("svc", "sha256:first");
    let second = makeManifest("svc", "sha256:first");
    second = addArchiveEntry(second, { kind: "image", path: "second.tar", digest: "sha256:second" });

    const result = extractRunManifest([buildRecord(first), buildRecord(second)]);
    expect(result).toEqual(second);
    expect(result?.contents).toHaveLength(2);
  });
});

describe("extractRunManifestFromPhaseOutputs", () => {
  test("finds the manifest across phase outputs (Temporal workflow result shape)", () => {
    const manifest = makeManifest("svc", "sha256:abc");
    expect(
      extractRunManifestFromPhaseOutputs({
        Build: { archivePath: "image.tar", digest: "sha256:abc", manifest },
        Apply: { ok: true },
      }),
    ).toEqual(manifest);
  });

  test("returns undefined for undefined/empty phaseOutputs", () => {
    expect(extractRunManifestFromPhaseOutputs(undefined)).toBeUndefined();
    expect(extractRunManifestFromPhaseOutputs({})).toBeUndefined();
  });
});

describe("maybePersistBuildManifest", () => {
  beforeEach(() => {
    persistBuildManifestMock.mockReset();
    pushLifecycleMock.mockReset().mockResolvedValue(true);
  });

  test("success with a manifest in records -> persists and pushes", async () => {
    const manifest = makeManifest("svc", "sha256:abc");
    persistBuildManifestMock.mockResolvedValue({ commit: "a".repeat(40) });

    const outcome = await maybePersistBuildManifest({ success: true, records: [buildRecord(manifest)] });

    expect(outcome).toEqual({ persisted: true, commit: "a".repeat(40), manifestDigest: manifest.manifestDigest });
    expect(persistBuildManifestMock).toHaveBeenCalledTimes(1);
    expect(persistBuildManifestMock.mock.calls[0][0]).toEqual(manifest);
    expect(pushLifecycleMock).toHaveBeenCalledTimes(1);
  });

  test("a pre-resolved manifest (Temporal path) takes precedence over records", async () => {
    const preResolved = makeManifest("svc", "sha256:temporal");
    persistBuildManifestMock.mockResolvedValue({ commit: "b".repeat(40) });

    const outcome = await maybePersistBuildManifest({
      success: true,
      manifest: preResolved,
      records: [buildRecord(makeManifest("svc", "sha256:ignored"))],
    });

    expect(outcome).toMatchObject({ persisted: true, manifestDigest: preResolved.manifestDigest });
    expect(persistBuildManifestMock.mock.calls[0][0]).toEqual(preResolved);
  });

  test("failure (run.success = false) -> persists nothing (dry-run/failed-deploy safety)", async () => {
    const manifest = makeManifest("svc", "sha256:abc");
    const outcome = await maybePersistBuildManifest({ success: false, records: [buildRecord(manifest)] });
    expect(outcome).toEqual({ persisted: false, reason: "run-not-successful" });
    expect(persistBuildManifestMock).not.toHaveBeenCalled();
    expect(pushLifecycleMock).not.toHaveBeenCalled();
  });

  test("opt-out (options.disabled) -> persists nothing, even on a successful run with a manifest", async () => {
    const manifest = makeManifest("svc", "sha256:abc");
    const outcome = await maybePersistBuildManifest(
      { success: true, records: [buildRecord(manifest)] },
      { disabled: true },
    );
    expect(outcome).toEqual({ persisted: false, reason: "opted-out" });
    expect(persistBuildManifestMock).not.toHaveBeenCalled();
    expect(pushLifecycleMock).not.toHaveBeenCalled();
  });

  test("no manifest in the run's records -> skipped, not an error (infra-only/apply-only component)", async () => {
    const outcome = await maybePersistBuildManifest({ success: true, records: [applyRecord()] });
    expect(outcome).toEqual({ persisted: false, reason: "no-manifest" });
    expect(persistBuildManifestMock).not.toHaveBeenCalled();
  });

  test("persist failure -> reported as an error result, not thrown, and never masks the successful deploy", async () => {
    const manifest = makeManifest("svc", "sha256:abc");
    persistBuildManifestMock.mockRejectedValue(new Error("git write failed"));

    await expect(
      maybePersistBuildManifest({ success: true, records: [buildRecord(manifest)] }),
    ).resolves.toMatchObject({ persisted: false, reason: "error", error: "git write failed" });
  });
});
