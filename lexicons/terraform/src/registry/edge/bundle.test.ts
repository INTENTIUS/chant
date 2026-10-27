// registry/edge bundles for an edge runtime with no Node built-ins (chant#4589): a Cloudflare Worker
// without nodejs_compat cannot load node:fs or node:crypto, so a browser-platform bundle of the edge
// entry must reach none. The registry writer once pulled core's object-store clients in through
// StoreConflict; it now imports @intentius/chant/object-store/errors, which imports nothing.
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "esbuild";
import { describe, expect, it } from "vitest";

const entry = fileURLToPath(new URL("./index.ts", import.meta.url));

const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

/** Records each Node built-in an import names, with the file that imports it, and keeps it out of the bundle. */
function nodeImports(found: string[]): Plugin {
  return {
    name: "node-imports",
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        const bare = args.path.split("/")[0]!;
        if (!args.path.startsWith("node:") && !builtins.has(args.path) && !builtins.has(bare)) return undefined;
        found.push(`${args.path} (from ${args.importer})`);
        return { path: args.path, external: true };
      });
    },
  };
}

describe("registry/edge bundle", () => {
  it("bundles for platform browser with no node: import", async () => {
    const found: string[] = [];
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2022",
      conditions: ["import", "default"],
      metafile: true,
      logLevel: "silent",
      plugins: [nodeImports(found)],
    });
    expect(result.errors).toEqual([]);
    expect(found).toEqual([]);
    // The object-store clients stay out: only the errors module of core's object store is reached.
    const store = Object.keys(result.metafile.inputs).filter((p) => /object-store\//.test(p));
    expect(store.every((p) => /object-store\/errors\.ts$/.test(p))).toBe(true);
  }, 60_000);
});
