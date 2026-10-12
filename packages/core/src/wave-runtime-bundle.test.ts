/**
 * The wave-job runtime bundles to one self-contained file (#3896). A product
 * copies `dist/wave-runtime.mjs` into its CI image with no npm install of
 * chant, so the file may import nothing but `node:` builtins, and it carries
 * no TypeScript compiler, esbuild or tsx: those three are the 33 MB a wave
 * job's image has no use for. This builds it the way `npm run build` does and
 * reads esbuild's own list of what went in.
 */

import { builtinModules } from "node:module";
import { describe, expect, test } from "vitest";
// @ts-expect-error: a plain .mjs script with no type declarations
import { buildWaveRuntime, LEFT_OUT } from "../scripts/build-wave-runtime.mjs";

interface Metafile {
  inputs: Record<string, { bytes: number; imports: { path: string; kind: string; external?: boolean }[] }>;
  outputs: Record<string, { imports: { path: string; kind: string; external?: boolean }[]; inputs: Record<string, { bytesInOutput: number }> }>;
}

const built = (await buildWaveRuntime({ write: false })) as { bytes: number; metafile: Metafile; text: string };
const output = Object.values(built.metafile.outputs)[0]!;
const inputs = Object.keys(output.inputs);

describe("the wave-job runtime bundle (#3896)", () => {
  test("leaves out the TypeScript compiler, esbuild and tsx", () => {
    expect(LEFT_OUT).toEqual(["typescript", "esbuild", "tsx"]);
    for (const name of LEFT_OUT as string[]) {
      expect(inputs.filter((i) => i.includes(`node_modules/${name}/`)), name).toEqual([]);
    }
  });

  test("imports nothing but node: builtins, so it runs with no node_modules", () => {
    const builtins = new Set(builtinModules);
    const imported = output.imports.map((i) => i.path);
    expect(imported.filter((p) => !builtins.has(p.replace(/^node:/, "").split("/")[0]!))).toEqual([]);
    // zod, ajv, js-yaml and picomatch are inlined; nothing reads them from disk.
    for (const pkg of ["zod", "ajv", "js-yaml", "picomatch"]) {
      expect(inputs.some((i) => i.includes(`node_modules/${pkg}/`)), pkg).toBe(true);
    }
    expect(built.text).not.toMatch(/createRequire\(import\.meta\.url\)\("\.\.\/\.\.\/package\.json"\)/);
  });

  test("a left-out package is reached only through import(), never on start", () => {
    // The build refuses otherwise; this pins the four commands' own modules as the static graph.
    const entry = Object.keys(built.metafile.inputs).find((k) => k.endsWith("src/wave-runtime.ts"))!;
    const seen = new Set([entry]);
    const queue = [entry];
    while (queue.length) {
      for (const im of built.metafile.inputs[queue.shift()!]?.imports ?? []) {
        if (im.kind === "dynamic-import" || seen.has(im.path)) continue;
        seen.add(im.path);
        queue.push(im.path);
      }
    }
    for (const handler of ["cli/handlers/run-wave.ts", "cli/handlers/gate-resume.ts", "cli/handlers/approve.ts", "workspace/points-cli.ts", "cli/parse-args.ts"]) {
      expect([...seen].some((k) => k.endsWith(`src/${handler}`)), handler).toBe(true);
    }
    expect([...seen].filter((k) => k.startsWith("chant-wave-runtime-left-out:"))).toEqual([]);
    // Neither the full CLI's dispatch nor the operator loop is in it, and the build and plugin loader load on no start.
    expect(inputs.filter((i) => /src\/cli\/main\.ts$|src\/cli\/handlers\/operator\.ts$/.test(i))).toEqual([]);
    expect([...seen].filter((i) => /src\/cli\/plugins\.ts$|src\/build\.ts$/.test(i))).toEqual([]);
  });

  test("carries its version and stays small", () => {
    expect(built.text).toContain('"workspace points"');
    expect(built.text.startsWith("#!/usr/bin/env node\n")).toBe(true);
    // About 1.45 MB minified today (440 KB gzipped), zod's inlined schemas about 300 KB of it.
    expect(built.bytes).toBeLessThan(2 * 1024 * 1024);
  });
});
