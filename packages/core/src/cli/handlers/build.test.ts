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

// #4550's engine lines load each lexicon the project lists, and with path "." that is this repository's every lexicon,
// 10 to 20s cold. The generator is mocked here, so no test reads the lines: the project lists none.
vi.mock("../plugins", async () => {
  const actual = await vi.importActual<typeof import("../plugins")>("../plugins");
  return { ...actual, resolveProjectLexicons: async () => [] };
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

  test("--promote-to that skips a step of the declared promotion order is refused, and generates nothing (#4030)", async () => {
    loadChantConfigUpwardMock.mockResolvedValue({ config: { environments: ["dev", "staging", "prod"] } });
    const stderr = makeStderrSpy();
    const exit = await runBuild({ args: makeArgs({ env: "dev", promoteTo: "prod" }), plugins: [], serializers: [] });
    expect(exit).toBe(1);
    expect(generateComponentsPipelineMock).not.toHaveBeenCalled();
    const out = stderr.join("\n");
    expect(out).toMatch(/\[promote-skips-environment\]/);
    expect(out).toMatch(/--allow-skip/);
  });

  test("--promote-to the next step of the order generates as before (#4030)", async () => {
    loadChantConfigUpwardMock.mockResolvedValue({ config: { environments: ["dev", "staging", "prod"] } });
    generateComponentsPipelineMock.mockResolvedValue({ success: true, yaml: "x", stages: [], jobs: [] });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const exit = await runBuild({ args: makeArgs({ env: "staging", promoteTo: "prod" }), plugins: [], serializers: [] });
    expect(exit).toBe(0);
    expect(generateComponentsPipelineMock.mock.calls[0][2]).toEqual({ env: "staging", promoteTo: "prod" });
  });

  test("--allow-skip lets the skip through and the promote job passes it on (#4030)", async () => {
    loadChantConfigUpwardMock.mockResolvedValue({ config: { environments: ["dev", "staging", "prod"] } });
    generateComponentsPipelineMock.mockResolvedValue({ success: true, yaml: "x", stages: [], jobs: [] });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const exit = await runBuild({ args: makeArgs({ env: "dev", promoteTo: "prod", allowSkip: true }), plugins: [], serializers: [] });
    expect(exit).toBe(0);
    expect(generateComponentsPipelineMock.mock.calls[0][2]).toMatchObject({
      promoteCommand: ["chant", "components", "promote", "--from", "dev", "--to", "prod", "--allow-skip"],
    });
  });

  test("--promote-to is forwarded to the generator as promoteTo (#2575)", async () => {
    generateComponentsPipelineMock.mockResolvedValue({ success: true, yaml: "stages: []", stages: [], jobs: [] });
    vi.spyOn(console, "log").mockImplementation(() => {});

    const exit = await runBuild({ args: makeArgs({ env: "staging", promoteTo: "prod" }), plugins: [], serializers: [] });

    expect(exit).toBe(0);
    expect(generateComponentsPipelineMock).toHaveBeenCalledWith(".", "gitlab", { env: "staging", promoteTo: "prod" }, undefined, []);
    vi.restoreAllMocks();
  });

  test("--image and each --before-script are forwarded to the generator, in order (#4002)", async () => {
    generateComponentsPipelineMock.mockResolvedValue({ success: true, yaml: "stages: []", stages: [], jobs: [] });
    vi.spyOn(console, "log").mockImplementation(() => {});

    const exit = await runBuild({
      args: makeArgs({ generate: "forgejo", prLoop: true, image: "node:22-bookworm", beforeScript: ["npm ci", "npm run setup"] }),
      plugins: [],
      serializers: [],
    });

    expect(exit).toBe(0);
    expect(generateComponentsPipelineMock).toHaveBeenCalledWith(
      ".",
      "forgejo",
      { env: undefined, prLoop: {}, image: "node:22-bookworm", beforeScript: ["npm ci", "npm run setup"] },
      undefined,
      [],
    );
    vi.restoreAllMocks();
  });

  test("--pr-loop with --events-json and --report-url asks the generated jobs for both (#4007)", async () => {
    generateComponentsPipelineMock.mockResolvedValue({ success: true, yaml: "stages: []", stages: [], jobs: [] });
    vi.spyOn(console, "log").mockImplementation(() => {});

    const exit = await runBuild({
      args: makeArgs({ generate: "github", prLoop: true, eventsJson: true, reportUrl: "s3://reports/acme" }),
      plugins: [],
      serializers: [],
    });

    expect(exit).toBe(0);
    expect(generateComponentsPipelineMock).toHaveBeenCalledWith(".", "github", { env: undefined, prLoop: { events: true, reportUrl: "s3://reports/acme" } }, undefined, []);
    vi.restoreAllMocks();
  });

  test("--pr-loop asks for --require-review only under --require-review or the review-rules security group (#4168)", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { execFileSync } = await import("node:child_process");
    const root = mkdtempSync(join(tmpdir(), "chant-build-review-rules-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: root });
      mkdirSync(join(root, "app"));
      const declare = (extra: Record<string, unknown>) =>
        writeFileSync(join(root, "chant.workspace.json"), JSON.stringify({ name: "acme", schema: 1, ...extra, members: [{ name: "app", dir: "app", kind: "chant", because: "the app" }] }));
      generateComponentsPipelineMock.mockResolvedValue({ success: true, yaml: "jobs: {}", stages: [], jobs: [] });
      vi.spyOn(console, "log").mockImplementation(() => {});
      const path = join(root, "app");
      const output = join(root, "out.yml");

      declare({});
      expect(await runBuild({ args: makeArgs({ path, output, generate: "github", prLoop: true }), plugins: [], serializers: [] })).toBe(0);
      expect(generateComponentsPipelineMock.mock.calls[0][2].prLoop).toEqual({});
      expect(await runBuild({ args: makeArgs({ path, output, generate: "github", prLoop: true, requireReview: true }), plugins: [], serializers: [] })).toBe(0);
      expect(generateComponentsPipelineMock.mock.calls[1][2].prLoop).toEqual({ requireReview: true });

      declare({ security: ["review-rules"] });
      expect(await runBuild({ args: makeArgs({ path, output, generate: "github", prLoop: true }), plugins: [], serializers: [] })).toBe(0);
      expect(generateComponentsPipelineMock.mock.calls[2][2].prLoop).toEqual({ requireReview: true });

      // #4168 step 7: a member's own group counts, and isolated-runners asks for --require-runner-start.
      writeFileSync(join(root, "chant.workspace.json"), JSON.stringify({ name: "acme", schema: 1, members: [{ name: "app", dir: "app", kind: "chant", because: "the app", security: ["isolated-runners"] }] }));
      expect(await runBuild({ args: makeArgs({ path, output, generate: "github", prLoop: true }), plugins: [], serializers: [] })).toBe(0);
      expect(generateComponentsPipelineMock.mock.calls[3][2].prLoop).toEqual({ requireRunnerStart: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
      vi.restoreAllMocks();
    }
  });

  test("--pr-loop without --report-url bakes the workspace's ci.reportUrl into the jobs, and the flag wins (#4160)", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { execFileSync } = await import("node:child_process");
    const root = mkdtempSync(join(tmpdir(), "chant-build-report-url-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: root });
      mkdirSync(join(root, "app"));
      writeFileSync(
        join(root, "chant.workspace.json"),
        JSON.stringify({ name: "acme", schema: 1, ci: { reportUrl: "s3://acme-reports/prod/" }, members: [{ name: "app", dir: "app", kind: "chant", because: "the app" }] }),
      );
      generateComponentsPipelineMock.mockResolvedValue({ success: true, yaml: "jobs: {}", stages: [], jobs: [] });
      vi.spyOn(console, "log").mockImplementation(() => {});
      const path = join(root, "app");
      const output = join(root, "out.yml");

      expect(await runBuild({ args: makeArgs({ path, output, generate: "github", prLoop: true }), plugins: [], serializers: [] })).toBe(0);
      expect(generateComponentsPipelineMock.mock.calls[0][2].prLoop).toEqual({ reportUrl: "s3://acme-reports/prod" });

      expect(await runBuild({ args: makeArgs({ path, output, generate: "github", prLoop: true, reportUrl: "file:///srv/reports" }), plugins: [], serializers: [] })).toBe(0);
      expect(generateComponentsPipelineMock.mock.calls[1][2].prLoop).toEqual({ reportUrl: "file:///srv/reports" });

      // Without --pr-loop the declaration's URL is not read and nothing changes.
      expect(await runBuild({ args: makeArgs({ path, output, generate: "github" }), plugins: [], serializers: [] })).toBe(0);
      expect(generateComponentsPipelineMock.mock.calls[2][2]).not.toHaveProperty("prLoop");
    } finally {
      rmSync(root, { recursive: true, force: true });
      vi.restoreAllMocks();
    }
  });

  test("--pr-loop outside any workspace has no report URL unless the flag gives one (#4160)", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const plain = mkdtempSync(join(tmpdir(), "chant-build-plain-"));
    try {
      generateComponentsPipelineMock.mockResolvedValue({ success: true, yaml: "jobs: {}", stages: [], jobs: [] });
      vi.spyOn(console, "log").mockImplementation(() => {});
      expect(await runBuild({ args: makeArgs({ path: plain, generate: "github", prLoop: true }), plugins: [], serializers: [] })).toBe(0);
      expect(generateComponentsPipelineMock).toHaveBeenCalledWith(plain, "github", { env: undefined, prLoop: {} }, undefined, []);
    } finally {
      rmSync(plain, { recursive: true, force: true });
      vi.restoreAllMocks();
    }
  });

  test("an invalid ci.reportUrl stops --pr-loop with its reason code, and generates nothing (#4160)", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { execFileSync } = await import("node:child_process");
    const root = mkdtempSync(join(tmpdir(), "chant-build-report-url-bad-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: root });
      mkdirSync(join(root, "app"));
      writeFileSync(join(root, "chant.workspace.json"), JSON.stringify({ name: "acme", schema: 1, ci: { reportUrl: "https://reports.example" }, members: [{ name: "app", dir: "app", kind: "chant", because: "the app" }] }));
      const stderr = makeStderrSpy();
      expect(await runBuild({ args: makeArgs({ path: join(root, "app"), generate: "github", prLoop: true }), plugins: [], serializers: [] })).toBe(1);
      expect(generateComponentsPipelineMock).not.toHaveBeenCalled();
      expect(stderr.join("\n")).toMatch(/ci\.reportUrl https:\/\/reports\.example: .*\[declaration-invalid\]/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      vi.restoreAllMocks();
    }
  });

  test("--pr-build and --pr-build-command become the prLoop build options (#4088)", async () => {
    generateComponentsPipelineMock.mockResolvedValue({ success: true, yaml: "jobs: {}", stages: [], jobs: [] });
    vi.spyOn(console, "log").mockImplementation(() => {});

    const exit = await runBuild({
      args: makeArgs({ generate: "github", prLoop: true, prBuild: true, prBuildCommand: "npm run build" }),
      plugins: [],
      serializers: [],
    });

    expect(exit).toBe(0);
    expect(generateComponentsPipelineMock).toHaveBeenCalledWith(".", "github", { env: undefined, prLoop: { build: true, buildCommand: "npm run build" } }, undefined, []);
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
