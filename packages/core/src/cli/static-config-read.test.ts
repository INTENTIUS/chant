/**
 * chant#2591, chant#2589 — `init --force`, `dev onboard`, `import --agents`
 * and `audit` learn the lexicons a project declares by path without running
 * its `chant.config.ts`.
 *
 * The CLI is spawned the way `bin/chant` runs it, because `main.ts` loads the
 * config before dispatch for most commands, and a test calling the command
 * functions would miss that load. Each fixture's config writes a marker file
 * when it runs. The marker must never appear, and each command's output must
 * still name the lexicon's path.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditCommand } from "./commands/audit";
import { resetLexiconModules } from "../lexicon-module";

const thisDir = dirname(fileURLToPath(import.meta.url));
const mainTs = resolve(thisDir, "main.ts");
const repoRoot = resolve(thisDir, "../../../..");
const tsxLoader = join(repoRoot, "node_modules", "tsx", "dist", "loader.mjs");

let root: string;
let project: string;
let marker: string;
let home: string;
let moduleMarker: string;

function writeConfig(lexicons: string): void {
  writeFileSync(
    join(project, "chant.config.ts"),
    `import { writeFileSync } from "node:fs";\n` +
      `writeFileSync(${JSON.stringify(marker)}, "ran");\n` +
      `export default { lexicons: ${lexicons} };\n`,
  );
}

beforeEach(() => {
  resetLexiconModules();
  root = realpathSync(mkdtempSync(join(tmpdir(), "chant-2591-cli-")));
  project = join(root, "project");
  marker = join(root, "config-ran");
  home = join(root, "home");
  moduleMarker = join(root, "module-ran");
  mkdirSync(join(project, ".github", "workflows"), { recursive: true });
  mkdirSync(join(project, "gh"), { recursive: true });
  mkdirSync(join(project, ".git"));
  // The path lexicon's module is project code too. Audit must never import it.
  writeFileSync(
    join(project, "gh", "index.ts"),
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(moduleMarker)}, "ran");\nexport {};\n`,
  );
  writeFileSync(
    join(project, ".github", "workflows", "ci.yml"),
    "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n",
  );
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "mcp.json"), JSON.stringify({ mcpServers: { a: { command: "x" } } }));
  writeConfig(`[{ name: "github", module: "./gh/index.ts" }]`);
});

afterEach(() => {
  resetLexiconModules();
  rmSync(root, { recursive: true, force: true });
});

function chant(args: string[], cwd: string): string {
  const result = spawnSync(process.execPath, ["--import", tsxLoader, mainTs, ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? "", HOME: home },
    encoding: "utf-8",
    input: "n\n",
    timeout: 60_000,
  });
  return `${result.stdout}\n${result.stderr}`;
}

const COMMANDS: Array<{ name: string; args: () => string[]; cwd: () => string }> = [
  { name: "init --force", args: () => ["init", project, "--lexicon", "github", "--force", "--skip-mcp"], cwd: () => root },
  { name: "dev onboard", args: () => ["dev", "onboard", "github"], cwd: () => project },
  { name: "import --agents", args: () => ["import", "--agents", "--lexicon", "github", "--output", join(root, "out")], cwd: () => project },
];

describe("commands that read path lexicons statically run no project code", () => {
  for (const command of COMMANDS) {
    for (const sandbox of [false, true]) {
      test(`${command.name}${sandbox ? " --sandbox" : ""} names the path and never runs chant.config.ts`, () => {
        const output = chant([...command.args(), ...(sandbox ? ["--sandbox"] : [])], command.cwd());
        expect(output).toContain("./gh/index.ts");
        expect(existsSync(marker)).toBe(false);
      }, 90_000);
    }
  }

  test("audit never runs chant.config.ts or the path lexicon's module", () => {
    chant(["audit", project], root);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(moduleMarker)).toBe(false);
  }, 90_000);

  test("a config it cannot read is reported, and still not run", () => {
    writeConfig(`process.env.CI ? ["github"] : [{ name: "github", module: "./gh/index.ts" }]`);
    const output = chant(["dev", "onboard", "github"], project);
    expect(output).toContain("could not read the lexicons in");
    expect(output).toContain("treated as a package");
    expect(existsSync(marker)).toBe(false);

    const audit = chant(["audit", project], root);
    expect(audit).toContain("could not read the lexicons in");
    expect(existsSync(marker)).toBe(false);
  }, 180_000);

  test("control: build does run chant.config.ts", () => {
    chant(["build", "."], project);
    expect(existsSync(marker)).toBe(true);
  }, 90_000);
});

describe("audit names a path lexicon by its path and leaves it out of the install line (chant#2589)", () => {
  test("text output", async () => {
    const result = await auditCommand({ path: project, plugins: [] });
    expect(result.status).toBe("no-lexicons");
    expect(result.output).toContain("github is declared by path: ");
    expect(result.output).toContain("gh/index.ts");
    const install = result.output.split("\n").find((line) => line.includes("npx "));
    expect(install).toBeDefined();
    expect(install).not.toContain("@intentius/chant-lexicon-github");
    expect(existsSync(marker)).toBe(false);
  });

  test("json output", async () => {
    const result = await auditCommand({ path: project, plugins: [], format: "json" });
    const report = JSON.parse(result.output) as { install: string };
    expect(report.install).toMatch(/^npx -p @intentius\/chant( |$)/);
    expect(report.install).not.toContain("@intentius/chant-lexicon-github");
    expect(existsSync(marker)).toBe(false);
  });

  test("a partial run names the path in its coverage note", async () => {
    // Some other audit lexicon loaded, github not: the workflow is skipped and the note names the path.
    const { loadPlugin } = await import("./plugins");
    const docker = await loadPlugin("docker");
    const result = await auditCommand({ path: project, plugins: [docker] });
    expect(result.output).toContain("github is declared by path: ");
    expect(result.output).not.toContain("npm i @intentius/chant-lexicon-github");
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(moduleMarker)).toBe(false);
  });
});
