import { describe, test, expect, vi, beforeEach } from "vitest";
import { promisify } from "node:util";
import type { ParsedArgs } from "../registry";
import type { LexiconPlugin } from "../../lexicon";
import type { EmulatorCapability } from "../../op";

// `up`/`down`/`endpoint` come from the shared lifecycle — stub it so the handler's
// wiring (filtering, --json shape, action dispatch) is tested without Docker.
const upMock = vi.fn();
const downMock = vi.fn();

vi.mock("../../op", async () => {
  const actual = await vi.importActual<typeof import("../../op")>("../../op");
  return {
    ...actual,
    emulatorLifecycle: () => ({
      up: (...a: unknown[]) => upMock(...a),
      down: (...a: unknown[]) => downMock(...a),
      endpoint: (port: number) => `http://localhost:${port}`,
    }),
  };
});

// `status` shells `docker ps -q -f name=…` via promisify(exec); drive its stdout,
// or make it fail the way a shell does when docker is not on PATH (#3673).
let dockerPsStdout = "";
let dockerPsError: (Error & { code?: number }) | undefined;
const execWithCustom = Object.assign(() => {}, {
  [promisify.custom]: (_cmd: string) => (dockerPsError ? Promise.reject(dockerPsError) : Promise.resolve({ stdout: dockerPsStdout })),
});
// `docker port` and `docker exec <identity command>` go through execFile (#3673).
let dockerPortStdout = "";
let containerIdentity = "";
const execFileWithCustom = Object.assign(() => {}, {
  [promisify.custom]: (_file: string, argv: string[]) =>
    argv[0] === "port"
      ? (dockerPortStdout ? Promise.resolve({ stdout: dockerPortStdout }) : Promise.reject(new Error("no port")))
      : Promise.resolve({ stdout: `${containerIdentity}\n` }),
});
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, exec: execWithCustom, execFile: execFileWithCustom };
});

const { runEmulator, formatEmulatorHelp, parsePortMappings } = await import("./emulator");

function cap(): EmulatorCapability {
  return {
    spec: { name: "chant-floci", image: "floci/floci:latest", containerPort: 4566, healthPath: "/_localstack/health" },
    env: (endpoint) => ({ AWS_ENDPOINT_URL: endpoint, AWS_REGION: "us-east-1" }),
  };
}

function plugin(name: string, emulator?: EmulatorCapability): LexiconPlugin {
  return { name, emulator } as unknown as LexiconPlugin;
}

function makeArgs(overrides: Partial<ParsedArgs> = {}): ParsedArgs {
  return {
    command: "emulator", path: ".",
    format: "", fix: false, watch: false, verbose: false, help: false, live: false,
    ...overrides,
  };
}

function stdout(): string[] {
  const buf: string[] = [];
  vi.spyOn(console, "log").mockImplementation((s: string) => { buf.push(s); });
  return buf;
}
function stderr(): string[] {
  const buf: string[] = [];
  vi.spyOn(console, "error").mockImplementation((s: string) => { buf.push(s); });
  return buf;
}

describe("runEmulator (#920)", () => {
  beforeEach(() => {
    upMock.mockReset();
    downMock.mockReset();
    dockerPsStdout = "";
    dockerPsError = undefined;
    dockerPortStdout = "";
    containerIdentity = "";
    vi.restoreAllMocks();
  });

  test("rejects a missing / unknown action with usage and exit 1", async () => {
    const err = stderr();
    expect(await runEmulator({ args: makeArgs(), plugins: [plugin("aws", cap())], serializers: [] })).toBe(1);
    expect(err.join("\n")).toContain("Usage: chant emulator");
    expect(await runEmulator({ args: makeArgs({ path: "restart" }), plugins: [], serializers: [] })).toBe(1);
  });

  test("up boots each emulator and reports endpoint + redirect env as JSON", async () => {
    upMock.mockResolvedValue({ endpoint: "http://localhost:4566" });
    const out = stdout();
    const exit = await runEmulator({
      args: makeArgs({ path: "up", json: true }),
      plugins: [plugin("aws", cap()), plugin("gitlab")],
      serializers: [],
    });
    expect(exit).toBe(0);
    expect(upMock).toHaveBeenCalledTimes(1); // gitlab has no emulator → skipped
    expect(JSON.parse(out.join(""))).toEqual({
      emulators: [{
        lexicon: "aws",
        name: "chant-floci",
        endpoint: "http://localhost:4566",
        env: { AWS_ENDPOINT_URL: "http://localhost:4566", AWS_REGION: "us-east-1" },
      }],
    });
  });

  test("--lexicon narrows to the named lexicon", async () => {
    upMock.mockResolvedValue({ endpoint: "http://localhost:4566" });
    const out = stdout();
    await runEmulator({
      args: makeArgs({ path: "up", json: true, lexicon: "azure" }),
      plugins: [plugin("aws", cap()), plugin("azure", cap())],
      serializers: [],
    });
    const parsed = JSON.parse(out.join(""));
    expect(parsed.emulators).toHaveLength(1);
    expect(parsed.emulators[0].lexicon).toBe("azure");
  });

  test("down stops the emulator and reports it as down (no endpoint/env)", async () => {
    downMock.mockResolvedValue(undefined);
    const out = stdout();
    const exit = await runEmulator({
      args: makeArgs({ path: "down", json: true }),
      plugins: [plugin("aws", cap())],
      serializers: [],
    });
    expect(exit).toBe(0);
    expect(downMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(out.join("")).emulators[0]).toEqual({
      lexicon: "aws", name: "chant-floci", endpoint: "", env: {},
    });
  });

  test("status reports up when the container is running, down otherwise", async () => {
    dockerPsStdout = "abc123\n";
    let out = stdout();
    await runEmulator({ args: makeArgs({ path: "status", json: true }), plugins: [plugin("aws", cap())], serializers: [] });
    expect(JSON.parse(out.join("")).emulators[0].endpoint).toBe("http://localhost:4566");
    expect(upMock).not.toHaveBeenCalled(); // status never boots

    vi.restoreAllMocks();
    dockerPsStdout = "";
    out = stdout();
    await runEmulator({ args: makeArgs({ path: "status", json: true }), plugins: [plugin("aws", cap())], serializers: [] });
    const rep = JSON.parse(out.join("")).emulators[0];
    expect(rep.endpoint).toBe("");
    expect(rep.env).toEqual({});
  });

  test("no configured lexicon has an emulator → empty JSON, exit 0", async () => {
    const out = stdout();
    const exit = await runEmulator({
      args: makeArgs({ path: "up", json: true }),
      plugins: [plugin("gitlab"), plugin("github")],
      serializers: [],
    });
    expect(exit).toBe(0);
    expect(JSON.parse(out.join(""))).toEqual({ emulators: [] });
    expect(upMock).not.toHaveBeenCalled();
  });
});

/** A Postgres-like emulator whose server identity the test controls (#3673). */
function pgCap(answer: () => Promise<{ id: string; label: string }>): EmulatorCapability {
  return {
    spec: {
      name: "chant-postgres", image: "postgres:18.6", containerPort: 5432, readyCommand: ["pg_isready"],
      identity: { server: "Postgres", command: ["psql", "-tAc", "select 1"], probe: answer },
      credentials: "user postgres, password chant",
    },
    env: (endpoint) => ({ POSTGRES_URL: endpoint }),
  };
}

describe("runEmulator status checks what it reports (#3673)", () => {
  beforeEach(() => {
    dockerPsStdout = "abc123\n";
    dockerPsError = undefined;
    dockerPortStdout = "";
    containerIdentity = "7694510661154828338";
    vi.restoreAllMocks();
  });

  test("docker missing from PATH is an error and exit 1, not \"down\"", async () => {
    dockerPsError = Object.assign(new Error("/bin/sh: docker: command not found"), { code: 127 });
    const err = stderr();
    const exit = await runEmulator({ args: makeArgs({ path: "status" }), plugins: [plugin("aws", cap())], serializers: [] });
    expect(exit).toBe(1);
    expect(err.join("\n")).toContain("docker not found on PATH; cannot check the emulator");
    expect(err.join("\n")).not.toContain("down");
  });

  test("a docker that cannot reach its daemon is an error too", async () => {
    dockerPsError = Object.assign(new Error("failed"), { code: 1, stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock.\n" });
    const err = stderr();
    expect(await runEmulator({ args: makeArgs({ path: "status" }), plugins: [plugin("aws", cap())], serializers: [] })).toBe(1);
    expect(err.join("\n")).toContain("docker could not list containers (Cannot connect to the Docker daemon");
  });

  test("an endpoint that answers as another Postgres is reported, with no endpoint, and exits 1", async () => {
    const probe = vi.fn(async () => ({ id: "7300000000000000001", label: "PostgreSQL 16.14" }));
    const err = stderr();
    const exit = await runEmulator({ args: makeArgs({ path: "status" }), plugins: [plugin("sql", pgCap(probe))], serializers: [] });
    expect(exit).toBe(1);
    expect(probe).toHaveBeenCalledWith("http://localhost:5432");
    const text = err.join("\n");
    expect(text).toContain("localhost:5432 answers as PostgreSQL 16.14, not the emulator; another Postgres holds 127.0.0.1:5432");
    expect(text).toContain("chant emulator up --lexicon sql --port 5432=<free port>");
    expect(text).not.toContain("up on");

    vi.restoreAllMocks();
    const out = stdout();
    await runEmulator({ args: makeArgs({ path: "status", json: true }), plugins: [plugin("sql", pgCap(probe))], serializers: [] });
    const rep = JSON.parse(out.join("")).emulators[0];
    expect(rep).toMatchObject({ endpoint: "", env: {} });
    expect(rep.conflict).toContain("PostgreSQL 16.14");
  });

  test("an endpoint that refuses the emulator's sign-in is reported as not the emulator", async () => {
    const err = stderr();
    const exit = await runEmulator({
      args: makeArgs({ path: "status" }),
      plugins: [plugin("sql", pgCap(async () => { throw new Error('role "postgres" does not exist'); }))],
      serializers: [],
    });
    expect(exit).toBe(1);
    expect(err.join("\n")).toContain('localhost:5432 does not answer as the emulator (role "postgres" does not exist)');
  });

  test("the same identity through the endpoint reports up, on the port docker published", async () => {
    dockerPortStdout = "0.0.0.0:15432\n[::]:15432\n";
    const probe = vi.fn(async () => ({ id: "7694510661154828338", label: "PostgreSQL 18.6" }));
    const out = stdout();
    const exit = await runEmulator({ args: makeArgs({ path: "status", json: true }), plugins: [plugin("sql", pgCap(probe))], serializers: [] });
    expect(exit).toBe(0);
    expect(probe).toHaveBeenCalledWith("http://localhost:15432");
    expect(JSON.parse(out.join("")).emulators[0]).toEqual({
      lexicon: "sql", name: "chant-postgres", endpoint: "http://localhost:15432", env: { POSTGRES_URL: "http://localhost:15432" },
    });
  });
});

describe("chant emulator --port and --help (#3673)", () => {
  const ch: EmulatorCapability = { ...cap(), spec: { ...cap().spec, name: "chant-clickhouse", containerPort: 8123 } };
  const pg = pgCap(async () => ({ id: "", label: "" }));

  test("--port maps a container port to a host port; a bare port needs one emulator", () => {
    expect(parsePortMappings(["5432=15432"], [ch, pg])).toEqual(new Map([[5432, 15432]]));
    expect(parsePortMappings(["15432"], [pg])).toEqual(new Map([[5432, 15432]]));
    expect(() => parsePortMappings(["15432"], [ch, pg])).toThrow(/ambiguous with 2 emulators/);
    expect(() => parsePortMappings(["3306=13306"], [ch, pg])).toThrow(/no selected emulator listens on 3306/);
    expect(() => parsePortMappings(["abc"], [pg])).toThrow(/expected <container-port>=<host-port>/);
  });

  test("up passes the mapped host port to the lifecycle", async () => {
    upMock.mockResolvedValue({ endpoint: "http://localhost:15432" });
    stderr();
    const exit = await runEmulator({ args: makeArgs({ path: "up", port: ["5432=15432"] }), plugins: [plugin("sql", pg)], serializers: [] });
    expect(exit).toBe(0);
    expect(upMock).toHaveBeenCalledWith({ port: 15432 });
  });

  test("up that fails (a held port) prints the reason and exits 1", async () => {
    upMock.mockRejectedValue(new Error('emulator "chant-postgres": 127.0.0.1:5432 is already held by another process'));
    const err = stderr();
    expect(await runEmulator({ args: makeArgs({ path: "up" }), plugins: [plugin("sql", pg)], serializers: [] })).toBe(1);
    expect(err.join("\n")).toContain("already held by another process");
  });

  test("--help lists the subcommands, flags, and each emulator's port and sign-in", () => {
    const help = formatEmulatorHelp([plugin("sql", pg), plugin("gitlab")]);
    for (const s of ["up ", "down ", "status ", "--lexicon <name>", "--json", "--port <c>=<h>"]) expect(help).toContain(s);
    expect(help).toContain("sql: chant-postgres, port 5432, http://localhost:5432");
    expect(help).toContain("sign in: user postgres, password chant");
    expect(help).toContain("env: POSTGRES_URL=http://localhost:5432");
    expect(help.split("\n").length).toBeLessThan(40);
    expect(formatEmulatorHelp([])).toContain("No lexicon configured for this project has a local emulator.");
  });
});
