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

const { listArtifacts } = await import("./list-artifacts");

describe("helm listArtifacts", () => {
  beforeEach(() => {
    execMock.mockReset();
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
});
