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
async function entryInputsFor(file: string): Promise<{ entryInputs: string[]; allInputs: string[] }> {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(file, import.meta.url))],
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
  const entry = Object.values(outputs).find((o) => o.entryPoint?.endsWith(file.replace("./", "audit/")));
  return {
    entryInputs: entry ? Object.keys(entry.inputs) : [],
    allInputs: Object.values(outputs).flatMap((o) => Object.keys(o.inputs)),
  };
}

/**
 * #408/#426: importing the audit entry points must NOT statically pull in
 * `cli/plugins` — it drags the config loader and the root barrel (index.ts ->
 * lint/parser -> the TypeScript compiler), fatal on edge runtimes. `loadPlugins`
 * / `loadPlugin` are reached only via lazy `import()`, so with code splitting
 * `cli/plugins` lands in a separate chunk, never the entry an embedder bundles.
 */
describe("audit bundle graph (edge-safe entries)", () => {
  test("audit/core (auditFiles) does not statically import cli/plugins", async () => {
    const { entryInputs, allInputs } = await entryInputsFor("./core.ts");
    expect(entryInputs.length, "core.ts entry chunk present").toBeGreaterThan(0);
    expect(entryInputs.some((p) => p.includes("cli/plugins"))).toBe(false);
    // Still reachable, just split into its own chunk (lazy, not dropped).
    expect(allInputs.some((p) => p.includes("cli/plugins"))).toBe(true);
  }, 30_000);

  test("audit/discover (classifyFiles) does not statically import cli/plugins", async () => {
    const { entryInputs } = await entryInputsFor("./discover.ts");
    expect(entryInputs.length, "discover.ts entry chunk present").toBeGreaterThan(0);
    expect(entryInputs.some((p) => p.includes("cli/plugins"))).toBe(false);
  }, 30_000);
});
