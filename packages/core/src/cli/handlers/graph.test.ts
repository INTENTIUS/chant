import { describe, test, expect, vi, beforeEach } from "vitest";
import type { ParsedArgs } from "../registry";

const discoverOpsMock = vi.fn();
vi.mock("../../op/discover", () => ({
  discoverOps: () => discoverOpsMock(),
}));

const { runGraph } = await import("./graph");

function makeArgs(overrides: Partial<ParsedArgs> = {}): ParsedArgs {
  return {
    command: "graph", path: ".",
    format: "", fix: false, watch: false, verbose: false, help: false, live: false,
    ...overrides,
  };
}

function makeOp(name: string, depends: string[] = []): [string, { config: { name: string; depends?: string[] } }] {
  return [name, { config: { name, depends } }];
}

describe("runGraph", () => {
  let stdoutBuf: string[];
  let stderrBuf: string[];

  beforeEach(() => {
    stdoutBuf = [];
    stderrBuf = [];
    vi.spyOn(console, "log").mockImplementation((s: string) => { stdoutBuf.push(s); });
    vi.spyOn(console, "error").mockImplementation((s: string) => { stderrBuf.push(s); });
    discoverOpsMock.mockReset();
  });

  test("prints 'No Ops found' when discovery is empty", async () => {
    discoverOpsMock.mockResolvedValue({ ops: new Map(), errors: [] });
    const exit = await runGraph({ args: makeArgs(), plugins: [], serializers: [] });
    expect(exit).toBe(0);
    expect(stdoutBuf.join("\n")).toContain("No Ops found");
  });

  test("prints 'No Op dependencies' when ops have no depends", async () => {
    discoverOpsMock.mockResolvedValue({
      ops: new Map([makeOp("solo")]),
      errors: [],
    });
    const exit = await runGraph({ args: makeArgs(), plugins: [], serializers: [] });
    expect(exit).toBe(0);
    expect(stdoutBuf.join("\n")).toContain("No Op dependencies");
  });

  test("prints `dep -> name` edge per dependency", async () => {
    discoverOpsMock.mockResolvedValue({
      ops: new Map([
        makeOp("infra"),
        makeOp("app", ["infra"]),
      ]),
      errors: [],
    });
    const exit = await runGraph({ args: makeArgs(), plugins: [], serializers: [] });
    expect(exit).toBe(0);
    const out = stdoutBuf.join("\n");
    expect(out).toContain("infra → app");
  });

  test("handles multi-edge graphs", async () => {
    discoverOpsMock.mockResolvedValue({
      ops: new Map([
        makeOp("a"),
        makeOp("b", ["a"]),
        makeOp("c", ["a", "b"]),
      ]),
      errors: [],
    });
    await runGraph({ args: makeArgs(), plugins: [], serializers: [] });
    const out = stdoutBuf.join("\n");
    expect(out).toContain("a → b");
    expect(out).toContain("a → c");
    expect(out).toContain("b → c");
  });

  test("forwards discovery errors to stderr", async () => {
    discoverOpsMock.mockResolvedValue({
      ops: new Map(),
      errors: ["failed to parse ops/bad.op.ts"],
    });
    const exit = await runGraph({ args: makeArgs(), plugins: [], serializers: [] });
    expect(exit).toBe(0);
    expect(stderrBuf.join("\n")).toContain("failed to parse ops/bad.op.ts");
  });
});
