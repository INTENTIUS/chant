import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldProject } from "../index";

/**
 * chant#4011 — a method call reached `Function`, so a file reporting
 * `[fold:fold]` could put the clock, `process.env` or `Math.random()` in its
 * output. The issue's repro and its variants now get a `run` verdict, and a
 * file of listed host methods folds to the same bytes whatever the
 * environment says.
 */
describe("a folded file cannot reach host behaviour through a method call (chant#4011)", () => {
  let root: string;
  const saved = { HOME: process.env.HOME, TZ: process.env.TZ };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "chant-4011-"));
  });

  afterEach(() => {
    process.env.HOME = saved.HOME;
    if (saved.TZ === undefined) delete process.env.TZ;
    else process.env.TZ = saved.TZ;
    rmSync(root, { recursive: true, force: true });
  });

  async function verdictOf(source: string) {
    const file = join(root, "c.ts");
    writeFileSync(file, source);
    return (await foldProject([file], [], {})).get(file)!;
  }

  const cases: Record<string, string> = {
    "the issue's repro": [
      "export const cfg = {",
      '  stamp: [].constructor.constructor("return String(Date.now())").call(),',
      '  home: `${[].constructor.constructor("return process.env.HOME").call()}`,',
      "};",
    ].join("\n"),
    "Math.random": 'export const cfg = { r: [].constructor.constructor("return Math.random()").call() };',
    "process.env": 'export const cfg = { h: [].constructor.constructor("return process.env.HOME").call() };',
    "new Date(...).toString()":
      'export const cfg = { d: [].constructor.constructor("return new Date(0).toString()").call() };',
    toLocaleString: "export const cfg = { n: (1234567.891).toLocaleString() };",
    "Function through a prototype chain":
      'export const cfg = { p: "".__proto__.constructor.constructor("return String(Date.now())").call() };',
    "Function under an unlisted name":
      'const o = { f: [].constructor.constructor };\nexport const cfg = { q: o.f("return 1") };',
  };

  for (const [name, source] of Object.entries(cases)) {
    test(`${name}: run, not fold`, async () => {
      const verdict = await verdictOf(source);
      expect(verdict.verdict).toBe("run");
      expect(verdict.reason).toBeDefined();
    });
  }

  test("listed host methods fold to identical output under a different HOME and TZ", async () => {
    const source = [
      "const parts = ['a', 'b', 'c'];",
      "export const cfg = {",
      "  name: parts.join('-'),",
      "  tail: 'x.y.z'.split('.').slice(1).join('/'),",
      "  pi: (3.14159).toFixed(2),",
      "  upper: 'chant'.toUpperCase(),",
      "};",
    ].join("\n");

    process.env.HOME = "/tmp/h1";
    process.env.TZ = "UTC";
    const first = await verdictOf(source);
    process.env.HOME = "/tmp/h2";
    process.env.TZ = "Asia/Kolkata";
    const second = await verdictOf(source);

    expect(first.verdict).toBe("fold");
    expect(second.verdict).toBe("fold");
    const bytes = (v: typeof first) => JSON.stringify(Object.fromEntries(v.exports!));
    expect(bytes(first)).toBe(bytes(second));
    expect(JSON.parse(bytes(first))).toEqual({
      cfg: { name: "a-b-c", tail: "y/z", pi: "3.14", upper: "CHANT" },
    });
  });
});
