import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DECLARABLE_MARKER, type Declarable } from "../../declarable";
import type { ParsedArgs } from "../registry";

const discoverMock = vi.fn();
vi.mock("../../discovery/index", () => ({
  discover: (...a: unknown[]) => discoverMock(...a),
}));

import { runExplain } from "./explain";

function decl<T extends object>(base: T): Declarable & T {
  return { [DECLARABLE_MARKER]: true, ...base } as Declarable & T;
}

function ctx(overrides: Partial<ParsedArgs>): Parameters<typeof runExplain>[0] {
  return {
    args: { command: "explain", path: ".", format: "", fix: false, watch: false, verbose: false, help: false, live: false, ...overrides } as ParsedArgs,
    plugins: [],
    serializers: [],
  };
}

function discoveryResult() {
  const vpc = decl({ lexicon: "gcp", entityType: "Vpc" });
  const subnet = decl({ lexicon: "gcp", entityType: "Subnet" });
  return {
    entities: new Map<string, Declarable>([
      ["vpc", vpc],
      ["subnet", subnet],
    ]),
    dependencies: new Map([["subnet", new Set(["vpc"])]]),
    sourceFiles: ["net.ts"],
    errors: [],
    foldDecisions: [],
  };
}

describe("runExplain", () => {
  let outDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), "chant-explain-okf-"));
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    discoverMock.mockResolvedValue(discoveryResult());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(outDir, { recursive: true, force: true });
  });

  test("--format okf -o <dir> writes the bundle as a directory tree", async () => {
    const code = await runExplain(ctx({ format: "okf", output: outDir }));
    expect(code).toBe(0);

    expect((await stat(join(outDir, "index.md"))).isFile()).toBe(true);
    const subnet = await readFile(join(outDir, "gcp", "subnet.md"), "utf-8");
    expect(subnet).toContain("type: Subnet");
    expect(subnet).toContain("- [vpc](/gcp/vpc.md)");
  });

  test("--format okf without -o prints the bundle as JSON path -> content", async () => {
    const code = await runExplain(ctx({ format: "okf" }));
    expect(code).toBe(0);

    const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(parsed.okf_version).toBe("0.2");
    expect(Object.keys(parsed.files).sort()).toEqual(["gcp/subnet.md", "gcp/vpc.md", "index.md"]);
  });

  test("default format renders the markdown summary", async () => {
    const code = await runExplain(ctx({}));
    expect(code).toBe(0);
    expect(logSpy.mock.calls[0][0]).toContain("# Project Summary");
  });

  test("an unknown format is rejected", async () => {
    const code = await runExplain(ctx({ format: "xml" }));
    expect(code).toBe(1);
  });

  test("discovery errors surface as a non-zero exit for okf", async () => {
    discoverMock.mockResolvedValue({ ...discoveryResult(), errors: [new Error("boom")] });
    const code = await runExplain(ctx({ format: "okf" }));
    expect(code).toBe(1);
  });
});
