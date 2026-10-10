import { describe, test, expect, vi, beforeEach } from "vitest";
import { createServer } from "node:net";
import { promisify } from "node:util";
import type { EmulatorIdentity } from "./emulator-lifecycle";

// `up` reads `docker ps` through exec and `docker port` / `docker exec` through
// execFile; drive their output so the reuse path runs without Docker.
let dockerPs = "";
let dockerPort = "";
let insideId = "";
const execCalls: string[] = [];
const execStub = Object.assign(() => {}, {
  [promisify.custom]: (cmd: string) => {
    execCalls.push(cmd);
    return Promise.resolve({ stdout: cmd.startsWith("docker ps") ? dockerPs : "" });
  },
});
const execFileStub = Object.assign(() => {}, {
  [promisify.custom]: (_file: string, argv: string[]) =>
    argv[0] === "port"
      ? (dockerPort ? Promise.resolve({ stdout: dockerPort }) : Promise.reject(new Error("no public port")))
      : Promise.resolve({ stdout: `${insideId}\n` }),
});
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, exec: execStub, execFile: execFileStub };
});

const { clientHosts, emulatorLifecycle, endpointOnHost, hostPortInUse, parsePublishedAddresses, pickReachableEndpoint } =
  await import("./emulator-lifecycle");

describe("emulatorLifecycle command builders", () => {
  const emu = emulatorLifecycle({
    name: "chant-x",
    image: "org/x:1.0",
    containerPort: 4200,
    healthPath: "/_x/health",
  });

  test("runCommand uses defaults and maps host port to the container port", () => {
    expect(emu.runCommand()).toBe("docker run -d --rm --name chant-x -p 4200:4200 org/x:1.0");
  });

  test("runCommand honors name/port/image overrides (host port maps to containerPort)", () => {
    expect(emu.runCommand({ name: "x2", port: 4599, image: "org/x:2.0" })).toBe(
      "docker run -d --rm --name x2 -p 4599:4200 org/x:2.0",
    );
  });

  test("spec.runArgs and per-call extraArgs precede the image", () => {
    const e = emulatorLifecycle({
      name: "n",
      image: "img:1",
      containerPort: 80,
      healthPath: "/h",
      runArgs: ["--pull", "always"],
    });
    expect(e.runCommand({ extraArgs: ["-v", "/sock:/sock"] })).toBe(
      "docker run -d --rm --name n -p 80:80 --pull always -v /sock:/sock img:1",
    );
  });

  test("exists / rm / health / endpoint", () => {
    expect(emu.existsCommand("n")).toBe("docker ps -q -f name=n");
    expect(emu.rmCommand("n")).toBe("docker rm -f n");
    expect(emu.healthUrl(4599)).toBe("http://localhost:4599/_x/health");
    expect(emu.endpoint(4599)).toBe("http://localhost:4599");
  });
});

describe("an emulator reached by its own client, not over HTTP", () => {
  const pg = emulatorLifecycle({
    name: "chant-postgres",
    image: "postgres:18",
    containerPort: 5432,
    readyCommand: ["pg_isready", "-h", "127.0.0.1"],
    endpoint: (port) => `postgres://postgres@localhost:${port}/postgres`,
  });

  test("readiness is a command run in the container", () => {
    expect(pg.readyExecCommand("chant-postgres")).toBe("docker exec chant-postgres pg_isready -h 127.0.0.1");
    expect(emulatorLifecycle({ name: "x", image: "x:1", containerPort: 1, healthPath: "/h" }).readyExecCommand("x")).toBeUndefined();
  });

  test("the endpoint is the declared one, not an http URL", () => {
    expect(pg.endpoint(55432)).toBe("postgres://postgres@localhost:55432/postgres");
  });

  test("a spec with neither a health path nor a ready command is refused", () => {
    expect(() => emulatorLifecycle({ name: "x", image: "x:1", containerPort: 1 })).toThrow(/neither a healthPath nor a readyCommand/);
  });
});

describe("hostPortInUse (#3673)", () => {
  test("is true while a process listens on 127.0.0.1:<port>, false once it stops", async () => {
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as { port: number };
    expect(await hostPortInUse(port)).toBe(true);
    await new Promise<void>((r) => server.close(() => r()));
    expect(await hostPortInUse(port)).toBe(false);
  });
});

describe("a reused container's real address", () => {
  test("parsePublishedAddresses reads docker port output, IPv4 and IPv6", () => {
    expect(parsePublishedAddresses("0.0.0.0:15432\n[::]:15432\n")).toEqual([
      { ip: "0.0.0.0", port: 15432 },
      { ip: "::", port: 15432 },
    ]);
    expect(parsePublishedAddresses("")).toEqual([]);
  });

  test("clientHosts dials localhost first, then the IPv6 loopback and specific IPs", () => {
    expect(clientHosts([{ ip: "::", port: 5432 }, { ip: "0.0.0.0", port: 5432 }])).toEqual([
      { host: "localhost", port: 5432 },
      { host: "[::1]", port: 5432 },
    ]);
    expect(clientHosts([{ ip: "192.168.5.2", port: 5433 }])).toEqual([{ host: "192.168.5.2", port: 5433 }]);
  });

  test("endpointOnHost swaps only the host", () => {
    expect(endpointOnHost("postgres://localhost:5432/postgres", "[::1]")).toBe("postgres://[::1]:5432/postgres");
    expect(endpointOnHost("http://localhost:8123", "10.0.0.4")).toBe("http://10.0.0.4:8123");
    expect(endpointOnHost("http://localhost:8123", "localhost")).toBe("http://localhost:8123");
  });

  const identity = (answers: Record<string, string | Error>): EmulatorIdentity => ({
    server: "Postgres",
    command: ["id"],
    async probe(endpoint) {
      const answer = answers[new URL(endpoint).host];
      if (answer === undefined || answer instanceof Error) throw answer ?? new Error("connection refused");
      return { id: answer, label: answer === "emu" ? "PostgreSQL 18.1" : "PostgreSQL 15.4" };
    },
  });
  const endpoint = (port: number) => `postgres://localhost:${port}/postgres`;

  test("pickReachableEndpoint names the address that works when localhost reaches another server", async () => {
    const picked = await pickReachableEndpoint({
      name: "chant-postgres",
      hosts: [{ host: "localhost", port: 5432 }, { host: "[::1]", port: 5432 }],
      endpoint,
      identity: identity({ "localhost:5432": "native", "[::1]:5432": "emu" }),
      inside: "emu",
      hint: "",
    });
    expect(picked).toEqual({
      endpoint: "postgres://[::1]:5432/postgres",
      notes: [
        'emulator "chant-postgres": localhost:5432 reaches another Postgres (PostgreSQL 15.4), not the emulator. ' +
          "The emulator answers on postgres://[::1]:5432/postgres; use that address.",
      ],
    });
  });

  test("pickReachableEndpoint fails plainly when no published address reaches the emulator", async () => {
    const picked = await pickReachableEndpoint({
      name: "chant-postgres",
      hosts: [{ host: "localhost", port: 5432 }],
      endpoint,
      identity: identity({ "localhost:5432": "native" }),
      inside: "emu",
      hint: "Republish it.",
    });
    expect(picked).toEqual({
      error: 'emulator "chant-postgres" runs, but no address it publishes reaches it: localhost:5432 reaches another Postgres (PostgreSQL 15.4), not the emulator. Republish it.',
    });
  });

  describe("up, reusing a running container", () => {
    beforeEach(() => {
      dockerPs = "abc123\n";
      dockerPort = "";
      insideId = "emu";
      execCalls.length = 0;
      vi.spyOn(console, "error").mockImplementation(() => {});
    });
    const spec = (answers: Record<string, string | Error>) => ({
      name: "chant-postgres",
      image: "postgres:18",
      containerPort: 5432,
      readyCommand: ["pg_isready"],
      endpoint,
      identity: identity(answers),
    });

    test("reports the port Docker publishes, not the default", async () => {
      dockerPort = "0.0.0.0:15432\n";
      const lc = emulatorLifecycle(spec({ "localhost:15432": "emu" }));
      expect(await lc.up({ intervalMs: 1 })).toEqual({ endpoint: "postgres://localhost:15432/postgres" });
      expect(execCalls.some((c) => c.startsWith("docker run"))).toBe(false);
    });

    test("prints the working address when another server holds localhost", async () => {
      dockerPort = "0.0.0.0:5432\n[::]:5432\n";
      const err: string[] = [];
      vi.spyOn(console, "error").mockImplementation((s: string) => { err.push(s); });
      const lc = emulatorLifecycle(spec({ "localhost:5432": "native", "[::1]:5432": "emu" }));
      expect(await lc.up({ intervalMs: 1 })).toEqual({ endpoint: "postgres://[::1]:5432/postgres" });
      expect(err.join("\n")).toContain("localhost:5432 reaches another Postgres (PostgreSQL 15.4), not the emulator");
      expect(err.at(-1)).toBe('emulator "chant-postgres" ready on postgres://[::1]:5432/postgres');
    });

    test("refuses when no address reaches the emulator, or nothing is published", async () => {
      dockerPort = "0.0.0.0:5432\n";
      await expect(emulatorLifecycle(spec({ "localhost:5432": "native" })).up({ intervalMs: 1 }))
        .rejects.toThrow(/no address it publishes reaches it: localhost:5432 reaches another Postgres/);
      dockerPort = "";
      await expect(emulatorLifecycle(spec({})).up({ intervalMs: 1 }))
        .rejects.toThrow(/publishes no host port for 5432/);
    });
  });
});
