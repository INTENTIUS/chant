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

// `status` shells `docker ps -q -f name=…` via promisify(exec); drive its stdout.
let dockerPsStdout = "";
const execWithCustom = Object.assign(() => {}, {
  [promisify.custom]: (_cmd: string) => Promise.resolve({ stdout: dockerPsStdout }),
});
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, exec: execWithCustom };
});

const { runEmulator } = await import("./emulator");

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
