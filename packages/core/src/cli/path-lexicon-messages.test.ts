/**
 * chant#2578 — init, onboard, audit and import-agents name a lexicon declared
 * by path (#2520) by that path, and print no install line for it. A lexicon
 * named by package keeps its package name and `npm i` line.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  lexiconPackagesToInstall,
  lexiconSourceLabel,
  registerLexiconDeclarations,
  resetLexiconModules,
} from "../lexicon-module";
import { initCommand } from "./commands/init";
import { onboardCommand } from "./commands/onboard";
import { installLine } from "./commands/audit";
import { importAgentsCommand } from "./commands/import-agents";
import { auditFiles, MissingLexiconError, type AuditInput } from "../audit/core";

let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "chant-2578-")));
  resetLexiconModules();
});

afterEach(() => {
  resetLexiconModules();
  rmSync(dir, { recursive: true, force: true });
});

describe("the shared helpers", () => {
  test("a path lexicon is labelled by its path and has no package to install", () => {
    registerLexiconDeclarations(["aws", { name: "site", module: "./lexicon/index.ts" }], dir);
    expect(lexiconSourceLabel("site", dir)).toBe("./lexicon/index.ts");
    expect(lexiconSourceLabel("aws", dir)).toBe("@intentius/chant-lexicon-aws");
    expect(lexiconPackagesToInstall(["aws", "site"])).toEqual(["@intentius/chant-lexicon-aws"]);
  });

  test("a path outside the directory is shown absolute", () => {
    registerLexiconDeclarations([{ name: "site", module: "/elsewhere/site.ts" }], dir);
    expect(lexiconSourceLabel("site", dir)).toBe("/elsewhere/site.ts");
  });
});

describe("init", () => {
  function writeConfig(entry: string): void {
    writeFileSync(join(dir, "chant.config.ts"), `export default { lexicons: [${entry}] };\n`);
  }

  test("a lexicon the existing config declares by path gets no dependency and no type stub", async () => {
    writeConfig(`{ name: "site", module: "./lexicon/index.ts" }`);
    const result = await initCommand({ path: dir, lexicon: "site", force: true, skipMcp: true, skipInstall: true });

    expect(result.success).toBe(true);
    expect(result.lexiconModule).toBe("./lexicon/index.ts");
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
    expect(Object.keys(pkg.dependencies)).toEqual(["@intentius/chant"]);
    expect(existsSync(join(dir, ".chant", "types", "lexicon-site"))).toBe(false);
  });

  test("a package lexicon is unchanged", async () => {
    writeConfig(`"aws"`);
    const result = await initCommand({ path: dir, lexicon: "aws", force: true, skipMcp: true, skipInstall: true });

    expect(result.success).toBe(true);
    expect(result.lexiconModule).toBeUndefined();
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
    expect(Object.keys(pkg.dependencies)).toEqual(["@intentius/chant", "@intentius/chant-lexicon-aws"]);
    expect(existsSync(join(dir, ".chant", "types", "lexicon-aws", "package.json"))).toBe(true);
  });
});

describe("onboard", () => {
  test("a lexicon declared by path is named by its path, with nothing patched", () => {
    registerLexiconDeclarations([{ name: "site", module: "./lexicon/index.ts" }], process.cwd());
    const result = onboardCommand({ name: "site", root: dir });

    expect(result.success).toBe(false);
    expect(result.error).toContain("./lexicon/index.ts");
    expect(result.error).not.toMatch(/npm (i|install)\b/);
    expect(result.patched).toEqual([]);
  });

  test("a package lexicon still patches", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "root", dependencies: {} }));
    const result = onboardCommand({ name: "site", root: dir });

    expect(result.success).toBe(true);
    expect(result.patched.some((p) => p.startsWith("package.json"))).toBe(true);
  });
});

describe("audit", () => {
  test("the npx line leaves out a lexicon declared by path", () => {
    registerLexiconDeclarations([{ name: "github", module: "./gh/index.ts" }], dir);
    expect(installLine(["github", "gitlab"], ".")).toBe(
      "npx -p @intentius/chant -p @intentius/chant-lexicon-gitlab chant audit .",
    );
  });

  test("a path lexicon that fails to load is named by its path, with no npm line", async () => {
    registerLexiconDeclarations([{ name: "helm", module: join(dir, "missing.ts") }], dir);
    const input = { lexicon: "helm", path: "Chart.yaml", content: "" } as AuditInput;

    const error = await auditFiles([input]).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(MissingLexiconError);
    expect((error as Error).message).toContain(join(dir, "missing.ts"));
    expect((error as Error).message).not.toContain("npm i");
  });
});

describe("import-agents", () => {
  function seedAgentConfig(home: string): void {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "mcp.json"), JSON.stringify({ mcpServers: { a: { command: "x" } } }));
  }

  test("a path lexicon that fails to load is named by its path, with no npm line", async () => {
    const home = join(dir, "home");
    seedAgentConfig(home);
    registerLexiconDeclarations([{ name: "fountain", module: "./agents/missing.ts" }], dir);

    const result = await importAgentsCommand({ home, platform: "linux", projectRoots: [], output: join(dir, "out") });

    expect(result.success).toBe(false);
    expect(result.error).toContain("declared by path");
    expect(result.error).toContain("missing.ts");
    expect(result.error).not.toContain("npm i");
  });

  test("a package lexicon still gets its npm line", async () => {
    const home = join(dir, "home");
    seedAgentConfig(home);

    const result = await importAgentsCommand({
      home,
      platform: "linux",
      projectRoots: [],
      output: join(dir, "out"),
      lexicon: "no-such-lexicon",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("npm i @intentius/chant-lexicon-no-such-lexicon");
  });
});
