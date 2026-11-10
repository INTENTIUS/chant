import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { bundleImports, checkBundle, chantExternalPlugin, chantRuntimeTarget, type BundleCheckConfig } from "./bundle-check";

/** #4787: a product checked by chant's bundle check instead of its own scripts/bundle-check.mjs. */

const write = (file: string, body: string | object) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body, null, 2));
};

/** A product with one workspace package, `packages/app`, and an installed chant 1.2.3. */
function product(opts: { bundle?: string; deps?: Record<string, string>; installed?: object; config?: Partial<BundleCheckConfig> } = {}) {
  const root = mkdtempSync(join(tmpdir(), "chant-4787-bundle-"));
  write(join(root, "package.json"), { name: "product", private: true, workspaces: ["packages/*"], devDependencies: { "@intentius/chant": "1.2.3" } });
  const chant = join(root, "node_modules/@intentius/chant");
  write(join(chant, "package.json"), {
    name: "@intentius/chant",
    version: "1.2.3",
    exports: {
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js", default: "./src/index.ts" },
      "./ts-only": { import: "./src/ts-only.ts" },
      "./*": { import: "./dist/*.js", default: "./src/*.ts" },
    },
    ...opts.installed,
  });
  write(join(chant, "dist/index.js"), "export {};\n");
  write(join(chant, "dist/notify.js"), "export {};\n");
  write(join(chant, "src/ts-only.ts"), "export {};\n");
  const app = join(root, "packages/app");
  write(join(app, "package.json"), {
    name: "@example/app",
    version: "0.1.0",
    dependencies: opts.deps ?? { "@intentius/chant": "1.2.3" },
    chantBundleCheck: { bundle: "dist/app.mjs", ...opts.config },
  });
  write(join(app, "dist/app.mjs"), opts.bundle ?? 'import { readFileSync } from "node:fs";\nimport { a } from "@intentius/chant";\nconst n = await import("@intentius/chant/notify");\nimport("./local.mjs");\n');
  return { root, app, config: { bundle: "dist/app.mjs", ...opts.config } as BundleCheckConfig };
}

describe("chantRuntimeTarget (#4787)", () => {
  it("names the compiled file for a subpath the installed chant serves as JS", () => {
    const { app, root } = product();
    expect(chantRuntimeTarget("@intentius/chant", app)).toBe(join(root, "node_modules/@intentius/chant/dist/index.js"));
    expect(chantRuntimeTarget("@intentius/chant/notify", app)).toBe(join(root, "node_modules/@intentius/chant/dist/notify.js"));
  });

  it("answers undefined for TypeScript, a missing file, another package, or no install", () => {
    const { app } = product();
    expect(chantRuntimeTarget("@intentius/chant/ts-only", app)).toBeUndefined();
    expect(chantRuntimeTarget("@intentius/chant/absent", app)).toBeUndefined();
    expect(chantRuntimeTarget("left-pad", app)).toBeUndefined();
    expect(chantRuntimeTarget("@intentius/chant-lexicon-k8s", app)).toBeUndefined();
  });

  it("the esbuild plugin leaves only compiled chant imports external", () => {
    const { app } = product();
    const external = new Set<string>();
    let cb: ((a: { path: string }) => unknown) | undefined;
    chantExternalPlugin(app, external).setup({ onResolve: (_o, f) => { cb = f; } });
    expect(cb!({ path: "@intentius/chant/notify" })).toEqual({ path: "@intentius/chant/notify", external: true });
    expect(cb!({ path: "@intentius/chant/ts-only" })).toBeUndefined();
    expect([...external]).toEqual(["@intentius/chant/notify"]);
  });

  it("keeps external only the chant packages in the package's dependencies, or the ones it is given (#4922)", () => {
    const { app, root } = product();
    const lexicon = join(root, "node_modules/@intentius/chant-lexicon-k8s");
    write(join(lexicon, "package.json"), { name: "@intentius/chant-lexicon-k8s", version: "1.2.3", exports: { ".": { import: "./dist/index.js" } } });
    write(join(lexicon, "dist/index.js"), "export {};\n");
    const resolver = (plugin: ReturnType<typeof chantExternalPlugin>) => {
      let cb: ((a: { path: string }) => unknown) | undefined;
      plugin.setup({ onResolve: (_o, f) => { cb = f; } });
      return cb!;
    };
    // The app depends on @intentius/chant only, so the lexicon (a devDependency it bundles) stays in the bundle.
    const byDeps = resolver(chantExternalPlugin(app));
    expect(byDeps({ path: "@intentius/chant/notify" })).toEqual({ path: "@intentius/chant/notify", external: true });
    expect(byDeps({ path: "@intentius/chant-lexicon-k8s" })).toBeUndefined();
    // Named packages win over the dependencies.
    const external = new Set<string>();
    const named = resolver(chantExternalPlugin(app, { packages: ["@intentius/chant-lexicon-k8s"], external }));
    expect(named({ path: "@intentius/chant-lexicon-k8s" })).toEqual({ path: "@intentius/chant-lexicon-k8s", external: true });
    expect(named({ path: "@intentius/chant" })).toBeUndefined();
    expect([...external]).toEqual(["@intentius/chant-lexicon-k8s"]);
  });
});

describe("bundleImports (#4787)", () => {
  it("reads static, dynamic and require imports and skips relative ones and junk strings", () => {
    const text = 'import a from "x";export{b}from"y/z";import"side";const c=import("@s/p/q");require("node:fs");import("./rel.mjs");x="import \'not a spec\'"';
    expect(bundleImports(text).sort()).toEqual(["@s/p/q", "node:fs", "side", "x", "y/z"]);
  });
});

describe("checkBundle (#4787)", () => {
  it("passes a bundle that imports Node and chant served as compiled JS, on the root's pin", () => {
    const { app, config } = product();
    const r = checkBundle(app, config);
    expect(r.problems).toEqual([]);
    expect(r.chantImports.sort()).toEqual(["@intentius/chant", "@intentius/chant/notify"]);
    expect(r.summary).toContain("chant 1.2.3");
  });

  it("fails a chant import served only as TypeScript and an import of a package that is not a dependency", () => {
    const { app, config } = product({ bundle: 'import "@intentius/chant/ts-only";\nimport "left-pad";\n' });
    const r = checkBundle(app, config);
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toContain("'@intentius/chant/ts-only', which the installed package's exports do not serve as compiled JS");
    expect(r.problems.join("\n")).toContain("'left-pad', which is neither a Node module nor a runtime dependency");
  });

  it("lets an optional package through", () => {
    const { app, config } = product({ bundle: 'import "@intentius/chant";\nimport("@cdktn/hcl2json");\n', config: { optional: ["@cdktn/hcl2json"] } });
    expect(checkBundle(app, config).problems).toEqual([]);
  });

  it("fails a dependency nothing loads, and takes one that needs names", () => {
    const deps = { "@intentius/chant": "1.2.3", "@intentius/chant-lexicon-k8s": "1.2.3" };
    const unused = product({ deps });
    expect(checkBundle(unused.app, unused.config).problems).toContain("@intentius/chant-lexicon-k8s is a runtime dependency that the bundle does not import and chantBundleCheck.needs does not name");
    const needed = product({ deps, config: { needs: ["@intentius/chant-lexicon-k8s", "@intentius/chant-lexicon-gitlab"] } });
    const problems = checkBundle(needed.app, needed.config).problems;
    expect(problems).toContain("@intentius/chant-lexicon-k8s is not installed; run npm ci");
    expect(problems).toContain("@intentius/chant-lexicon-gitlab is loaded at run time (chantBundleCheck.needs names it) but is not in dependencies");
  });

  it("fails a chant dependency off the root's pin", () => {
    const { app, config } = product({ deps: { "@intentius/chant": "^1.2.0" } });
    expect(checkBundle(app, config).problems).toContain("@intentius/chant is '^1.2.0' in dependencies, not the root's chant pin 1.2.3");
  });

  it("fails an installed chant off the pin unless chant dev local marked it", () => {
    const off = product({ installed: { version: "1.3.0" } });
    expect(checkBundle(off.app, off.config).problems).toContain("the installed @intentius/chant is 1.3.0, not the pin 1.2.3; run npm ci");
    const local = product({ installed: { version: "1.3.0", chantLocal: { commit: "abcdef0123456789", dir: "/x/chant" } } });
    const r = checkBundle(local.app, local.config);
    expect(r.problems).toEqual([]);
    expect(r.chant).toBe("local chant 1.3.0 (abcdef012345)");
  });

  it("fails a bundle over its ceiling", () => {
    const { app, config } = product({ config: { maxBytes: 10 } });
    expect(checkBundle(app, config).problems.join("\n")).toMatch(/the bundle is \d+ KB, over the 0 KB ceiling/);
  });

  it("fails a denied metafile input, and a deny list without a metafile", () => {
    const deny = [{ pattern: "^typescript/", what: "the TypeScript compiler" }];
    const { app, config } = product({ config: { metafile: "meta.json", deny } });
    write(join(app, "meta.json"), { inputs: { "src/a.ts": {}, "../../node_modules/typescript/lib/typescript.js": {} } });
    expect(checkBundle(app, config).problems).toEqual(["the bundle includes the TypeScript compiler (1 inputs): typescript/lib/typescript.js"]);
    const none = product({ config: { deny } });
    expect(checkBundle(none.app, none.config).problems[0]).toContain("chantBundleCheck.deny needs the build's esbuild metafile");
  });

  it("fails a missing bundle", () => {
    const { app } = product();
    expect(checkBundle(app, { bundle: "dist/none.mjs" }).problems).toContain("no bundle at dist/none.mjs; build it first");
  });
});
