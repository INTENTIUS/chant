/**
 * Tests for `chant build --components --generate <lexicon>` (generate mode,
 * #563) — specifically its chant #1108 build-time-parameter resolution,
 * which was entirely missing before this fix: `generateComponentsPipeline`'s
 * `discoverComponents` call never resolved `chant.config.ts`'s declared
 * `buildParams`, so a `*.component.ts` file reading `params.<name>` always
 * saw `{}` under `chant build --components --generate`, exactly like `chant
 * run --components` (see ../handlers/run.test.ts's "build-time parameters"
 * describe block for the equivalent local-run coverage).
 *
 * Mocks `generateComponentsPipeline` and `loadChantConfigUpward` (chant
 * #1117 — `runGenerateComponents` walks up to the project root now, same as
 * `chant build` proper, instead of reading `args.path` alone) and exercises
 * the public `runBuild` dispatcher (`runGenerateComponents` itself isn't
 * exported), mirroring `run.test.ts`'s style of driving the handler through
 * its `CommandContext` entrypoint rather than reaching into private helpers.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";
import type { ParsedArgs } from "../registry";

const generateComponentsPipelineMock = vi.fn();
const loadChantConfigUpwardMock = vi.fn();

vi.mock("../../components/cli-support", () => ({
  generateComponentsPipeline: (...args: unknown[]) => generateComponentsPipelineMock(...args),
}));
vi.mock("../../config", async () => {
  const actual = await vi.importActual<typeof import("../../config")>("../../config");
  return { ...actual, loadChantConfigUpward: (...args: unknown[]) => loadChantConfigUpwardMock(...args) };
});

const { runBuild } = await import("./build");

function makeArgs(overrides: Partial<ParsedArgs> = {}): ParsedArgs {
  return {
    command: "build",
    path: ".",
    format: "",
    fix: false,
    watch: false,
    verbose: false,
    help: false,
    live: false,
    components: true,
    generate: "gitlab",
    ...overrides,
  };
}

function makeStderrSpy() {
  const buf: string[] = [];
  vi.spyOn(console, "error").mockImplementation((s: string) => { buf.push(s); });
  return buf;
}

describe("runBuild --components --generate (chant #1108 build-time parameters)", () => {
  beforeEach(() => {
    generateComponentsPipelineMock.mockReset();
    loadChantConfigUpwardMock.mockReset().mockResolvedValue({ config: {} });
  });

  test("no declared buildParams → generateComponentsPipeline is called with an empty provenance array", async () => {
    generateComponentsPipelineMock.mockResolvedValue({ success: true, yaml: "stages: []", stages: [], jobs: [] });
    vi.spyOn(console, "log").mockImplementation(() => {});

    const exit = await runBuild({ args: makeArgs(), plugins: [], serializers: [] });

    expect(exit).toBe(0);
    expect(generateComponentsPipelineMock).toHaveBeenCalledWith(".", "gitlab", { env: undefined }, undefined, []);
    vi.restoreAllMocks();
  });

  test("chant.config.ts's declared buildParams resolve, log, and are forwarded to generateComponentsPipeline", async () => {
    loadChantConfigUpwardMock.mockResolvedValue({
      config: { buildParams: { tier: { type: "string", default: "light" } } },
    });
    generateComponentsPipelineMock.mockResolvedValue({ success: true, yaml: "stages: []", stages: [], jobs: [] });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const stderr = makeStderrSpy();

    const exit = await runBuild({ args: makeArgs(), plugins: [], serializers: [] });

    expect(exit).toBe(0);
    expect(generateComponentsPipelineMock).toHaveBeenCalledWith(
      ".",
      "gitlab",
      { env: undefined },
      undefined,
      [{ name: "tier", value: "light", source: "default" }],
    );
    // The echo is a one-line count (#1424); the provenance forwarded above
    // is where the value is asserted.
    expect(stderr.join("\n")).toContain("1 build parameter resolved (1 default)");
    vi.restoreAllMocks();
  });

  test("--param overrides a declared default", async () => {
    loadChantConfigUpwardMock.mockResolvedValue({
      config: { buildParams: { tier: { type: "string", default: "light" } } },
    });
    generateComponentsPipelineMock.mockResolvedValue({ success: true, yaml: "stages: []", stages: [], jobs: [] });
    vi.spyOn(console, "log").mockImplementation(() => {});

    const exit = await runBuild({
      args: makeArgs({ param: ["tier=production"] }),
      plugins: [],
      serializers: [],
    });

    expect(exit).toBe(0);
    expect(generateComponentsPipelineMock).toHaveBeenCalledWith(
      ".",
      "gitlab",
      { env: undefined },
      undefined,
      [{ name: "tier", value: "production", source: "cli" }],
    );
    vi.restoreAllMocks();
  });

  test("an unresolved required build-time parameter → exit 1, never reaches generateComponentsPipeline", async () => {
    loadChantConfigUpwardMock.mockResolvedValue({
      config: { buildParams: { tier: { type: "string" } } },
    });
    const stderr = makeStderrSpy();

    const exit = await runBuild({ args: makeArgs(), plugins: [], serializers: [] });

    expect(exit).toBe(1);
    expect(stderr.join("\n")).toMatch(/"tier"/);
    expect(generateComponentsPipelineMock).not.toHaveBeenCalled();
  });

  test("an enum violation on --param → exit 1, never reaches generateComponentsPipeline", async () => {
    loadChantConfigUpwardMock.mockResolvedValue({
      config: { buildParams: { tier: { type: "string", enum: ["light", "production"] } } },
    });
    const stderr = makeStderrSpy();

    const exit = await runBuild({
      args: makeArgs({ param: ["tier=bogus"] }),
      plugins: [],
      serializers: [],
    });

    expect(exit).toBe(1);
    expect(stderr.join("\n")).toMatch(/"tier"/);
    expect(stderr.join("\n")).toMatch(/bogus/);
    expect(generateComponentsPipelineMock).not.toHaveBeenCalled();
  });
});

/**
 * chant #2060. `chant build --components --generate --format json` forwarded
 * only `{ stages, jobs, yaml }`, dropping `result.env` even though the
 * generator (#2046, PR #2050) resolves and returns it. A consumer reading the
 * structured output (behold does) had no environment identity except by
 * parsing the YAML back, which #2046 was meant to retire.
 */
describe("runBuild --components --generate --format json (chant #2060 env passthrough)", () => {
  beforeEach(() => {
    generateComponentsPipelineMock.mockReset();
    loadChantConfigUpwardMock.mockReset().mockResolvedValue({ config: {} });
  });

  test("--format json includes result.env alongside stages, jobs and yaml", async () => {
    generateComponentsPipelineMock.mockResolvedValue({
      success: true,
      yaml: "name: chant-components-prod\nenv:\n  CHANT_ENV: prod\n",
      stages: ["deploy"],
      jobs: [{ jobName: "deploy-web", component: "web", stage: "deploy", needs: [] }],
      env: "prod",
    });
    const stdout: string[] = [];
    vi.spyOn(console, "log").mockImplementation((s: string) => { stdout.push(s); });

    const exit = await runBuild({
      args: makeArgs({ format: "json", env: "prod" }),
      plugins: [],
      serializers: [],
    });

    expect(exit).toBe(0);
    expect(stdout).toHaveLength(1);
    const printed = JSON.parse(stdout[0]);
    expect(printed).toEqual({
      stages: ["deploy"],
      jobs: [{ jobName: "deploy-web", component: "web", stage: "deploy", needs: [] }],
      yaml: "name: chant-components-prod\nenv:\n  CHANT_ENV: prod\n",
      env: "prod",
    });
    vi.restoreAllMocks();
  });

  test("--format json omits env when the generator's result carries none", async () => {
    generateComponentsPipelineMock.mockResolvedValue({
      success: true,
      yaml: "stages: []",
      stages: [],
      jobs: [],
    });
    const stdout: string[] = [];
    vi.spyOn(console, "log").mockImplementation((s: string) => { stdout.push(s); });

    const exit = await runBuild({ args: makeArgs({ format: "json" }), plugins: [], serializers: [] });

    expect(exit).toBe(0);
    const printed = JSON.parse(stdout[0]);
    expect(printed).toEqual({ stages: [], jobs: [], yaml: "stages: []" });
    expect(printed).not.toHaveProperty("env");
    vi.restoreAllMocks();
  });

  test("the default text format is unchanged: env is not forwarded and only the raw yaml is printed", async () => {
    generateComponentsPipelineMock.mockResolvedValue({
      success: true,
      yaml: "name: chant-components-prod\nenv:\n  CHANT_ENV: prod\n",
      stages: ["deploy"],
      jobs: [{ jobName: "deploy-web", component: "web", stage: "deploy", needs: [] }],
      env: "prod",
    });
    const stdout: string[] = [];
    vi.spyOn(console, "log").mockImplementation((s: string) => { stdout.push(s); });

    const exit = await runBuild({ args: makeArgs({ env: "prod" }), plugins: [], serializers: [] });

    expect(exit).toBe(0);
    expect(stdout).toEqual(["name: chant-components-prod\nenv:\n  CHANT_ENV: prod\n"]);
    vi.restoreAllMocks();
  });
});
