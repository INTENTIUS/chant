import { describe, test, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "url";

/**
 * #408: importing the audit core must NOT statically pull in `cli/plugins`
 * (which drags in the config loader and the TypeScript compiler — fatal on edge
 * runtimes). `loadPlugins` is reached only via a lazy `import()` inside
 * `load()`, so with code splitting `cli/plugins` lands in a separate chunk and
 * never in the entry chunk that an embedder bundles.
 */
const coreEntry = fileURLToPath(new URL("./core.ts", import.meta.url));

describe("audit core bundle graph", () => {
  test("auditFiles entry does not statically import cli/plugins", async () => {
    const result = await build({
      entryPoints: [coreEntry],
      bundle: true,
      format: "esm",
      splitting: true,
      platform: "node",
      // Skip node_modules (incl. the huge `typescript` package) — we only care
      // about which internal modules land in the entry chunk.
      packages: "external",
      metafile: true,
      write: false,
      outdir: "out",
      logLevel: "silent",
    });

    const outputs = result.metafile.outputs;
    const entry = Object.values(outputs).find((o) => o.entryPoint?.endsWith("audit/core.ts"));
    expect(entry, "core.ts entry chunk present").toBeDefined();

    const entryInputs = Object.keys(entry!.inputs);
    // The entry chunk must not contain cli/plugins source — only a lazy chunk may.
    expect(entryInputs.some((p) => p.includes("cli/plugins"))).toBe(false);

    // Sanity: cli/plugins is still reachable, just split into its own chunk
    // (proving we lazy-load it rather than dropping the dependency entirely).
    const allInputs = Object.values(outputs).flatMap((o) => Object.keys(o.inputs));
    expect(allInputs.some((p) => p.includes("cli/plugins"))).toBe(true);
  }, 30_000);
});
