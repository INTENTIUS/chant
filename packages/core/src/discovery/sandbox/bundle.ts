import * as esbuild from "esbuild";
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * chant #1045 Phase 2 — bundles the generated sandbox driver (`./driver.ts`)
 * into one self-contained ESM file with esbuild, so the sandboxed child never
 * needs to resolve a module from disk at runtime (see `./driver.ts`'s doc for
 * why that's what lets the permission allowlist stay this narrow).
 *
 * A fresh temp directory per call — not a shared cache directory — keeps
 * concurrent builds (nested stacks, parallel test workers) from racing on the
 * same output path; callers are responsible for cleaning it up (`./run.ts`
 * does, in a `finally`) once the child has reported back.
 */

const HERE = import.meta.dirname;
const require = createRequire(import.meta.url);

/**
 * Packages that must NOT be bundled — see {@link resolveExternalPackages}'s
 * doc for why. Every lexicon that ships a lint rule doing AST-based analysis
 * (`aws`, `azure`, `fly`, `gcp`, `github`, `gitlab`, `helm`, `k8s` all do)
 * imports `typescript` at the top of that rule module, and lexicon plugin
 * objects re-export their lint rules eagerly — so bundling ANY run-fallback
 * file that imports a lexicon package pulls `typescript` in transitively,
 * every time, not just for the rare file that uses the compiler itself.
 */
const EXTERNAL_PACKAGES = ["typescript"];

/**
 * Resolve each of {@link EXTERNAL_PACKAGES} to its real, absolute path on
 * disk (from THIS file's own location — the same package.json dependency
 * chant's own `fold-import.ts` already resolves "typescript" through) and
 * return an esbuild plugin that rewrites any import of that bare specifier
 * to the resolved absolute path, marked external.
 *
 * Why external at all: `typescript` is itself a large, over-eager CJS
 * package — its own internal `getNodeSystem()`-style helpers call
 * `require("fs")`/`require("path")` from deep inside factory functions, not
 * from top-level imports esbuild can safely rewrite. Bundled into ESM
 * output, that nested `require` has no real binding and esbuild's shim
 * throws `Dynamic require of "fs" is not supported` — a build that just
 * transitively imports `typescript` never even gets to execute the run-
 * fallback file it was meant for. Left external and resolved to an absolute
 * path, Node loads the REAL `typescript` package directly (no bare-specifier
 * `node_modules` walk needed, so no broader `--allow-fs-read` grant beyond
 * that one resolved path — see `./run.ts`), with its own native `require`
 * intact — no interop shim, no problem.
 *
 * `typescript` is trusted, chant-shipped infrastructure (a dependency of
 * chant itself and every lexicon that lints), never something project
 * source controls the content of, so resolving and exposing it this way
 * doesn't weaken the boundary around untrusted project code.
 */
function externalTrustedPackagesPlugin(): { plugin: esbuild.Plugin; readPaths: string[] } {
  const readPaths: string[] = [];
  const resolved = new Map<string, string>();

  for (const name of EXTERNAL_PACKAGES) {
    try {
      const path = require.resolve(name, { paths: [HERE] });
      resolved.set(name, path);
      readPaths.push(dirname(path));
    } catch {
      // Not installed/resolvable from here — nothing to externalize; a run-
      // fallback file that imports it will simply fail to resolve inside the
      // sandbox, same as any other genuinely missing dependency would.
    }
  }

  const plugin: esbuild.Plugin = {
    name: "chant-sandbox-external-trusted-packages",
    setup(build) {
      for (const [name, path] of resolved) {
        const filter = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
        build.onResolve({ filter }, () => ({ path, external: true }));
      }
    },
  };

  return { plugin, readPaths };
}

export interface BundleResult {
  /** Absolute, REALPATH'd path to the bundled entry file — this and {@link bundleDir} are what the caller grants `--allow-fs-read` to. macOS's `/tmp` is a symlink to `/private/tmp`; an un-canonicalized path here would silently fail to match Node's own (already-canonicalized) permission check. */
  bundlePath: string;
  /** Absolute, REALPATH'd directory containing {@link bundlePath} — remove with `rmSync(bundleDir, { recursive: true, force: true })` once done. */
  bundleDir: string;
  /** Directories the child ALSO needs `--allow-fs-read` for — the resolved locations of {@link EXTERNAL_PACKAGES}, which are deliberately left unbundled (see {@link externalTrustedPackagesPlugin}'s doc). Empty when none of those packages were actually imported. */
  externalReadPaths: string[];
  /** Wall-clock bundling time — chant#1045 asks this be measured and reported, not silently accepted. */
  durationMs: number;
  /** Bundle size in bytes. */
  bytes: number;
}

/**
 * Bundle `driverSource` (see {@link import("./driver").generateDriverSource})
 * into a single self-contained ESM file.
 */
export async function bundleDriver(driverSource: string): Promise<BundleResult> {
  const bundleDir = realpathSync(mkdtempSync(join(tmpdir(), "chant-sandbox-")));
  const entryPath = join(bundleDir, "driver.mts");
  writeFileSync(entryPath, driverSource, "utf-8");
  const outfile = join(bundleDir, "child.mjs");

  const { plugin, readPaths } = externalTrustedPackagesPlugin();

  const start = performance.now();
  try {
    await esbuild.build({
      entryPoints: [entryPath],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      absWorkingDir: bundleDir,
      logLevel: "silent",
      plugins: [plugin],
    });
  } catch (err) {
    rmSync(bundleDir, { recursive: true, force: true });
    throw err;
  }
  const durationMs = performance.now() - start;
  const bytes = statSync(outfile).size;

  return { bundlePath: outfile, bundleDir, externalReadPaths: readPaths, durationMs, bytes };
}
