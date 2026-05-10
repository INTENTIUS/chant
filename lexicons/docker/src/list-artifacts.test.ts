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

describe("docker listArtifacts", () => {
  beforeEach(() => {
    execMock.mockReset();
  });

  test("happy path: containers + images + networks all reported", async () => {
    execMock.mockImplementation((cmd: string) => {
      if (cmd.startsWith("docker ps")) {
        return {
          stdout: [
            JSON.stringify({ Names: "web", ID: "abc123", Image: "nginx:latest", State: "running", Status: "Up 5 minutes" }),
            JSON.stringify({ Names: "db",  ID: "def456", Image: "postgres:16", State: "running", Status: "Up 2 hours" }),
          ].join("\n"),
          stderr: "",
        };
      }
      if (cmd.startsWith("docker image ls")) {
        return {
          stdout: [
            JSON.stringify({ ID: "img1", Repository: "nginx",    Tag: "latest", Size: "187MB", CreatedAt: "2026-04-01" }),
            JSON.stringify({ ID: "img2", Repository: "postgres", Tag: "16",     Size: "412MB", CreatedAt: "2026-03-20" }),
          ].join("\n"),
          stderr: "",
        };
      }
      if (cmd.startsWith("docker network ls")) {
        return {
          stdout: [
            JSON.stringify({ ID: "net1", Name: "bridge", Driver: "bridge", Scope: "local" }),
          ].join("\n"),
          stderr: "",
        };
      }
      throw new Error(`unexpected cmd: ${cmd}`);
    });

    const result = await listArtifacts({ environment: "prod", entities: new Map() });

    expect(Object.keys(result).sort()).toEqual([
      "container/db",
      "container/web",
      "image/nginx:latest",
      "image/postgres:16",
      "network/bridge",
    ]);
    expect(result["container/web"]).toMatchObject({
      type: "Docker::Container",
      physicalId: "abc123",
      status: "running",
    });
    expect(result["image/nginx:latest"]).toMatchObject({ type: "Docker::Image", physicalId: "img1" });
    expect(result["network/bridge"]).toMatchObject({ type: "Docker::Network", physicalId: "net1" });
  });

  test("daemon unreachable on all queries → returns {}", async () => {
    execMock.mockImplementation(() => { throw new Error("Cannot connect to the Docker daemon"); });
    const result = await listArtifacts({ environment: "prod", entities: new Map() });
    expect(result).toEqual({});
  });

  test("per-query failure isolation: containers fail → still get images + networks", async () => {
    execMock.mockImplementation((cmd: string) => {
      if (cmd.startsWith("docker ps")) {
        throw new Error("ps failed");
      }
      if (cmd.startsWith("docker image ls")) {
        return { stdout: JSON.stringify({ ID: "img1", Repository: "alpine", Tag: "3.20", Size: "8MB" }), stderr: "" };
      }
      if (cmd.startsWith("docker network ls")) {
        return { stdout: JSON.stringify({ ID: "net1", Name: "host", Driver: "host", Scope: "local" }), stderr: "" };
      }
      throw new Error(`unexpected cmd: ${cmd}`);
    });

    const result = await listArtifacts({ environment: "prod", entities: new Map() });

    expect(Object.keys(result).filter((k) => k.startsWith("container/"))).toEqual([]);
    expect(result["image/alpine:3.20"]).toBeDefined();
    expect(result["network/host"]).toBeDefined();
  });

  test("container Status surfaces in attributes.fullStatus", async () => {
    execMock.mockImplementation((cmd: string) => {
      if (cmd.startsWith("docker ps")) {
        return { stdout: JSON.stringify({ Names: "web", ID: "x", Image: "i", State: "running", Status: "Up 5 minutes" }), stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const result = await listArtifacts({ environment: "prod", entities: new Map() });
    expect(result["container/web"].attributes).toMatchObject({ fullStatus: "Up 5 minutes" });
  });

  test("dangling images (Repository=<none>) are skipped", async () => {
    execMock.mockImplementation((cmd: string) => {
      if (cmd.startsWith("docker image ls")) {
        return {
          stdout: [
            JSON.stringify({ ID: "img1", Repository: "<none>", Tag: "<none>", Size: "8MB" }),
            JSON.stringify({ ID: "img2", Repository: "nginx", Tag: "latest", Size: "187MB" }),
          ].join("\n"),
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    });
    const result = await listArtifacts({ environment: "prod", entities: new Map() });
    expect(Object.keys(result).filter((k) => k.startsWith("image/"))).toEqual(["image/nginx:latest"]);
  });

  test("malformed NDJSON line is skipped, others still parsed", async () => {
    execMock.mockImplementation((cmd: string) => {
      if (cmd.startsWith("docker ps")) {
        return {
          stdout: [
            "this is not json",
            JSON.stringify({ Names: "web", ID: "x", State: "running", Status: "Up", Image: "i" }),
          ].join("\n"),
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    });
    const result = await listArtifacts({ environment: "prod", entities: new Map() });
    expect(result["container/web"]).toBeDefined();
  });
});
