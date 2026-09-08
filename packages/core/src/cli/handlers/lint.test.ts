/**
 * chant #2251 — `chant lint` resolves this invocation's declared build-time
 * parameters before it lints.
 *
 * The gap this covers: `runLint` built its `LintOptions` without ever
 * touching `chant.config.ts`'s `buildParams`, so the OPS* checks imported
 * every `*.op.ts` file with `params` (`@intentius/chant/params`) still empty.
 * An Op taking a step argument from `params.<name>` therefore read
 * `undefined` and OPS012 reported the activity contract violated on source
 * that builds and runs — reproducible on any project with an Op that reads a
 * build parameter, `--param` and the declared `env` mapping alike (the
 * resolution never ran at all, so no input could reach it).
 *
 * Mocks `lintCommand` and `loadChantConfigUpward` and drives the exported
 * `runLint` dispatcher, the same shape ./build.test.ts uses for the matching
 * #1108 gap in generate mode.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import type { ParsedArgs } from "../registry";

const lintCommandMock = vi.fn();
const loadChantConfigUpwardMock = vi.fn();

vi.mock("../commands/lint", async () => {
  const actual = await vi.importActual<typeof import("../commands/lint")>("../commands/lint");
  return {
    ...actual,
    lintCommand: (...args: unknown[]) => lintCommandMock(...args),
    printLintResult: () => {},
  };
});
vi.mock("../../config", async () => {
  const actual = await vi.importActual<typeof import("../../config")>("../../config");
  return { ...actual, loadChantConfigUpward: (...args: unknown[]) => loadChantConfigUpwardMock(...args) };
});

const { runLint } = await import("./lint");

function makeArgs(overrides: Partial<ParsedArgs> = {}): ParsedArgs {
  return {
    command: "lint",
    path: ".",
    format: "",
    fix: false,
    watch: false,
    verbose: false,
    help: false,
    live: false,
    ...overrides,
  };
}

describe("runLint build-time parameters (#2251)", () => {
  beforeEach(() => {
    lintCommandMock.mockReset().mockResolvedValue({ success: true, errorCount: 0, warningCount: 0, diagnostics: [] });
    loadChantConfigUpwardMock.mockReset().mockResolvedValue({ config: {} });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("a project declaring no buildParams lints with an empty provenance array", async () => {
    const exit = await runLint({ args: makeArgs(), plugins: [], serializers: [] });

    expect(exit).toBe(0);
    expect(lintCommandMock.mock.calls[0][0].buildParams).toEqual([]);
  });

  test("declared buildParams resolve from their defaults and reach lintCommand", async () => {
    loadChantConfigUpwardMock.mockResolvedValue({
      config: { buildParams: { env: { type: "string", default: "local" } } },
    });

    const exit = await runLint({ args: makeArgs(), plugins: [], serializers: [] });

    expect(exit).toBe(0);
    expect(lintCommandMock.mock.calls[0][0].buildParams).toEqual([
      { name: "env", value: "local", source: "default" },
    ]);
  });

  test("--param overrides the declared default, the same precedence chant build applies", async () => {
    loadChantConfigUpwardMock.mockResolvedValue({
      config: { buildParams: { env: { type: "string", default: "local" } } },
    });

    const exit = await runLint({ args: makeArgs({ param: ["env=pr-42"] }), plugins: [], serializers: [] });

    expect(exit).toBe(0);
    expect(lintCommandMock.mock.calls[0][0].buildParams).toEqual([
      { name: "env", value: "pr-42", source: "cli" },
    ]);
  });

  test("an unresolvable parameter exits non-zero without linting", async () => {
    loadChantConfigUpwardMock.mockResolvedValue({
      config: { buildParams: { env: { type: "string", required: true } } },
    });

    const exit = await runLint({ args: makeArgs(), plugins: [], serializers: [] });

    expect(exit).toBe(1);
    expect(lintCommandMock).not.toHaveBeenCalled();
  });
});
