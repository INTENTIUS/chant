import { describe, test, expect } from "vitest";
import { build } from "esbuild";
import { readFileSync, readdirSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { join } from "path";
import { renderPostSynthBarrelForDir } from "./generate-post-synth-barrel";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const lexiconsDir = join(repoRoot, "lexicons");
const lexiconDirs = readdirSync(lexiconsDir).filter((name) =>
  existsSync(join(lexiconsDir, name, "src", "lint", "post-synth", "index.ts")),
);

describe("post-synth barrel freshness", () => {
  test.each(lexiconDirs)("%s barrel is up to date (run npm run generate)", (lexicon) => {
    const dir = join(lexiconsDir, lexicon, "src", "lint", "post-synth");
    const committed = readFileSync(join(dir, "index.ts"), "utf-8");
    const regenerated = renderPostSynthBarrelForDir(dir, import.meta.url);
    expect(committed, `${lexicon} barrel is stale — run \`npm run generate\``).toBe(regenerated);
  });
});

describe("post-synth barrel is exported", () => {
  // A lexicon that ships a barrel must export it so consumers can import
  // `@intentius/chant-lexicon-<lex>/lint/post-synth` without `/index` (#417).
  test.each(lexiconDirs)("%s exports ./lint/post-synth", (lexicon) => {
    const pkg = JSON.parse(readFileSync(join(lexiconsDir, lexicon, "package.json"), "utf-8"));
    const entry = pkg.exports?.["./lint/post-synth"];
    // Lexicons shipping built artifacts use a conditional export — `development`
    // resolves to source in-repo, `types`/`default` to the emitted barrel.
    // Lexicons not yet building dist keep the plain source string.
    if (typeof entry === "string") {
      expect(entry).toBe("./src/lint/post-synth/index.ts");
    } else {
      expect(entry?.development).toBe("./src/lint/post-synth/index.ts");
      expect(entry?.types).toBe("./dist/lint/post-synth/index.d.ts");
      expect(entry?.default).toBe("./dist/lint/post-synth/index.js");
    }
  });
});

describe("post-synth barrel is edge-bundle clean", () => {
  // The barrel is the entry an edge/bundled deployment imports. It must not drag
  // in the TypeScript compiler or the fs/tsx runtime loader (#409).
  test("github barrel bundles without typescript or the fs loader", async () => {
    const entry = join(lexiconsDir, "github", "src", "lint", "post-synth", "index.ts");
    const result = await build({
      entryPoints: [entry],
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
    // The runtime fs+tsx loader must not be in the graph.
    expect(inputs.some((p) => p.includes("lint/discover"))).toBe(false);
  }, 30_000);
});
