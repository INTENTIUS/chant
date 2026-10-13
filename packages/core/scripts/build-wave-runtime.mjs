#!/usr/bin/env node
// Bundles the slim wave-job runtime (#3896): `src/wave-runtime.ts` and every
// module it reaches, into one self-contained ES module at
// `dist/wave-runtime.mjs` whose only imports are `node:` builtins. A product
// copies that file into its CI image and runs `node wave-runtime.mjs run wave
// ...` with no npm install of chant.
//
// The TypeScript compiler, esbuild and tsx are not in it. A few modules the
// four commands can reach import them for work a wave job never does (loading
// a `chant.config.ts`, discovering `*.op.ts`, sandboxing), and only behind a
// dynamic `import()`. Each of those packages is replaced by a module that
// throws when it is evaluated, so such a path fails with a message naming the
// full CLI, and the build fails if one is reachable without a dynamic import
// (it would throw on every start).
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));

/** Packages the runtime never carries. */
export const LEFT_OUT = ["typescript", "esbuild", "tsx"];

const STUB_NS = "chant-wave-runtime-left-out";

const leaveOut = {
  name: "leave-out",
  setup(b) {
    const filter = new RegExp(`^(${LEFT_OUT.join("|")})(/.*)?$`);
    b.onResolve({ filter }, (args) => ({ path: args.path, namespace: STUB_NS }));
    b.onLoad({ filter: /.*/, namespace: STUB_NS }, (args) => ({
      contents:
        `if (typeof module === "object") throw new Error(${JSON.stringify(
          `${args.path} is not part of chant's wave-job runtime (wave-runtime.mjs): ` +
            "this path needs the full @intentius/chant CLI",
        )}); module.exports = {};`,
      loader: "js",
    }));
    for (const [file, contents] of Object.entries(REPLACED)) {
      const filter = new RegExp(`[\\\\/]src[\\\\/]${file.replace(/[/.]/g, (c) => (c === "/" ? "[\\\\/]" : "\\."))}$`);
      b.onLoad({ filter }, () => ({ contents, loader: "js" }));
    }
  },
};

/**
 * Modules whose source reads something next to an installed chant, replaced
 * in the bundle by what the read would find: the version (there is no
 * package.json beside the runtime), and ajv, which the source loads with a
 * `require` resolved from chant's own directory and the bundle carries inline.
 */
const REPLACED = {
  "cli/version.ts": `export const CHANT_VERSION = ${JSON.stringify(version)};`,
  "package-version.ts": `export function readChantPackageVersion() { return ${JSON.stringify(version)}; }`,
  "workspace/ajv2020.ts":
    'export function loadAjv2020() { const mod = require("ajv/dist/2020"); return mod.default ?? mod; }',
};

/** The modules reachable from the entry without crossing a dynamic import. */
function staticallyReached(metafile, entry) {
  const seen = new Set([entry]);
  const queue = [entry];
  while (queue.length) {
    const at = queue.shift();
    for (const im of metafile.inputs[at]?.imports ?? []) {
      if (im.kind === "dynamic-import" || !im.path || seen.has(im.path)) continue;
      seen.add(im.path);
      queue.push(im.path);
    }
  }
  return seen;
}

export async function buildWaveRuntime({ outfile = join(root, "dist", "wave-runtime.mjs"), write = true } = {}) {
  const entry = join(root, "src", "wave-runtime.ts");
  const result = await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    minify: true,
    legalComments: "none",
    metafile: true,
    write: false,
    logLevel: "warning",
    plugins: [leaveOut],
    // CommonJS dependencies bundled into ESM call `require` for builtins.
    banner: {
      js: [
        "#!/usr/bin/env node",
        `// @intentius/chant ${version} wave-job runtime (#3896): run wave, run resume, approve, workspace points.`,
        'import { createRequire as __chantCreateRequire } from "node:module";',
        "const require = __chantCreateRequire(import.meta.url);",
      ].join("\n"),
    },
  });
  const entryKey = Object.keys(result.metafile.inputs).find((k) => k.endsWith("src/wave-runtime.ts"));
  const reached = staticallyReached(result.metafile, entryKey);
  const startup = [...reached].filter((k) => k.startsWith(`${STUB_NS}:`));
  if (startup.length > 0) {
    throw new Error(`wave-runtime: ${startup.join(", ")} would load on every start; reach it only through import()`);
  }
  const external = (result.metafile.outputs[Object.keys(result.metafile.outputs)[0]].imports ?? [])
    .map((i) => i.path)
    .filter((p) => !p.startsWith("node:") && !p.startsWith("."));
  const nonBuiltin = external.filter((p) => !isBuiltin(p));
  if (nonBuiltin.length > 0) throw new Error(`wave-runtime: imports outside node: builtins: ${nonBuiltin.join(", ")}`);
  const [file] = result.outputFiles;
  if (write) writeFileSync(outfile, file.contents, { mode: 0o755 });
  return { bytes: file.contents.byteLength, metafile: result.metafile, text: file.text };
}

function isBuiltin(name) {
  return BUILTINS.has(name.replace(/^node:/, "").split("/")[0]);
}
const { builtinModules } = await import("node:module");
const BUILTINS = new Set(builtinModules);

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { bytes } = await buildWaveRuntime();
  console.error(`dist/wave-runtime.mjs: ${(bytes / 1024).toFixed(0)} KB`);
}
