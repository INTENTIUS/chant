/**
 * chant#4881 — the first `auditFiles` call for a lexicon, in a fresh module
 * graph, either gets findings or reports why it can't. `MissingLexiconError`
 * is kept for a package that can't be resolved. A package that resolves but
 * fails to load (here, one whose barrel re-exports a `generated/` module that
 * was never generated, as a source checkout's lexicons do before
 * `npm run generate`) is reported as that failure, not as missing.
 *
 * Each test re-imports `./core` after `vi.resetModules()`, so no earlier load
 * of the same lexicon can warm it.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditInput } from "./core";

const GOOD = "zz4881good";
const BROKEN = "zz4881broken";
let project: string;

const plugin = (name: string) => `export const ${name}Plugin = {
  name: "${name}",
  serializer: { name: "${name}", serialize: () => "" },
  generate: async () => {},
  validate: async () => {},
  coverage: async () => {},
  package: async () => {},
  postSynthChecks: () => [{
    id: "ZZ4881",
    description: "flags every audited file",
    check: (ctx) => [...ctx.outputs.keys()].map((key) => ({ checkId: "ZZ4881", severity: "error", message: "flagged " + key })),
  }],
};
`;

async function writeLexicon(name: string, index: string): Promise<void> {
  const dir = join(project, "node_modules", "@intentius", `chant-lexicon-${name}`);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: `@intentius/chant-lexicon-${name}`, version: "0.0.1", type: "module", exports: { ".": { default: "./index.js" } } }),
  );
  await writeFile(join(dir, "index.js"), index);
}

beforeAll(async () => {
  project = await mkdtemp(join(tmpdir(), "chant-4881-"));
  await writeFile(join(project, "package.json"), JSON.stringify({ name: "chant-4881-project", private: true }));
  await writeLexicon(GOOD, plugin(GOOD));
  await writeLexicon(BROKEN, `${plugin(BROKEN)}export * from "./generated/index.js";\n`);
});

afterAll(async () => {
  await rm(project, { recursive: true, force: true });
});

beforeEach(() => {
  vi.resetModules();
});

/** One `auditFiles` call from a fresh module graph, run from the fixture project. */
async function auditOnce(lexicon: string): Promise<{ result?: unknown; error?: unknown; MissingLexiconError: Function }> {
  const core = await import("./core");
  const input: AuditInput = { path: "ci.yml", content: "name: ci\n", lexicon };
  const cwd = process.cwd();
  process.chdir(project);
  try {
    return { result: await core.auditFiles([input]), MissingLexiconError: core.MissingLexiconError };
  } catch (error) {
    return { error, MissingLexiconError: core.MissingLexiconError };
  } finally {
    process.chdir(cwd);
  }
}

describe("the first load of a lexicon (#4881)", () => {
  test("an installed lexicon gets findings on the first call", async () => {
    const { result, error } = await auditOnce(GOOD);
    expect(error).toBeUndefined();
    expect(result).toEqual([expect.objectContaining({ checkId: "ZZ4881", file: "ci.yml", lexicon: GOOD })]);
  });

  test("an uninstalled lexicon gets MissingLexiconError", async () => {
    const { error, MissingLexiconError } = await auditOnce("zz4881absent");
    expect(error).toBeInstanceOf(MissingLexiconError);
    expect((error as Error).message).toContain("npm i @intentius/chant-lexicon-zz4881absent");
  });

  test("an installed lexicon that fails to load reports the failure, not a missing package", async () => {
    const { error, MissingLexiconError } = await auditOnce(BROKEN);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(MissingLexiconError);
    const message = (error as Error).message;
    expect(message).toContain(`@intentius/chant-lexicon-${BROKEN}`);
    expect(message).toContain("is installed but failed to load");
    expect(message).toMatch(/generated[\\/]index/);
    expect(message).toContain("npm run generate");
    expect(message).not.toContain("npm i ");
  });
});
