import { describe, test, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discover } from "./index";

/**
 * #1421 — chant's core is ESM. A CommonJS project's `require` of `params.ts`
 * and core's `import` of it are two module records, so `setBuildParams`'s
 * in-place mutation never reaches project source: it reads `{}` and every
 * declaration conditioned on a parameter takes its default branch, silently.
 *
 * The fix is to stop it being silent. These assert the warning fires exactly
 * when the hazard exists and stays quiet otherwise.
 */
describe("build params that cannot reach a CommonJS project (#1421)", () => {
  const dirs: string[] = [];
  const project = (type: string | undefined): string => {
    const dir = mkdtempSync(join(tmpdir(), "chant-1421-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify(type === undefined ? { name: "p" } : { name: "p", type }),
    );
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "main.ts"), "export const x = 1;\n");
    return dir;
  };

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const warnings = async (dir: string, params: Array<{ name: string; value: unknown }>): Promise<string[]> => {
    const seen: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void seen.push(a.join(" ")));
    await discover(join(dir, "src"), {
      buildParams: params as never,
    });
    return seen.filter((s) => s.includes("#1421"));
  };

  test('warns for "type": "commonjs" when parameters were resolved', async () => {
    const out = await warnings(project("commonjs"), [{ name: "tier", value: "prod" }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/"type": "commonjs"/);
    expect(out[0]).toMatch(/tier/);
    expect(out[0]).toMatch(/Set "type": "module"/);
  });

  // The sneakier half: no `type` field at all is also CommonJS.
  test("warns when package.json declares no type at all", async () => {
    const out = await warnings(project(undefined), [{ name: "tier", value: "prod" }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/no `type` field/);
  });

  test('stays quiet for "type": "module"', async () => {
    expect(await warnings(project("module"), [{ name: "tier", value: "prod" }])).toEqual([]);
  });

  // A CJS project using no parameters is not at risk, and must not be nagged.
  test("stays quiet when no parameters were resolved", async () => {
    expect(await warnings(project("commonjs"), [])).toEqual([]);
  });

  test("names every resolved parameter, sorted", async () => {
    const out = await warnings(project("commonjs"), [
      { name: "zone", value: "b" },
      { name: "tier", value: "prod" },
    ]);
    expect(out[0]).toMatch(/\(tier, zone\)/);
  });
});
