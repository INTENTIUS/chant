import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { foldProject } from "./fold-import";
import { packageExportsTarget, tsconfigPathsTarget } from "./specifier-resolve";
import type { IntrinsicDef } from "../lexicon";

/** `e` from `esm-only/sub/x` is an intrinsic, so fold has to import that subpath to revive the call. */
const intrinsics = [{ name: "e", lexicon: "esm", foldsAsCall: true } as unknown as IntrinsicDef];

/**
 * chant#3090 — the import specifiers `tsc` and `tsx` accept that fold's own
 * resolver did not: a `.js` or `.mjs` specifier naming a `.ts` or `.mts`
 * source, an `exports` subpath pattern with only an `import` condition, and a
 * tsconfig `paths` entry. Each of these used to fall the importing file back
 * to run with an "unresolved identifier".
 *
 * The fixture is the project from the issue, built in a temp directory
 * because its `node_modules` would not be committed.
 */
describe("fold resolves the specifier forms tsc accepts (chant#3090)", () => {
  let root: string;

  const write = (rel: string, content: string): string => {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return path;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "chant-fold-specifiers-"));
    write("tsconfig.json", JSON.stringify({ compilerOptions: { paths: { "@app/*": ["./src/*"] } } }));
    write("src/config.ts", 'export const a = "config";\n');
    write("src/lib/index.ts", 'export const b = "lib";\n');
    write("src/lib/helpers.mts", 'export const c = "helpers";\n');
    write(
      "node_modules/esm-only/package.json",
      JSON.stringify({
        name: "esm-only",
        version: "1.0.0",
        type: "module",
        exports: { ".": { import: "./dist/index.js" }, "./sub/*": { import: "./sub/*.js" } },
      }),
    );
    write("node_modules/esm-only/dist/index.js", 'export const d = "esm-only";\n');
    write("node_modules/esm-only/sub/x.js", "export function e(v) { return `sub:${v}`; }\n");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const files = (): string[] => [
    join(root, "src/config.ts"),
    join(root, "src/lib/index.ts"),
    join(root, "src/lib/helpers.mts"),
  ];

  test("all six specifiers from the issue fold", async () => {
    const main = write(
      "src/main.ts",
      [
        'import { a } from "./config.js";',
        'import { b } from "./lib";',
        'import { c } from "./lib/helpers.mjs";',
        'import { d } from "esm-only";',
        'import { e } from "esm-only/sub/x";',
        'import { a as a2 } from "@app/config";',
        'export const values = [a, b, c, d, e("x"), a2];',
        "",
      ].join("\n"),
    );

    const verdict = (await foldProject([main, ...files()], intrinsics, { lexiconPackages: ["esm-only"] })).get(main)!;

    expect(verdict.reason).toBeUndefined();
    expect(verdict.verdict).toBe("fold");
    expect(Object.fromEntries(verdict.exports!)).toEqual({
      values: ["config", "lib", "helpers", "esm-only", "sub:x", "config"],
    });
  });

  test("a .js specifier names the .ts source even when the .js file exists too", async () => {
    write("src/config.js", 'export const a = "stale build output";\n');
    const main = write("src/main.ts", 'import { a } from "./config.js";\nexport const v = a;\n');

    const verdict = (await foldProject([main, ...files()])).get(main)!;

    expect(verdict.verdict).toBe("fold");
    expect(Object.fromEntries(verdict.exports!)).toEqual({ v: "config" });
  });

  test("an unresolvable relative specifier keeps a run reason naming the specifier and the importing file", async () => {
    const main = write("src/main.ts", 'import { a } from "./missing.js";\nexport const v = a;\n');

    const verdict = (await foldProject([main, ...files()])).get(main)!;

    // The `[fold:run]` line starts with the importing file; the reason names
    // the specifier as the path it was looked for at.
    expect(verdict.verdict).toBe("run");
    expect(verdict.reason).toContain(join("src", "missing.js"));
  });

  test("a paths pattern with no file behind it keeps a run reason", async () => {
    const main = write("src/main.ts", 'import { a } from "@app/missing";\nexport const v = a;\n');

    const verdict = (await foldProject([main, ...files()])).get(main)!;

    expect(verdict.verdict).toBe("run");
    expect(verdict.reason).toContain("unresolved identifier: a");
    expect(verdict.reason).toContain('"@app/missing"');
  });

  test("paths from an extended config resolve against the config that declares them", async () => {
    write("tsconfig.json", JSON.stringify({ extends: "./configs/base" }));
    write("configs/base.json", '{\n  // JSONC, as tsc reads it\n  "compilerOptions": { "paths": { "@app/*": ["../src/*"] } },\n}\n');
    const main = write("src/main.ts", 'import { a } from "@app/config";\nexport const v = a;\n');

    expect(tsconfigPathsTarget("@app/config", main)).toBe(join(root, "src/config.ts"));
    const verdict = (await foldProject([main, ...files()])).get(main)!;
    expect(verdict.verdict).toBe("fold");
    expect(Object.fromEntries(verdict.exports!)).toEqual({ v: "config" });
  });

  test("paths resolve against baseUrl when the chain sets one", async () => {
    write("tsconfig.json", JSON.stringify({ extends: "./configs/base.json", compilerOptions: { baseUrl: "." } }));
    write("configs/base.json", JSON.stringify({ compilerOptions: { paths: { "@app/*": ["src/*"] } } }));
    const main = write("src/main.ts", "");

    expect(tsconfigPathsTarget("@app/lib", main)).toBe(join(root, "src/lib/index.ts"));
    expect(tsconfigPathsTarget("@other/lib", main)).toBeUndefined();
  });

  test("an exact paths key wins over a pattern, and the longest pattern prefix wins", async () => {
    write("src/special.ts", "export const s = 1;\n");
    write(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: { paths: { "@app/*": ["./src/*"], "@app/lib/*": ["./src/lib/*"], "@app/x": ["./src/special.ts"] } },
      }),
    );
    const main = write("src/main.ts", "");

    expect(tsconfigPathsTarget("@app/x", main)).toBe(join(root, "src/special.ts"));
    expect(tsconfigPathsTarget("@app/lib/helpers.mjs", main)).toBe(join(root, "src/lib/helpers.mts"));
  });

  test("a paths entry that maps an active lexicon's name is a project file, and its trust is decided on that path", async () => {
    write("tsconfig.json", JSON.stringify({ compilerOptions: { paths: { "esm-only": ["./src/shadow.ts"] } } }));
    const shadow = write(
      "src/shadow.ts",
      'export const d = "shadow";\nexport function make(v: string) { return `${v}:${process.pid}`; }\n',
    );
    const dataUser = write("src/data.ts", 'import { d } from "esm-only";\nexport const v = d;\n');
    const callUser = write("src/call.ts", 'import { make } from "esm-only";\nexport const v = make("x");\n');
    const all = [dataUser, callUser, shadow, ...files()];

    const plain = await foldProject(all, [], { lexiconPackages: ["esm-only"] });
    // The project file is folded, not the package's export read.
    expect(Object.fromEntries(plain.get(dataUser)!.exports!)).toEqual({ v: "shadow" });
    // Invoking it is invoking project code, which the default mode refuses,
    // whatever the specifier's text says.
    expect(plain.get(callUser)!.verdict).toBe("run");
    expect(plain.get(callUser)!.reason).toContain(join("src", "shadow.ts"));
    expect(plain.get(callUser)!.reason).toContain("does not invoke a declared project function");

    const sandboxed = await foldProject(all, [], { lexiconPackages: ["esm-only"], sandbox: true });
    expect(sandboxed.get(callUser)!.verdict).toBe("run");
  });
});

describe("packageExportsTarget (chant#3090)", () => {
  test("reads condition objects in key order against import, node and default", () => {
    expect(packageExportsTarget({ ".": { types: "./a.d.ts", import: "./a.mjs", default: "./a.cjs" } }, ".")).toBe("./a.mjs");
    expect(packageExportsTarget({ require: "./r.cjs", node: { import: "./n.mjs" } }, ".")).toBe("./n.mjs");
    expect(packageExportsTarget({ ".": { require: "./r.cjs" } }, ".")).toBeUndefined();
  });

  test("an exact subpath key wins, then the longest pattern prefix", () => {
    const map = { "./*": "./src/*.js", "./sub/*": "./sub/*.js", "./sub/x": "./exact.js", "./internal/*": null };
    expect(packageExportsTarget(map, "./sub/x")).toBe("./exact.js");
    expect(packageExportsTarget(map, "./sub/y")).toBe("./sub/y.js");
    expect(packageExportsTarget(map, "./top")).toBe("./src/top.js");
    expect(packageExportsTarget(map, "./internal/z")).toBeUndefined();
  });

  test("a subpath is not exported by a root-only exports field", () => {
    expect(packageExportsTarget("./index.js", "./sub")).toBeUndefined();
    expect(packageExportsTarget({ import: "./index.js" }, "./sub")).toBeUndefined();
  });
});
