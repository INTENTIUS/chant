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

describe("slurm listArtifacts", () => {
  beforeEach(() => {
    execMock.mockReset();
  });

  test("happy path: maps newer-Slurm sinfo schema to partitions", async () => {
    let receivedCmd = "";
    execMock.mockImplementation((cmd: string) => {
      receivedCmd = cmd;
      return {
        stdout: JSON.stringify({
          sinfo: [
            {
              partition: { name: "compute", state: ["UP"] },
              nodes: { count: 10, allocated: 4, idle: 6 },
              cpus: { total: 320 },
              memory: { total: 1024000 },
            },
            {
              partition: { name: "gpu", state: ["UP"] },
              nodes: { count: 4 },
            },
          ],
        }),
        stderr: "",
      };
    });

    const result = await listArtifacts({ environment: "prod", entities: new Map() });

    expect(receivedCmd).toBe("sinfo --json");
    expect(Object.keys(result).sort()).toEqual(["partition/compute", "partition/gpu"]);
    expect(result["partition/compute"]).toMatchObject({
      type: "Slurm::Partition",
      physicalId: "compute",
      status: "UP",
      attributes: { nodeCount: 10, nodesAllocated: 4, nodesIdle: 6, cpus: 320, memory: 1024000 },
    });
  });

  test("sinfo not installed → returns {}", async () => {
    execMock.mockImplementation(() => { throw new Error("sinfo: command not found"); });
    const result = await listArtifacts({ environment: "prod", entities: new Map() });
    expect(result).toEqual({});
  });

  test("partition state surfaces (UP, DOWN, DRAIN)", async () => {
    execMock.mockResolvedValue({
      stdout: JSON.stringify({
        sinfo: [
          { partition: { name: "p1", state: ["UP"] } },
          { partition: { name: "p2", state: ["DOWN"] } },
          { partition: { name: "p3", state: ["DRAIN"] } },
        ],
      }),
      stderr: "",
    });
    const result = await listArtifacts({ environment: "prod", entities: new Map() });
    expect(result["partition/p1"].status).toBe("UP");
    expect(result["partition/p2"].status).toBe("DOWN");
    expect(result["partition/p3"].status).toBe("DRAIN");
  });

  test("empty cluster (no partitions) → {}", async () => {
    execMock.mockResolvedValue({ stdout: JSON.stringify({ sinfo: [] }), stderr: "" });
    const result = await listArtifacts({ environment: "prod", entities: new Map() });
    expect(result).toEqual({});
  });

  test("older Slurm flat schema is also handled", async () => {
    execMock.mockResolvedValue({
      stdout: JSON.stringify({
        partitions: [
          { name: "compute", state: "UP" },
        ],
      }),
      stderr: "",
    });
    const result = await listArtifacts({ environment: "prod", entities: new Map() });
    expect(result["partition/compute"]).toMatchObject({ status: "UP" });
  });

  test("duplicate partition entries from sinfo (per node-state bucket) are deduped", async () => {
    execMock.mockResolvedValue({
      stdout: JSON.stringify({
        sinfo: [
          { partition: { name: "compute", state: ["UP"] }, nodes: { count: 6, idle: 6 } },
          { partition: { name: "compute", state: ["UP"] }, nodes: { count: 4, allocated: 4 } },
        ],
      }),
      stderr: "",
    });
    const result = await listArtifacts({ environment: "prod", entities: new Map() });
    // Only the first row wins — partition state is what matters for drift
    expect(Object.keys(result)).toEqual(["partition/compute"]);
  });

  test("malformed JSON output → returns {}", async () => {
    execMock.mockResolvedValue({ stdout: "not json", stderr: "" });
    const result = await listArtifacts({ environment: "prod", entities: new Map() });
    expect(result).toEqual({});
  });
});
