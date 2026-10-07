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
import { CI_GREEN_WORKFLOW_FILE, jobCheckRuns, renderCiGreenWorkflow, workflowsHolding } from "./ci-green-workflow";
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

  test("--token-secret checks out with the secret, so the push uses it, and nothing else changes", () => {
    const plain = renderCiGreenWorkflow(base);
    const text = renderCiGreenWorkflow({ ...base, push: { secret: "CI_GREEN_TOKEN" } });
    const steps = (parseYAMLDocument(text) as Yaml).jobs.tick.steps;
    expect(steps[0]).toEqual({ uses: "actions/checkout@v6", with: { ref: "main", "fetch-depth": 0, token: "${{ secrets.CI_GREEN_TOKEN }}" } });
    // Check runs are still read with the Actions token: a fine-grained token can't call the Checks API.
    expect(steps[2].env.GITHUB_TOKEN).toBe("${{ github.token }}");
    expect((parseYAMLDocument(text) as Yaml).permissions).toEqual({ contents: "write", checks: "read" });
    expect(text.replace("          token: ${{ secrets.CI_GREEN_TOKEN }}\n", "")).toBe(plain);
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
      expect(steps[0].with.token).toBe("${{ secrets.CI_GREEN_TOKEN }}");
      expect(steps[2].env.GITHUB_TOKEN).toBe("${{ github.token }}");

      const app = { args: { ciAppIdVar: "CI_GREEN_APP_ID", ciAppKeySecret: "CI_GREEN_APP_KEY" } } as unknown as CommandContext;
      expect(await runCiWorkflow(app)).toBe(0);
      expect(readFileSync(file, "utf-8").split("\n")[0]).toBe(
        `# ${GENERATED_MARKER}. Regenerate with: chant ci workflow --app-id-var CI_GREEN_APP_ID --app-key-secret CI_GREEN_APP_KEY (in the workspace root)`,
      );

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
