import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { readGraphWithModule } from "./graph-reader";

const scratch = mkdtempSync(join(tmpdir(), "chant-graph-reader-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function mod(name: string, text: string): string {
  const file = join(scratch, name);
  writeFileSync(file, text);
  return file;
}

describe("readGraphWithModule (#4413)", () => {
  test("calls the default export with dir and config, and fills in groups", async () => {
    const file = mod("ok.mjs", "export default async ({ dir, config }) => ({ nodes: [{ id: 'a', kind: 'K', lexicon: 'x', attrs: { dir, n: config.n } }], edges: [] });\n");
    const read = await readGraphWithModule(file, { dir: "/m", n: 2 }, "/p");
    expect(read).toEqual({ ir: { nodes: [{ id: "a", kind: "K", lexicon: "x", attrs: { dir: "/m", n: 2 } }], edges: [], groups: {} } });
  });

  test("says why when the module is missing, has no function, throws or returns no graph", async () => {
    const msg = async (p: string) => ("error" in (await readGraphWithModule(p, {}, "/p")) ? ((await readGraphWithModule(p, {}, "/p")) as { error: string }).error : "");
    expect(await msg(join(scratch, "nope.mjs"))).toMatch(/could not be loaded/);
    expect(await msg(mod("nofn.mjs", "export default 3;\n"))).toMatch(/no default export function/);
    expect(await msg(mod("throws.mjs", "export default () => { throw new Error('boom'); };\n"))).toMatch(/failed: boom/);
    expect(await msg(mod("bad.mjs", "export default () => ({});\n"))).toMatch(/no nodes and edges/);
    expect(await msg("rel.mjs")).toMatch(/absolute/);
  });
});
