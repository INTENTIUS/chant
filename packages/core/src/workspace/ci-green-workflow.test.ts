/**
 * #3573 — the root CI file that runs `chant ci tick`: which workflows trigger
 * it, what it says, and `chant ci workflow` writing and recording it under
 * the generated-file rules (ws-042, #2524 D14).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import { GENERATED_MARKER } from "../discovery/files";
import type { CommandContext } from "../cli/registry";
import { parseYAMLDocument } from "../yaml";
import { runCiWorkflow } from "./ci-green-cli";
import { BUILD_BLOCK_MARKER, buildTriggerEdits, CI_GREEN_WORKFLOW_FILE, dispatchableWorkflows, jobCheckRuns, renderCiGreenWorkflow, workflowsHolding, writeTopLevel } from "./ci-green-workflow";
import { parseDeclaration } from "./declaration";
import { cleanScratch, declaration, git, scratchDir, writeFiles } from "./__fixtures__/contract-repo";

afterAll(cleanScratch);

/** A parsed workflow, read by key path in the assertions. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Yaml = Record<string, any>;

const GREEN = {
  branch: "main",
  phases: { lint: ["lint"], test: ["test", "e2e (*)"], macos: { runs: ["macos (test)"], skipped: "pass" }, docs: ["docs"] },
  require: ["lint", "test", "macos"],
};
const green = parseDeclaration(JSON.stringify({ name: "w", schema: 1, members: [], ci: { green: GREEN } }), "chant.workspace.json").ci!.green!;

const CI = `name: ci
on: push
jobs:
  lint:
    runs-on: ubuntu-latest
  test:
    runs-on: ubuntu-latest
  e2e:
    strategy:
      matrix:
        browser: [chromium, webkit]
`;
const MACOS = `on: push
jobs:
  mac:
    name: macos (\${{ matrix.target }})
    strategy:
      matrix:
        target: [test, webkit]
`;
const DOCS = `name: docs
jobs:
  docs:
    runs-on: ubuntu-latest
`;

describe("the workflows that hold required check runs (#3573)", () => {
  test("a job reports its name or id, with matrix values or a called workflow's job after it", () => {
    expect(jobCheckRuns(parseYAMLDocument(CI))).toEqual(["lint", "test", "e2e", "e2e (*)"]);
    expect(jobCheckRuns(parseYAMLDocument(MACOS))).toEqual(["macos (*)"]);
    expect(jobCheckRuns({ jobs: { deploy: { uses: "./.github/workflows/deploy.yml" } } })).toEqual(["deploy", "deploy / *"]);
  });

  test("keeps the workflows whose jobs meet a required phase's pattern, by name or by path", () => {
    const scan = workflowsHolding(green, [
      { path: ".github/workflows/ci.yml", text: CI },
      { path: ".github/workflows/macos.yml", text: MACOS },
      { path: ".github/workflows/docs.yml", text: DOCS },
      { path: ".github/workflows/broken.yml", text: "jobs: [" },
    ]);
    // docs is a declared phase but not a required one, so its workflow does not trigger a tick.
    expect(scan).toEqual({ workflows: [".github/workflows/macos.yml", "ci"], unmatched: [], unreadable: [".github/workflows/broken.yml"] });
    expect(workflowsHolding(green, [{ path: ".github/workflows/ci.yml", text: CI }]).unmatched).toEqual([{ phase: "macos", pattern: "macos (test)" }]);
  });

  test("runs the tick on completion of each, on a 15-minute cron, one at a time, with the rights it needs", () => {
    const text = renderCiGreenWorkflow({ green, workflows: ["ci", "macos"], chantVersion: "0.108.0", workspaceRoot: "." });
    const doc = parseYAMLDocument(text) as Yaml;
    expect(doc.name).toBe("chant-ci-green");
    expect(doc.on.workflow_run).toEqual({ workflows: ["ci", "macos"], types: ["completed"], branches: ["main"] });
    expect(doc.on.schedule).toEqual([{ cron: "*/15 * * * *" }]);
    expect(doc.concurrency).toEqual({ group: "chant-ci-green", "cancel-in-progress": false });
    expect(doc.permissions).toEqual({ contents: "write", checks: "read" });
    const steps = doc.jobs.tick.steps;
    expect(steps[0]).toEqual({ uses: "actions/checkout@v6", with: { ref: "main", "fetch-depth": 0 } });
    expect(steps[2].run).toBe("npx --yes @intentius/chant@0.108.0 ci tick");
    expect(steps[2]["working-directory"]).toBeUndefined();
    expect(steps[2].env.GITHUB_TOKEN).toBe("${{ github.token }}");
    const nested = parseYAMLDocument(renderCiGreenWorkflow({ green, workflows: ["ci"], chantVersion: "0.108.0", workspaceRoot: "infra" })) as Yaml;
    expect(nested.jobs.tick.steps[2]["working-directory"]).toBe("infra");
  });

  test("--chant replaces the npx pin, and --install adds a cached install step before the tick", () => {
    const own = parseYAMLDocument(
      renderCiGreenWorkflow({ green, workflows: ["ci"], chantVersion: "0.108.0", workspaceRoot: ".", chant: "npx tsx packages/core/src/cli/main.ts", install: "npm install --ignore-scripts", npmLock: "package-lock.json" }),
    ) as Yaml;
    const steps = own.jobs.tick.steps;
    expect(steps[1].with).toEqual({ "node-version": "24", cache: "npm" });
    expect(steps[2]).toEqual({ name: "Install what the tick runs", run: "npm install --ignore-scripts" });
    expect(steps[3].run).toBe("npx tsx packages/core/src/cli/main.ts ci tick");

    // In a nested workspace root both steps run there, and the cache keys on that root's lockfile.
    const nested = parseYAMLDocument(
      renderCiGreenWorkflow({ green, workflows: ["ci"], chantVersion: "0.108.0", workspaceRoot: "infra", chant: "npx chant", install: "npm ci", npmLock: "infra/package-lock.json" }),
    ) as Yaml;
    expect(nested.jobs.tick.steps[1].with).toEqual({ "node-version": "24", cache: "npm", "cache-dependency-path": "infra/package-lock.json" });
    expect(nested.jobs.tick.steps[2]["working-directory"]).toBe("infra");
    expect(nested.jobs.tick.steps[3]["working-directory"]).toBe("infra");

    // A command YAML would misread as a mapping or a comment stays one string.
    const odd = parseYAMLDocument(renderCiGreenWorkflow({ green, workflows: ["ci"], chantVersion: "0.108.0", workspaceRoot: ".", chant: "env A=b: c # x chant" })) as Yaml;
    expect(odd.jobs.tick.steps).toHaveLength(3);
    expect(odd.jobs.tick.steps[1].with).toEqual({ "node-version": "24" });
    expect(odd.jobs.tick.steps[2].run).toBe("env A=b: c # x chant ci tick");
  });
});

describe("the token the tick pushes its tags with (#3573)", () => {
  const base = { green, workflows: ["ci"], chantVersion: "0.108.0", workspaceRoot: "." };

  test("without one, checkout persists the Actions token and the tick reads check runs with it", () => {
    const steps = (parseYAMLDocument(renderCiGreenWorkflow(base)) as Yaml).jobs.tick.steps;
    expect(steps[0].with.token).toBeUndefined();
    expect(steps[2].env.GITHUB_TOKEN).toBe("${{ github.token }}");
  });

  test("--token-secret checks out with the secret, or the Actions token where it is unset (#3624), and nothing else changes", () => {
    const plain = renderCiGreenWorkflow(base);
    const text = renderCiGreenWorkflow({ ...base, push: { secret: "CI_GREEN_TOKEN" } });
    const steps = (parseYAMLDocument(text) as Yaml).jobs.tick.steps;
    expect(steps[0]).toEqual({ uses: "actions/checkout@v6", with: { ref: "main", "fetch-depth": 0, token: "${{ secrets.CI_GREEN_TOKEN || github.token }}" } });
    // Check runs are still read with the Actions token: a fine-grained token can't call the Checks API.
    expect(steps[2].env.GITHUB_TOKEN).toBe("${{ github.token }}");
    expect((parseYAMLDocument(text) as Yaml).permissions).toEqual({ contents: "write", checks: "read" });
    expect(text.replace("          token: ${{ secrets.CI_GREEN_TOKEN || github.token }}\n", "")).toBe(plain);
  });

  test("--runner-key-secret hands the tick its runner key from the secret, and nothing else changes (#4031)", () => {
    const plain = renderCiGreenWorkflow(base);
    const text = renderCiGreenWorkflow({ ...base, runnerKeySecret: "CHANT_RUNNER_KEY" });
    const steps = (parseYAMLDocument(text) as Yaml).jobs.tick.steps;
    expect(steps[2].env).toMatchObject({ GITHUB_TOKEN: "${{ github.token }}", CHANT_RUNNER_KEY: "${{ secrets.CHANT_RUNNER_KEY }}" });
    expect(text.replace("          CHANT_RUNNER_KEY: ${{ secrets.CHANT_RUNNER_KEY }}\n", "")).toBe(plain);
  });

  test("--app-id-var and --app-key-secret mint an App token before the checkout and check out with it", () => {
    const steps = (parseYAMLDocument(renderCiGreenWorkflow({ ...base, push: { appIdVar: "CI_GREEN_APP_ID", appKeySecret: "CI_GREEN_APP_KEY" } })) as Yaml).jobs.tick.steps;
    expect(steps[0]).toMatchObject({
      id: "app-token",
      uses: "actions/create-github-app-token@v2",
      with: { "app-id": "${{ vars.CI_GREEN_APP_ID }}", "private-key": "${{ secrets.CI_GREEN_APP_KEY }}" },
    });
    expect(steps[1].with.token).toBe("${{ steps.app-token.outputs.token }}");
    expect(steps[3].env.GITHUB_TOKEN).toBe("${{ github.token }}");
  });
});

describe("chant ci workflow (#3573)", () => {
  test("writes the file with its header, records it on the member it ran in, and writes the same bytes twice", async () => {
    const root = scratchDir("chant-ci-workflow-");
    git(root, "init", "-q");
    writeFiles(root, {
      "chant.workspace.json": declaration([{ name: "root", dir: ".", kind: "other", because: "the repository" }], { ci: { green: GREEN } }),
      ".github/workflows/ci.yml": CI,
      ".github/workflows/macos.yml": MACOS,
    });
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const ctx = { args: { ciWorkflows: ["release"] } } as unknown as CommandContext;
      expect(await runCiWorkflow(ctx)).toBe(0);
      const file = join(root, CI_GREEN_WORKFLOW_FILE);
      const first = readFileSync(file, "utf-8");
      expect(first.split("\n")[0]).toBe(`# ${GENERATED_MARKER}. Regenerate with: chant ci workflow --workflow release (in the member's directory)`);
      expect((parseYAMLDocument(first) as Yaml).on.workflow_run.workflows).toEqual([".github/workflows/macos.yml", "ci", "release"]);
      const record = JSON.parse(readFileSync(join(root, ".chant", "generated.json"), "utf-8"));
      expect(record.files).toEqual([{ path: CI_GREEN_WORKFLOW_FILE, command: "chant ci workflow --workflow release" }]);
      // The scan skips the file it writes, so regenerating is byte-identical.
      expect(await runCiWorkflow(ctx)).toBe(0);
      expect(readFileSync(file, "utf-8")).toBe(first);
    } finally {
      cwd.mockRestore();
      log.mockRestore();
      error.mockRestore();
    }
  });

  test("--chant and --install go into the file and its header, and regenerate byte-identically", async () => {
    const root = scratchDir("chant-ci-workflow-");
    git(root, "init", "-q");
    writeFiles(root, {
      "chant.workspace.json": declaration([], { ci: { green: GREEN } }),
      "package-lock.json": "{}",
      ".github/workflows/ci.yml": CI,
      ".github/workflows/macos.yml": MACOS,
    });
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const ctx = { args: { ciChant: "npx tsx packages/core/src/cli/main.ts", ciInstall: "npm install --ignore-scripts" } } as unknown as CommandContext;
      expect(await runCiWorkflow(ctx)).toBe(0);
      const file = join(root, CI_GREEN_WORKFLOW_FILE);
      const first = readFileSync(file, "utf-8");
      expect(first.split("\n")[0]).toBe(
        `# ${GENERATED_MARKER}. Regenerate with: chant ci workflow --chant 'npx tsx packages/core/src/cli/main.ts' --install 'npm install --ignore-scripts' (in the workspace root)`,
      );
      const steps = (parseYAMLDocument(first) as Yaml).jobs.tick.steps;
      expect(steps[1].with.cache).toBe("npm");
      expect(steps[2].run).toBe("npm install --ignore-scripts");
      expect(steps[3].run).toBe("npx tsx packages/core/src/cli/main.ts ci tick");
      expect(await runCiWorkflow(ctx)).toBe(0);
      expect(readFileSync(file, "utf-8")).toBe(first);
    } finally {
      cwd.mockRestore();
      log.mockRestore();
      error.mockRestore();
    }
  });

  test("--token-secret goes into the file and its header, and without it the bytes are what they were", async () => {
    const root = scratchDir("chant-ci-workflow-");
    git(root, "init", "-q");
    writeFiles(root, { "chant.workspace.json": declaration([], { ci: { green: GREEN } }), ".github/workflows/ci.yml": CI, ".github/workflows/macos.yml": MACOS });
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const file = join(root, CI_GREEN_WORKFLOW_FILE);
      expect(await runCiWorkflow({ args: {} } as unknown as CommandContext)).toBe(0);
      const plain = readFileSync(file, "utf-8");
      expect(plain).not.toMatch(/token:|secrets\./);

      expect(await runCiWorkflow({ args: { ciTokenSecret: "CI_GREEN_TOKEN" } } as unknown as CommandContext)).toBe(0);
      const withToken = readFileSync(file, "utf-8");
      expect(withToken.split("\n")[0]).toBe(`# ${GENERATED_MARKER}. Regenerate with: chant ci workflow --token-secret CI_GREEN_TOKEN (in the workspace root)`);
      const steps = (parseYAMLDocument(withToken) as Yaml).jobs.tick.steps;
      expect(steps[0].with.token).toBe("${{ secrets.CI_GREEN_TOKEN || github.token }}");
      expect(steps[2].env.GITHUB_TOKEN).toBe("${{ github.token }}");

      const app = { args: { ciAppIdVar: "CI_GREEN_APP_ID", ciAppKeySecret: "CI_GREEN_APP_KEY" } } as unknown as CommandContext;
      expect(await runCiWorkflow(app)).toBe(0);
      expect(readFileSync(file, "utf-8").split("\n")[0]).toBe(
        `# ${GENERATED_MARKER}. Regenerate with: chant ci workflow --app-id-var CI_GREEN_APP_ID --app-key-secret CI_GREEN_APP_KEY (in the workspace root)`,
      );

      // #4031: the runner key's secret goes into the env of the tick and the header.
      expect(await runCiWorkflow({ args: { ciTokenSecret: "CI_GREEN_TOKEN", ciRunnerKeySecret: "CI_RUNNER_KEY" } } as unknown as CommandContext)).toBe(0);
      const withKey = readFileSync(file, "utf-8");
      expect(withKey.split("\n")[0]).toBe(`# ${GENERATED_MARKER}. Regenerate with: chant ci workflow --token-secret CI_GREEN_TOKEN --runner-key-secret CI_RUNNER_KEY (in the workspace root)`);
      expect((parseYAMLDocument(withKey) as Yaml).jobs.tick.steps[2].env.CHANT_RUNNER_KEY).toBe("${{ secrets.CI_RUNNER_KEY }}");

      // Dropping the flag writes the bytes chant 0.108.0 wrote.
      expect(await runCiWorkflow({ args: {} } as unknown as CommandContext)).toBe(0);
      expect(readFileSync(file, "utf-8")).toBe(plain);
    } finally {
      cwd.mockRestore();
      log.mockRestore();
      error.mockRestore();
    }
  });

  test("refuses a half-given App, both kinds of token at once, and a name GitHub wouldn't accept", async () => {
    const root = scratchDir("chant-ci-workflow-");
    git(root, "init", "-q");
    writeFiles(root, { "chant.workspace.json": declaration([], { ci: { green: GREEN } }), ".github/workflows/ci.yml": CI });
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    const errors: string[] = [];
    const error = vi.spyOn(console, "error").mockImplementation((s: unknown) => void errors.push(String(s)));
    try {
      const run = (args: Record<string, string>) => runCiWorkflow({ args } as unknown as CommandContext);
      expect(await run({ ciAppIdVar: "APP_ID" })).toBe(1);
      expect(errors.pop()).toMatch(/both the App's id and its key/);
      expect(await run({ ciTokenSecret: "T", ciAppIdVar: "APP_ID", ciAppKeySecret: "APP_KEY" })).toBe(1);
      expect(errors.pop()).toMatch(/one or the other/);
      expect(await run({ ciTokenSecret: "ci-green token" })).toBe(1);
      expect(errors.pop()).toMatch(/--token-secret takes a secret or variable name/);
      expect(await run({ ciRunnerKeySecret: "runner key" })).toBe(1);
      expect(errors.pop()).toMatch(/--runner-key-secret takes a secret or variable name/);
      expect(existsSync(join(root, CI_GREEN_WORKFLOW_FILE))).toBe(false);
    } finally {
      cwd.mockRestore();
      error.mockRestore();
    }
  });

  test("refuses to write a workflow nothing but the schedule would trigger", async () => {
    const root = scratchDir("chant-ci-workflow-");
    git(root, "init", "-q");
    writeFiles(root, { "chant.workspace.json": declaration([{ name: "root", dir: ".", kind: "other", because: "x" }], { ci: { green: GREEN } }) });
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    const errors: string[] = [];
    const error = vi.spyOn(console, "error").mockImplementation((s: unknown) => void errors.push(String(s)));
    try {
      expect(await runCiWorkflow({ args: {} } as unknown as CommandContext)).toBe(1);
      expect(errors.join("\n")).toMatch(/--workflow <name>/);
      expect(existsSync(join(root, CI_GREEN_WORKFLOW_FILE))).toBe(false);
    } finally {
      cwd.mockRestore();
      error.mockRestore();
    }
  });
});

// ── A phase's triggers (#4169) ───────────────────────────────────────────────

const BUILD_GREEN = { branch: "main", phases: { lint: { runs: ["lint"], build: "every" }, suites: { runs: ["suites"], build: "newest" } }, require: ["lint", "suites"] };
const LINT_WF = `name: ci
on:
  push:
    branches: [main]
  pull_request:

# Comments above a block stay.
concurrency:
  group: ci-\${{ github.ref }}
  cancel-in-progress: true

jobs:
  lint:
    runs-on: ubuntu-latest
`;
const SUITES_WF = `name: suites
on:
  schedule:
    - cron: "0 */3 * * *"
  workflow_dispatch: {}
permissions:
  contents: read
jobs:
  suites:
    runs-on: ubuntu-latest
`;

describe("the triggers of a phase that sets build (#4169)", () => {
  const green = () => parseDeclaration(JSON.stringify({ name: "w", schema: 1, members: [], ci: { green: BUILD_GREEN } }), "chant.workspace.json").ci!.green!;

  test("newest: pushes to the branch and by hand, no schedule, one group per ref that never cancels; every: the commit's own group on the branch", () => {
    const edits = buildTriggerEdits(green(), [
      { path: ".github/workflows/ci.yml", text: LINT_WF },
      { path: ".github/workflows/suites.yml", text: SUITES_WF },
    ]);
    expect(edits.map((e) => [e.path, e.build, e.phases, e.changed])).toEqual([
      [".github/workflows/ci.yml", "every", ["lint"], true],
      [".github/workflows/suites.yml", "newest", ["suites"], true],
    ]);
    const ci = parseYAMLDocument(edits[0].text) as Yaml;
    // The triggers of an every phase stay, pull requests included, and it can be started by hand (#4216).
    expect(ci.on).toEqual({ push: { branches: ["main"] }, pull_request: null, workflow_dispatch: {} });
    expect(ci.concurrency).toEqual({ group: "chant-build-lint-${{ github.ref == 'refs/heads/main' && github.sha || github.ref }}", "cancel-in-progress": "${{ github.ref != 'refs/heads/main' }}" });
    expect(edits[0].text).toContain(`# Comments above a block stay.\n${BUILD_BLOCK_MARKER}\nconcurrency:`);
    const suites = parseYAMLDocument(edits[1].text) as Yaml;
    expect(suites.on).toEqual({ push: { branches: ["main"] }, workflow_dispatch: {} });
    expect(suites.concurrency).toEqual({ group: "chant-build-suites-${{ github.ref }}", "cancel-in-progress": false });
    // A file without the block gets it before permissions:, and writing again changes nothing.
    expect(edits[1].text.indexOf("concurrency:")).toBeLessThan(edits[1].text.indexOf("permissions:"));
    const again = buildTriggerEdits(green(), edits.map((e) => ({ path: e.path, text: e.text })));
    expect(again.map((e) => e.changed)).toEqual([false, false]);
  });

  test("a phase without build leaves its workflow alone, and one workflow holding both builds is refused", () => {
    const plain = parseDeclaration(JSON.stringify({ name: "w", schema: 1, members: [], ci: { green: { branch: "main", phases: { lint: ["lint"] }, require: ["lint"] } } }), "chant.workspace.json").ci!.green!;
    expect(buildTriggerEdits(plain, [{ path: ".github/workflows/ci.yml", text: LINT_WF }])).toEqual([]);
    const both = LINT_WF.replace("jobs:\n", "jobs:\n  suites:\n    runs-on: ubuntu-latest\n");
    expect(() => buildTriggerEdits(green(), [{ path: ".github/workflows/ci.yml", text: both }])).toThrow(/holds runs of lint \(build: every\) and suites \(build: newest\)/);
  });

  test("writeTopLevel replaces a block up to the next top-level line, or adds one before jobs", () => {
    expect(writeTopLevel("a: 1\nconcurrency:\n  group: x\n\njobs: {}\n", "concurrency", { group: "y" })).toBe(`a: 1\n${BUILD_BLOCK_MARKER}\nconcurrency:\n  group: y\n\njobs: {}\n`);
    expect(writeTopLevel("a: 1\njobs: {}\n", "concurrency", { group: "y" })).toBe(`a: 1\n${BUILD_BLOCK_MARKER}\nconcurrency:\n  group: y\n\njobs: {}\n`);
  });

  test("the tick may re-run jobs and start workflows, and ticks on a build tag's runs, only when a phase sets build", () => {
    const tick = parseYAMLDocument(renderCiGreenWorkflow({ green: green(), workflows: ["ci"], chantVersion: "0.124.33", workspaceRoot: "." })) as Yaml;
    expect(tick.permissions).toEqual({ contents: "write", checks: "read", actions: "write" });
    expect(tick.on.workflow_run.branches).toEqual(["main", "ci/build/**"]);
    const plain = parseDeclaration(JSON.stringify({ name: "w", schema: 1, members: [], ci: { green: { branch: "main", phases: { lint: ["lint"] }, require: ["lint"] } } }), "chant.workspace.json").ci!.green!;
    const before = parseYAMLDocument(renderCiGreenWorkflow({ green: plain, workflows: ["ci"], chantVersion: "0.124.33", workspaceRoot: "." })) as Yaml;
    expect(before.permissions).toEqual({ contents: "write", checks: "read" });
    expect(before.on.workflow_run.branches).toEqual(["main"]);
  });

  test("under a ci.workflow, both builds run on chant/compose/** pushes, a compose branch's every runs are keyed by commit, and the tick ticks on them (#4220)", () => {
    const sources = [
      { path: ".github/workflows/ci.yml", text: LINT_WF },
      { path: ".github/workflows/suites.yml", text: SUITES_WF },
    ];
    const edits = buildTriggerEdits(green(), sources, { compose: true });
    const ci = parseYAMLDocument(edits[0].text) as Yaml;
    expect(ci.on).toEqual({ push: { branches: ["main", "chant/compose/**"] }, pull_request: null, workflow_dispatch: {} });
    expect(ci.concurrency).toEqual({
      group: "chant-build-lint-${{ (github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/heads/chant/compose/')) && github.sha || github.ref }}",
      "cancel-in-progress": "${{ !(github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/heads/chant/compose/')) }}",
    });
    const suites = parseYAMLDocument(edits[1].text) as Yaml;
    expect(suites.on).toEqual({ push: { branches: ["main", "chant/compose/**"] }, workflow_dispatch: {} });
    // Writing again changes nothing.
    expect(buildTriggerEdits(green(), edits.map((e) => ({ path: e.path, text: e.text })), { compose: true }).map((e) => e.changed)).toEqual([false, false]);
    // A push with no branch list already runs on every branch, so its triggers stay.
    const anyBranch = LINT_WF.replace("  push:\n    branches: [main]\n", "  push:\n");
    expect((parseYAMLDocument(buildTriggerEdits(green(), [{ path: ".github/workflows/ci.yml", text: anyBranch }], { compose: true })[0].text) as Yaml).on).toEqual({ push: null, pull_request: null, workflow_dispatch: {} });
    // Without compose the bytes are what #4169 wrote.
    expect(buildTriggerEdits(green(), sources).map((e) => e.text)).toEqual(buildTriggerEdits(green(), sources, { compose: false }).map((e) => e.text));
    const tick = parseYAMLDocument(renderCiGreenWorkflow({ green: green(), workflows: ["ci"], chantVersion: "0.124.33", workspaceRoot: ".", compose: true })) as Yaml;
    expect(tick.on.workflow_run.branches).toEqual(["main", "ci/build/**", "chant/compose/**"]);
  });

  test("chant ci workflow writes the compose triggers only when the declaration names a ci.workflow (#4220)", async () => {
    const run = async (ci: Record<string, unknown>) => {
      const root = scratchDir();
      git(root, "init", "-q");
      writeFiles(root, {
        "chant.workspace.json": declaration([{ name: "root", dir: ".", kind: "other", because: "x" }], { ci }),
        ".github/workflows/ci.yml": LINT_WF,
      });
      const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        expect(await runCiWorkflow({ args: {} } as unknown as CommandContext)).toBe(0);
        return { tick: readFileSync(join(root, CI_GREEN_WORKFLOW_FILE), "utf-8"), ci: readFileSync(join(root, ".github/workflows/ci.yml"), "utf-8") };
      } finally {
        cwd.mockRestore();
        log.mockRestore();
      }
    };
    const lint = { branch: "main", phases: { lint: { runs: ["lint"], build: "every" } }, require: ["lint"] };
    const without = await run({ green: lint });
    expect(without.tick).not.toContain("chant/compose");
    expect(without.ci).not.toContain("chant/compose");
    const curated = await run({ green: lint, workflow: "trunk-curated" });
    expect(curated.tick).toContain("chant/compose/**");
    expect(curated.ci).toContain("chant/compose/**");
  });

  test("the workflows a build request can start are the ones holding its phases with workflow_dispatch", () => {
    expect(dispatchableWorkflows(green(), ["lint", "suites"], [{ path: ".github/workflows/ci.yml", text: LINT_WF }, { path: ".github/workflows/suites.yml", text: SUITES_WF }])).toEqual({ dispatchable: ["suites.yml"], without: ["ci.yml"] });
  });
});
