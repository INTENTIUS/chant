/**
 * The import command's own contract, separate from the mapping it delegates to
 * (covered by the fountain lexicon's `local-agents.test.ts`).
 *
 * What matters here is the parts a user hits when something is off: a lexicon
 * that can't be loaded or can't express agents, an output directory that
 * already has files in it, and — above all — that every lossy step the mapper
 * reports actually reaches the user. Re-expression silently dropping a config
 * or defaulting a required field is the failure mode that would make the
 * generated code untrustworthy.
 *
 * The plugin is injected rather than loaded, so these run without a built
 * lexicon on disk.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { importAgentsCommand, DEFAULT_AGENT_LEXICON, type PluginLoader } from "./import-agents";
import type { LexiconPlugin } from "../../lexicon";
import type { AgentImportOutcome } from "../../agents/importer";
import type { TemplateIR } from "../../import/parser";

let home: string;
let out: string;

function writeIn(root: string, rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf-8");
}

beforeEach(() => {
  home = join(tmpdir(), `chant-ia-home-${Math.random().toString(36).slice(2)}`);
  out = join(tmpdir(), `chant-ia-out-${Math.random().toString(36).slice(2)}`);
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
});

/** A config with one MCP server, so the scan finds something to import. */
function seedConfig(): void {
  writeIn(home, ".claude/mcp.json", JSON.stringify({ mcpServers: { a: { command: "x" } } }));
}

const EMPTY_OUTCOME: AgentImportOutcome = { ir: { resources: [], parameters: [] }, skipped: [], unmappedModel: [], redactedSecrets: [] };

/** A plugin whose importer and generator are both stubbed. */
function fakePlugin(outcome: Partial<AgentImportOutcome> = {}, overrides: Partial<LexiconPlugin> = {}): LexiconPlugin {
  const resolved: AgentImportOutcome = { ...EMPTY_OUTCOME, ...outcome };
  return {
    name: "fountain",
    agentConfigImporter: () => ({ toTemplateIR: () => resolved }),
    templateGenerator: () => ({
      generate: (ir: TemplateIR) => [{ path: "main.ts", content: ir.resources.map((r) => `export const ${r.logicalId} = {};`).join("\n") }],
    }),
    ...overrides,
  } as unknown as LexiconPlugin;
}

/** An outcome with one resource, so the command reaches the write step. */
const ONE_RESOURCE: Partial<AgentImportOutcome> = {
  ir: { resources: [{ logicalId: "userClaude", type: "Fountain::V1::Agent", properties: {} }], parameters: [] },
};

const loaderFor = (plugin: LexiconPlugin): PluginLoader => async () => plugin;

const run = (opts: Parameters<typeof importAgentsCommand>[0] = {}) =>
  importAgentsCommand({ home, platform: "linux", projectRoots: [], output: out, pluginLoader: loaderFor(fakePlugin(ONE_RESOURCE)), ...opts });

describe("nothing to import", () => {
  test("fails with a clear message when no agent config exists", async () => {
    const result = await run();
    expect(result.success).toBe(false);
    expect(result.error).toContain("No agent configuration found");
    expect(result.generatedFiles).toEqual([]);
  });
});

describe("lexicon resolution", () => {
  test("defaults to the fountain lexicon", async () => {
    seedConfig();
    let asked: string | undefined;
    await run({ pluginLoader: async (name) => { asked = name; return fakePlugin(ONE_RESOURCE); } });
    expect(asked).toBe(DEFAULT_AGENT_LEXICON);
  });

  test("reports an install hint when the lexicon package is missing", async () => {
    seedConfig();
    const result = await run({
      lexicon: "nope",
      pluginLoader: async () => { throw new Error("Cannot find module"); },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("npm i @intentius/chant-lexicon-nope");
  });

  test("names the fallback when the lexicon cannot express agent config", async () => {
    seedConfig();
    const result = await run({ lexicon: "k8s", pluginLoader: loaderFor(fakePlugin({}, { agentConfigImporter: undefined })) });
    expect(result.success).toBe(false);
    expect(result.error).toContain("cannot express agent configuration");
    expect(result.error).toContain(`--lexicon ${DEFAULT_AGENT_LEXICON}`);
  });

  test("fails when the lexicon has no generator to emit TypeScript", async () => {
    seedConfig();
    const result = await run({ pluginLoader: loaderFor(fakePlugin(ONE_RESOURCE, { templateGenerator: undefined })) });
    expect(result.success).toBe(false);
    expect(result.error).toContain("no templateGenerator");
  });
});

describe("reporting what was lost", () => {
  test("surfaces a skipped site with the mapper's reason", async () => {
    seedConfig();
    const result = await run({
      pluginLoader: loaderFor(fakePlugin({ ...ONE_RESOURCE, skipped: [{ siteId: "user-cursor", reason: 'fountain has no "cursor" runtime' }] })),
    });
    expect(result.warnings.some((w) => w.includes("user-cursor") && w.includes("cursor"))).toBe(true);
  });

  test("warns that a defaulted model needs editing before it is applied", async () => {
    seedConfig();
    const result = await run({ pluginLoader: loaderFor(fakePlugin({ ...ONE_RESOURCE, unmappedModel: ["user-claude"] })) });
    expect(result.warnings.some((w) => w.includes("user-claude") && w.includes("Edit it before applying"))).toBe(true);
  });

  test("states that redacted credentials were not copied into the generated code", async () => {
    // The user has to know a secret was *removed*, not carried over — otherwise
    // they'd assume the generated config works as-is.
    seedConfig();
    const result = await run({ pluginLoader: loaderFor(fakePlugin({ ...ONE_RESOURCE, redactedSecrets: ["user-claude"] })) });
    const warning = result.warnings.find((w) => w.includes("Literal credentials"));
    expect(warning).toContain("were NOT copied");
  });

  test("fails, rather than writing an empty file, when nothing could be mapped", async () => {
    seedConfig();
    const result = await run({ pluginLoader: loaderFor(fakePlugin({ skipped: [{ siteId: "user-cursor", reason: "no runtime" }] })) });
    expect(result.success).toBe(false);
    expect(result.error).toContain("none could be expressed");
    expect(existsSync(join(out, "main.ts"))).toBe(false);
  });
});

describe("writing output", () => {
  test("writes the generated files and reports what it counted", async () => {
    seedConfig();
    const result = await run();
    expect(result.success).toBe(true);
    expect(result.generatedFiles).toEqual([join(out, "main.ts")]);
    expect(readFileSync(join(out, "main.ts"), "utf-8")).toContain("export const userClaude");
    expect(result.summary).toEqual({ discovered: 1, mapped: 1 });
  });

  test("refuses to overwrite an existing file without --force", async () => {
    // Generated agent code gets hand-edited after the first run; silently
    // reverting those edits would be the worst outcome for this command.
    seedConfig();
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "main.ts"), "// hand-edited", "utf-8");

    const result = await run();
    expect(result.success).toBe(false);
    expect(result.error).toContain("--force");
    expect(readFileSync(join(out, "main.ts"), "utf-8")).toBe("// hand-edited");
  });

  test("overwrites with --force", async () => {
    seedConfig();
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "main.ts"), "// hand-edited", "utf-8");

    const result = await run({ force: true });
    expect(result.success).toBe(true);
    expect(readFileSync(join(out, "main.ts"), "utf-8")).toContain("export const userClaude");
  });

  test("creates the output directory when it does not exist", async () => {
    seedConfig();
    const nested = join(out, "deep", "nested");
    const result = await run({ output: nested });
    expect(result.success).toBe(true);
    expect(existsSync(join(nested, "main.ts"))).toBe(true);
  });
});

describe("scope and runtime filtering", () => {
  test("passes the scope filter through to the scan", async () => {
    seedConfig();
    // user scope holds the config; restricting to project finds nothing.
    const result = await run({ scopes: ["project"] });
    expect(result.success).toBe(false);
    expect(result.error).toContain("No agent configuration found");
  });

  test("passes the runtime filter through to the scan", async () => {
    seedConfig();
    const result = await run({ runtimes: ["codex"] });
    expect(result.success).toBe(false);
    expect(result.error).toContain("No agent configuration found");
  });
});
