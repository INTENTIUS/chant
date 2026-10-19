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
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("runLint on a project whose dependencies are not installed (#4116)", () => {
  let project: string;
  let stderr: string[];

  beforeEach(() => {
    project = realpathSync(mkdtempSync(join(tmpdir(), "chant-4116-lint-")));
    stderr = [];
    loadChantConfigUpwardMock.mockReset().mockResolvedValue({ config: {} });
    vi.spyOn(console, "error").mockImplementation((s: string) => void stderr.push(s));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(project, { recursive: true, force: true });
  });

  const failing = (message: string) =>
    lintCommandMock.mockReset().mockResolvedValue({
      success: false,
      errorCount: 1,
      warningCount: 0,
      diagnostics: [{ file: join(project, "src/a.ts"), line: 1, column: 1, ruleId: "LEX002", severity: "error", message }],
    });

  test("an uninstalled import leads with the dependencies message", async () => {
    failing(`Cannot find package '@intentius/chant-lexicon-aws' imported from ${join(project, "src/a.ts")}`);
    const exit = await runLint({ args: makeArgs({ path: project }), plugins: [], serializers: [] });
    expect(exit).toBe(1);
    expect(stderr.join("\n")).toContain(`dependencies not installed: @intentius/chant-lexicon-aws does not resolve from ${project}`);
  });

  test("a real lint error prints no dependencies message", async () => {
    failing("Exported declarable 'x' is broken");
    const exit = await runLint({ args: makeArgs({ path: project }), plugins: [], serializers: [] });
    expect(exit).toBe(1);
    expect(stderr.join("\n")).not.toContain("dependencies not installed");
  });
});
