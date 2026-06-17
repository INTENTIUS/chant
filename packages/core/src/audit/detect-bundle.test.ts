import { describe, test, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "url";

/**
 * #426: the per-lexicon `detect` modules must be importable on the edge — i.e.
 * bundling them pulls in NO `typescript` (the compiler that `plugin.ts` drags via
 * declarative rules) and NOT `plugin.ts` itself. This is what lets the hosted
 * service content-detect all lexicons on Workers.
 */
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const LEXICONS = ["k8s", "docker", "aws", "azure", "gcp", "helm"];

describe("detectTemplate modules are edge-bundle clean", () => {
  test("importing every lexicon's /detect pulls in no typescript or plugin.ts", async () => {
    const contents =
      LEXICONS.map((l, i) => `import { detectTemplate as d${i} } from "@intentius/chant-lexicon-${l}/detect";`).join("\n") +
      `\nexport const detectors = [${LEXICONS.map((_, i) => `d${i}`).join(", ")}];\n`;

    const result = await build({
      stdin: { contents, resolveDir: repoRoot, loader: "ts" },
      bundle: true,
      format: "esm",
      platform: "node",
      metafile: true,
      write: false,
      outfile: "out.js",
      logLevel: "silent",
    });

    const inputs = Object.keys(result.metafile.inputs);
    expect(inputs.some((p) => p.includes("node_modules/typescript"))).toBe(false);
    expect(inputs.some((p) => p.endsWith("/plugin.ts"))).toBe(false);
  }, 30_000);
});
