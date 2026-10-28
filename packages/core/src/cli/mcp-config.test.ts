import { describe, test, expect, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { withTestDir } from "@intentius/chant-test-utils";
import { initCommand } from "./commands/init";
import { doctorCommand } from "./commands/doctor";
import { updateCommand } from "./commands/update";
import { parseArgs, commandRegistry } from "./main";
import { generateMcpConfig, MCP_CONFIG_FILENAME, MCP_SETUP_COMMAND, mcpConfigPath } from "./mcp-config";
import { runServeMcp } from "./handlers/serve";
import { runInit } from "./handlers/init";
import type { CommandContext } from "./registry";

/**
 * chant #2383. `chant init` used to write `mcp.json` into the user's home
 * directory while `chant doctor` looked for `<project>/.mcp.json` and told
 * you to run `chant agent setup`, a command the registry never had. Three
 * sites, three answers, and a project chant had just scaffolded failed
 * chant's own doctor with an unrunnable fix.
 *
 * These tests are written against the agreement rather than against today's
 * string: the round trip below fails if init and doctor ever pick different
 * paths again, and the registry check fails if the remediation ever names a
 * command that is not registered. Neither can be satisfied by editing one
 * site in isolation.
 */
describe("MCP config: one location, three agreeing sites (#2383)", () => {
  test("init then doctor round-trips: mcp-config passes with no manual step", async () => {
    await withTestDir(async (testDir) => {
      const result = await initCommand({
        path: testDir,
        lexicon: "aws",
        skipInstall: true,
      });
      expect(result.success).toBe(true);

      const report = await doctorCommand(testDir);
      const check = report.checks.find((c) => c.name === "mcp-config");
      expect(check).toBeDefined();
      expect(check!.status).toBe("pass");
    });
  });

  test("init writes the MCP config inside the project it was pointed at", async () => {
    await withTestDir(async (testDir) => {
      const result = await initCommand({
        path: testDir,
        lexicon: "aws",
        skipInstall: true,
      });

      expect(existsSync(mcpConfigPath(testDir))).toBe(true);
      expect(result.createdFiles).toContain(MCP_CONFIG_FILENAME);

      const config = JSON.parse(readFileSync(mcpConfigPath(testDir), "utf-8"));
      expect(config.mcpServers.chant.args).toEqual(["chant", "serve", "mcp"]);

      // Every path init reports as created is relative to the project. A
      // `~/` or absolute entry means init reached outside the directory it
      // was handed, which is the half of #2383 worth not regressing.
      for (const file of result.createdFiles) {
        expect(file.startsWith("~"), `${file} escapes the project`).toBe(false);
        expect(file.startsWith("/"), `${file} escapes the project`).toBe(false);
        expect(file.includes(homedir()), `${file} escapes the project`).toBe(false);
      }
    });
  });

  test("--skip-mcp parses and suppresses the write", async () => {
    // The flag was documented and typed long before anything parsed it, so
    // assert the parse and the effect together — either one alone passed
    // while `chant init --skip-mcp` still wrote the file.
    expect(parseArgs(["init", ".", "--lexicon", "aws", "--skip-mcp"]).skipMcp).toBe(true);
    expect(parseArgs(["init", ".", "--lexicon", "aws"]).skipMcp).toBeUndefined();

    await withTestDir(async (testDir) => {
      const result = await initCommand({
        path: testDir,
        lexicon: "aws",
        skipMcp: true,
        skipInstall: true,
      });
      expect(existsSync(mcpConfigPath(testDir))).toBe(false);
      expect(result.createdFiles).not.toContain(MCP_CONFIG_FILENAME);
    });
  });

  test("the doctor's remediation names a registered command", async () => {
    // Reconstruct the warning the doctor actually emits, then check that the
    // command inside it exists. `chant agent setup` satisfied neither.
    await withTestDir(async (testDir) => {
      writeFileSync(join(testDir, "chant.config.json"), JSON.stringify({ lexicons: ["aws"] }));
      const report = await doctorCommand(testDir);
      const check = report.checks.find((c) => c.name === "mcp-config");
      expect(check!.status).toBe("warn");
      expect(check!.message).toContain(MCP_SETUP_COMMAND);

      const named = check!.message!.match(/run ([a-z][a-z -]*)/)?.[1].trim();
      expect(named).toBeDefined();
      expect(named!.startsWith("chant ")).toBe(true);
      const registered = commandRegistry.map((c) => c.name);
      expect(registered).toContain(named!.slice("chant ".length));
    });
  });

  test("the remediation command restores a deleted config", async () => {
    await withTestDir(async (testDir) => {
      // A project that has everything except the MCP config: exactly the
      // state the doctor warns about. `chant init` refuses this directory
      // without --force, so the remediation has to be something else.
      mkdirSync(join(testDir, "src"), { recursive: true });
      writeFileSync(join(testDir, "chant.config.json"), JSON.stringify({ lexicons: ["aws"] }));
      writeFileSync(join(testDir, "package.json"), JSON.stringify({ name: "p", type: "module" }));

      expect(MCP_SETUP_COMMAND).toBe("chant update");
      const result = await updateCommand({ path: testDir });
      expect(result.success).toBe(true);

      const report = await doctorCommand(testDir);
      expect(report.checks.find((c) => c.name === "mcp-config")!.status).toBe("pass");
    });
  });

  test("update leaves an existing config alone", async () => {
    await withTestDir(async (testDir) => {
      writeFileSync(join(testDir, "chant.config.json"), JSON.stringify({ lexicons: ["aws"] }));
      writeFileSync(join(testDir, "package.json"), JSON.stringify({ name: "p", type: "module" }));
      const hand = JSON.stringify({ mcpServers: { chant: { command: "custom" } } }, null, 2);
      writeFileSync(mcpConfigPath(testDir), hand);

      await updateCommand({ path: testDir });

      expect(readFileSync(mcpConfigPath(testDir), "utf-8")).toBe(hand);
    });
  });

  test("every chant command a doctor check tells you to run is registered", async () => {
    // Broader than the mcp-config check that prompted #2383: whatever the
    // doctor prints as `run chant <something>`, the registry has to have it.
    // `chant agent setup` shipped as advice for a command that never existed;
    // this fails the moment any check does that again.
    const registered = commandRegistry.map((c) => c.name);
    expect(registered).not.toContain("agent");
    expect(registered).not.toContain("agent setup");

    const messages: string[] = [];
    await withTestDir(async (empty) => {
      messages.push(...(await doctorCommand(empty)).checks.flatMap((c) => c.message ?? []));
    });
    await withTestDir(async (partial) => {
      writeFileSync(join(partial, "chant.config.json"), JSON.stringify({ lexicons: ["aws"] }));
      writeFileSync(join(partial, "package.json"), JSON.stringify({ name: "p" }));
      mkdirSync(join(partial, "src"), { recursive: true });
      messages.push(...(await doctorCommand(partial)).checks.flatMap((c) => c.message ?? []));
    });

    const named = messages.flatMap((m) => [...m.matchAll(/run `?(chant [a-z][a-z0-9 -]*)/g)].map((x) => x[1]));
    expect(named.length).toBeGreaterThan(0);
    for (const advice of named) {
      // Drop flags and the trailing prose the regex may have swept up, then
      // keep the longest registered name that prefixes what was advised.
      const words = advice.slice("chant ".length).split(/\s+/).filter((w) => w && !w.startsWith("-"));
      const match = registered.find((name) => {
        const parts = name.split(" ");
        return parts.every((p, i) => words[i] === p);
      });
      expect(match, `doctor advises "${advice}", which no registered command matches`).toBeDefined();
    }
  });
});

describe("the --propose tier on the command line (#4655)", () => {
  const ctx = (argv: string[]): CommandContext => ({ args: parseArgs(argv), plugins: [], serializers: [] });

  async function captured(run: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
    const out: string[] = [];
    const err: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
    const error = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
    try {
      return { code: await run(), out: out.join("\n"), err: err.join("\n") };
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  }

  test("chant serve mcp --propose without --read-only exits 1 with a usage message", async () => {
    const args = parseArgs(["serve", "mcp", "--propose"]);
    expect(args.propose).toBe(true);
    const got = await captured(() => runServeMcp(ctx(["serve", "mcp", "--propose"])));
    expect(got.code).toBe(1);
    expect(got.err).toMatch(/--propose needs --read-only/);
    expect(got.err).toMatch(/Usage: chant serve mcp --read-only --propose/);
  });

  test("chant init --mcp-read-only --propose --dry-run prints the .mcp.json it would write, and writes nothing", async () => {
    await withTestDir(async (dir) => {
      const got = await captured(() => runInit(ctx(["init", dir, "--mcp-read-only", "--propose", "--dry-run"])));
      expect(got.code).toBe(0);
      expect(JSON.parse(got.out).mcpServers.chant.args).toEqual(["chant", "serve", "mcp", "--read-only", "--propose"]);
      expect(existsSync(mcpConfigPath(dir))).toBe(false);
    });
    const refused = await captured(() => runInit(ctx(["init", "--propose", "--dry-run"])));
    expect(refused.code).toBe(1);
    expect(refused.err).toMatch(/--propose needs --mcp-read-only/);
  });

  test("init --mcp-read-only --propose registers the tier, and propose alone is refused", async () => {
    await withTestDir(async (testDir) => {
      await initCommand({ path: testDir, lexicon: "aws", skipInstall: true, mcpReadOnly: true, mcpPropose: true });
      const config = JSON.parse(readFileSync(mcpConfigPath(testDir), "utf-8"));
      expect(config.mcpServers.chant.args).toEqual(["chant", "serve", "mcp", "--read-only", "--propose"]);
    });
    expect(() => generateMcpConfig("npm", { propose: true })).toThrow(/--mcp-read-only --propose/);
  });
});
