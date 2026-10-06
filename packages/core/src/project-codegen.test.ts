import { afterEach, describe, expect, test, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkProjectCodegen,
  generateProjectCode,
  GENERATED_TS_HEADER,
  prepareProjectCodegen,
  readStamp,
  resolveCodegenRoot,
  STAMP_FILE,
  type ProjectCodegen,
  type ProjectCodegenPlugin,
} from "./project-codegen";
import { collectBuildRootContributors } from "./cli/plugins";
import { mergeBuildRootEntities } from "./build";
import { GENERATED_MARKER } from "./discovery/files";
import { runGenerate } from "./cli/handlers/generate";
import type { LexiconPlugin } from "./lexicon";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-project-codegen-"));
  dirs.push(dir);
  return dir;
}

/**
 * A lexicon whose declared input is one local file, `widgets.txt`, named by
 * `config.fake.source`. Each line becomes a generated file.
 */
function fakePlugin(onLoad?: () => void): ProjectCodegenPlugin {
  const codegen: ProjectCodegen = {
    inputs(ctx) {
      const source = (ctx.config.fake as { source?: string } | undefined)?.source;
      if (!source) return undefined;
      return { source, content: readFileSync(join(ctx.projectRoot, source), "utf8") };
    },
    async generate(ctx) {
      const source = (ctx.config.fake as { source: string }).source;
      const names = readFileSync(join(ctx.projectRoot, source), "utf8").split("\n").filter(Boolean);
      const files: Record<string, string> = { "index.ts": `${GENERATED_TS_HEADER}\nexport const names = ${JSON.stringify(names)};\n` };
      for (const n of names) files[`parts/${n}.ts`] = `export const ${n} = 1;\n`;
      return { files, summary: names };
    },
    load: onLoad,
  };
  return { name: "fake", projectCodegen: () => codegen };
}

describe("project codegen", () => {
  test("the generated header carries discovery's generated-file marker", () => {
    expect(GENERATED_TS_HEADER).toContain(GENERATED_MARKER);
  });

  test("outDir defaults to src/generated and follows codegen.outDir", () => {
    expect(resolveCodegenRoot("/p", {})).toBe("/p/src/generated");
    expect(resolveCodegenRoot("/p", { codegen: { outDir: "gen" } })).toBe("/p/gen");
  });

  test("generate writes the files and a stamp; the check is then current", async () => {
    const root = project();
    writeFileSync(join(root, "widgets.txt"), "a\nb\n");
    const config = { fake: { source: "widgets.txt" } };
    const plugin = fakePlugin();

    const result = await generateProjectCode(plugin, root, config);
    expect(result?.status).toBe("written");
    expect(result?.files).toEqual(["index.ts", "parts/a.ts", "parts/b.ts"]);
    const outDir = join(root, "src/generated/fake");
    expect(readFileSync(join(outDir, "index.ts"), "utf8")).toContain('["a","b"]');
    expect(readStamp(outDir)?.inputs).toMatch(/^sha256:[0-9a-f]{64}$/);

    expect(await checkProjectCodegen(plugin, root, config)).toEqual({ status: "current" });
  });

  test("editing a declared source without regenerating is drift", async () => {
    const root = project();
    writeFileSync(join(root, "widgets.txt"), "a\n");
    const config = { fake: { source: "widgets.txt" } };
    const plugin = fakePlugin();
    await generateProjectCode(plugin, root, config);

    writeFileSync(join(root, "widgets.txt"), "a\nc\n");
    const check = await checkProjectCodegen(plugin, root, config);
    expect(check.status).toBe("drift");
    expect("message" in check && check.message).toMatch(/src\/generated\/fake is out of date.*Run `chant generate`/);
  });

  test("declared sources with no output, or a recorded file deleted, is missing", async () => {
    const root = project();
    writeFileSync(join(root, "widgets.txt"), "a\n");
    const config = { fake: { source: "widgets.txt" } };
    const plugin = fakePlugin();
    expect((await checkProjectCodegen(plugin, root, config)).status).toBe("missing");

    await generateProjectCode(plugin, root, config);
    rmSync(join(root, "src/generated/fake/parts/a.ts"));
    const check = await checkProjectCodegen(plugin, root, config);
    expect(check.status).toBe("missing");
    expect("message" in check && check.message).toContain("parts/a.ts");
  });

  test("regenerating deletes files the previous run wrote and this one did not", async () => {
    const root = project();
    writeFileSync(join(root, "widgets.txt"), "a\nb\n");
    const config = { fake: { source: "widgets.txt" } };
    const plugin = fakePlugin();
    await generateProjectCode(plugin, root, config);
    writeFileSync(join(root, "src/generated/fake/hand-written.ts"), "// mine\n");

    writeFileSync(join(root, "widgets.txt"), "a\n");
    await generateProjectCode(plugin, root, config);
    expect(existsSync(join(root, "src/generated/fake/parts/b.ts"))).toBe(false);
    expect(existsSync(join(root, "src/generated/fake/parts/a.ts"))).toBe(true);
    // Only files a run recorded are ever removed.
    expect(existsSync(join(root, "src/generated/fake/hand-written.ts"))).toBe(true);
  });

  test("with nothing declared, leftover output is an orphan and generate removes it", async () => {
    const root = project();
    writeFileSync(join(root, "widgets.txt"), "a\n");
    const plugin = fakePlugin();
    await generateProjectCode(plugin, root, { fake: { source: "widgets.txt" } });

    expect((await checkProjectCodegen(plugin, root, {})).status).toBe("orphan");
    const result = await generateProjectCode(plugin, root, {});
    expect(result?.status).toBe("removed");
    expect(existsSync(join(root, "src/generated/fake"))).toBe(false);
    expect(await checkProjectCodegen(plugin, root, {})).toEqual({ status: "none" });
  });

  test("prepare loads current output and throws on drift", async () => {
    const root = project();
    writeFileSync(join(root, "widgets.txt"), "a\n");
    const config = { fake: { source: "widgets.txt" } };
    const load = vi.fn();
    const plugin = fakePlugin(load);
    await generateProjectCode(plugin, root, config);

    await prepareProjectCodegen(plugin, root, config);
    expect(load).toHaveBeenCalledTimes(1);

    writeFileSync(join(root, "widgets.txt"), "b\n");
    await expect(prepareProjectCodegen(plugin, root, config)).rejects.toThrow(/out of date/);
    expect(load).toHaveBeenCalledTimes(1);
  });

  test("the build-root contributors carry the check, so a drifted build reports an error", async () => {
    const root = project();
    writeFileSync(join(root, "widgets.txt"), "a\n");
    const config = { fake: { source: "widgets.txt" } };
    const plugin = fakePlugin() as unknown as LexiconPlugin;
    await generateProjectCode(plugin, root, config);

    const current = await mergeBuildRootEntities(new Map(), collectBuildRootContributors([plugin], config, root));
    expect(current.errors).toEqual([]);

    writeFileSync(join(root, "widgets.txt"), "b\n");
    const drifted = await mergeBuildRootEntities(new Map(), collectBuildRootContributors([plugin], config, root));
    expect(drifted.errors).toHaveLength(1);
    expect(drifted.errors[0]).toMatch(/out of date/);
  });
});

describe("chant generate", () => {
  function args(path: string, extra: Record<string, unknown> = {}) {
    return { command: "generate", path, ...extra } as never;
  }

  test("writes each lexicon's code, and --check reports drift with exit 1", async () => {
    const root = project();
    writeFileSync(join(root, "chant.config.json"), JSON.stringify({ fake: { source: "widgets.txt" } }));
    writeFileSync(join(root, "widgets.txt"), "a\n");
    const plugins = [fakePlugin() as unknown as LexiconPlugin];
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await runGenerate({ args: args(root), plugins, serializers: [] })).toBe(0);
      expect(existsSync(join(root, "src/generated/fake", STAMP_FILE))).toBe(true);
      expect(await runGenerate({ args: args(root, { check: true }), plugins, serializers: [] })).toBe(0);

      writeFileSync(join(root, "widgets.txt"), "z\n");
      expect(await runGenerate({ args: args(root, { check: true }), plugins, serializers: [] })).toBe(1);
      expect(err.mock.calls.flat().join("\n")).toMatch(/out of date/);
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });

  test("--lexicon naming a lexicon with no project codegen fails", async () => {
    const root = project();
    writeFileSync(join(root, "chant.config.json"), "{}");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const code = await runGenerate({ args: args(root, { lexicon: "aws" }), plugins: [fakePlugin() as unknown as LexiconPlugin], serializers: [] });
      expect(code).toBe(1);
    } finally {
      err.mockRestore();
    }
  });
});
