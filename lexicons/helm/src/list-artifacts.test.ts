import { describe, test, expect, vi, beforeEach } from "vitest";

const execMock = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, exec: (cmd: string, cb: (err: Error | null, out: { stdout: string; stderr: string }) => void) => {
    Promise.resolve(execMock(cmd)).then(
      (out) => cb(null, out),
      (err) => cb(err as Error, { stdout: "", stderr: "" }),
    );
  } };
});

const ledgerMock = vi.fn();
vi.mock("@intentius/chant/lifecycle/release-ledger", async () => {
  const actual = await vi.importActual<typeof import("@intentius/chant/lifecycle/release-ledger")>(
    "@intentius/chant/lifecycle/release-ledger",
  );
  return { ...actual, readReleaseLedger: (env: string) => ledgerMock(env) };
});

const { listArtifacts } = await import("./list-artifacts");

/** One ledger line as the helm deploy activity records it (#1243). */
function ledgerRecord(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    version: 1,
    component: "web",
    env: "prod",
    digest: "sha256:input-digest",
    gitSha: "deadbeef",
    runId: "run-1",
    timestamp: "2026-08-30T00:00:00.000Z",
    actor: "ci-bot",
    ...overrides,
  };
}

describe("helm listArtifacts", () => {
  beforeEach(() => {
    execMock.mockReset();
    ledgerMock.mockReset();
    // Default: no ledger readable — the join contributes nothing.
    ledgerMock.mockRejectedValue(new Error("no lifecycle branch"));
  });

  test("queries `helm list -A -o json` and maps releases to artifacts", async () => {
    let receivedCmd = "";
    execMock.mockImplementation((cmd: string) => {
      receivedCmd = cmd;
      return {
        stdout: JSON.stringify([
          {
            name: "web", namespace: "default", revision: "1",
            updated: "2026-05-09 10:00:00.000000 +0000 UTC",
            status: "deployed", chart: "web-1.0.0", app_version: "1.0",
          },
          {
            name: "redis", namespace: "infra", revision: "3",
            updated: "2026-05-09 09:00:00.000000 +0000 UTC",
            status: "deployed", chart: "redis-7.4.0", app_version: "7.4",
          },
        ]),
        stderr: "",
      };
    });

    const result = await listArtifacts({ environment: "prod", entities: new Map() });

    expect(receivedCmd).toBe("helm list -A -o json");
    expect(Object.keys(result).sort()).toEqual(["release/default/web", "release/infra/redis"]);
    expect(result["release/default/web"]).toEqual({
      type: "Helm::Release",
      physicalId: "default/web",
      status: "deployed",
      lastUpdated: "2026-05-09 10:00:00.000000 +0000 UTC",
      attributes: { chart: "web-1.0.0", revision: "1", appVersion: "1.0", namespace: "default" },
    });
  });

  test("helm binary not installed → returns {} cleanly", async () => {
    execMock.mockImplementation(() => { throw new Error("helm: command not found"); });
    const result = await listArtifacts({ environment: "prod", entities: new Map() });
    expect(result).toEqual({});
  });

  test("empty cluster (no releases) → returns {}", async () => {
    execMock.mockResolvedValue({ stdout: "[]", stderr: "" });
    const result = await listArtifacts({ environment: "prod", entities: new Map() });
    expect(result).toEqual({});
  });

  test("status mapping for non-deployed states surfaces correctly", async () => {
    execMock.mockResolvedValue({
      stdout: JSON.stringify([
        { name: "broken", namespace: "default", revision: "2", status: "failed", chart: "x-1.0", app_version: "1" },
      ]),
      stderr: "",
    });
    const result = await listArtifacts({ environment: "prod", entities: new Map() });
    expect(result["release/default/broken"].status).toBe("failed");
  });

  test("revision attribute changes between releases (drift signal)", async () => {
    execMock.mockResolvedValue({
      stdout: JSON.stringify([
        { name: "web", namespace: "default", revision: "5", status: "deployed", chart: "web-2.0.0", app_version: "2.0" },
      ]),
      stderr: "",
    });
    const result = await listArtifacts({ environment: "prod", entities: new Map() });
    expect(result["release/default/web"].attributes).toMatchObject({ revision: "5", chart: "web-2.0.0" });
  });

  test("malformed JSON output → returns {} (don't fail the snapshot)", async () => {
    execMock.mockResolvedValue({ stdout: "not json", stderr: "" });
    const result = await listArtifacts({ environment: "prod", entities: new Map() });
    expect(result).toEqual({});
  });

  describe("render identity read back from the release ledger (#2031)", () => {
    const webRelease = { name: "web", namespace: "default", revision: "1", status: "deployed", chart: "web-1.0.0", app_version: "1.0" };

    test("an unpinned chant deploy reports its inputDigest", async () => {
      execMock.mockResolvedValue({ stdout: JSON.stringify([webRelease]), stderr: "" });
      ledgerMock.mockResolvedValue({ records: [ledgerRecord({})], malformed: 0 });

      const result = await listArtifacts({ environment: "prod", entities: new Map() });
      expect(ledgerMock).toHaveBeenCalledWith("prod");
      expect(result["release/default/web"].attributes).toMatchObject({ inputDigest: "sha256:input-digest" });
      expect(result["release/default/web"].attributes.contentDigest).toBeUndefined();
    });

    test("a pinned deploy reports contentDigest and inputDigest — joinable to `helm renders`", async () => {
      execMock.mockResolvedValue({ stdout: JSON.stringify([webRelease]), stderr: "" });
      ledgerMock.mockResolvedValue({
        records: [ledgerRecord({ digest: "sha256:content-digest", inputDigest: "sha256:input-digest" })],
        malformed: 0,
      });

      const result = await listArtifacts({ environment: "prod", entities: new Map() });
      expect(result["release/default/web"].attributes).toMatchObject({
        inputDigest: "sha256:input-digest",
        contentDigest: "sha256:content-digest",
      });
    });

    test("the latest record per component wins", async () => {
      execMock.mockResolvedValue({ stdout: JSON.stringify([webRelease]), stderr: "" });
      ledgerMock.mockResolvedValue({
        records: [
          ledgerRecord({ digest: "sha256:older", timestamp: "2026-08-01T00:00:00.000Z" }),
          ledgerRecord({ digest: "sha256:newer", timestamp: "2026-08-30T00:00:00.000Z" }),
        ],
        malformed: 0,
      });
      const result = await listArtifacts({ environment: "prod", entities: new Map() });
      expect(result["release/default/web"].attributes.inputDigest).toBe("sha256:newer");
    });

    test("a release deployed outside chant reports nothing — absent is the honest answer", async () => {
      execMock.mockResolvedValue({
        stdout: JSON.stringify([webRelease, { ...webRelease, name: "manual", chart: "manual-0.1.0" }]),
        stderr: "",
      });
      ledgerMock.mockResolvedValue({ records: [ledgerRecord({})], malformed: 0 });

      const result = await listArtifacts({ environment: "prod", entities: new Map() });
      expect(result["release/default/web"].attributes.inputDigest).toBe("sha256:input-digest");
      expect(result["release/default/manual"].attributes.inputDigest).toBeUndefined();
      expect(result["release/default/manual"].attributes.contentDigest).toBeUndefined();
    });

    test("one name in several namespaces is ambiguous against a namespace-less record — neither joins", async () => {
      execMock.mockResolvedValue({
        stdout: JSON.stringify([webRelease, { ...webRelease, namespace: "staging-ns" }]),
        stderr: "",
      });
      ledgerMock.mockResolvedValue({ records: [ledgerRecord({})], malformed: 0 });

      const result = await listArtifacts({ environment: "prod", entities: new Map() });
      expect(result["release/default/web"].attributes.inputDigest).toBeUndefined();
      expect(result["release/staging-ns/web"].attributes.inputDigest).toBeUndefined();
    });

    test("an unreadable ledger joins nothing rather than failing the snapshot", async () => {
      execMock.mockResolvedValue({ stdout: JSON.stringify([webRelease]), stderr: "" });
      ledgerMock.mockRejectedValue(new Error("not a git repository"));

      const result = await listArtifacts({ environment: "prod", entities: new Map() });
      expect(result["release/default/web"]).toBeDefined();
      expect(result["release/default/web"].attributes.inputDigest).toBeUndefined();
    });
  });
});
