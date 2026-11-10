/**
 * `chant dev local` and `chant dev bundle-check` (#4787): build a product
 * against a chant checkout, and check the product's bundle. Both modules are
 * imported here, before the install, so the command keeps running the chant
 * it started with while npm replaces the installed one.
 */
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { checkBundle, readBundleCheckConfig, type BundleCheckResult } from "../../bundle-check";
import { installLocalChant, LocalChantError, localChantImage, productManifests, resetLocalChant, type LocalChantResult } from "../../local-chant";
import { formatError } from "../format";
import type { CommandContext } from "../registry";

const LOCAL_USAGE = "chant dev local <chant-dir> [--with <package>]... [--build '<command>'] [--json] | chant dev local --reset [--build '<command>']";
const CHECK_USAGE = "chant dev bundle-check [<package-dir>] [--json]";
const IMAGE_USAGE = "chant dev local-image [--with <package>]... [--json] [-- <docker build arguments>...]";

/** The product packages that declare `chantBundleCheck`, as directories. */
function checkedPackages(productDir: string): string[] {
  return productManifests(productDir)
    .map((f) => join(productDir, f.replace(/\/?package\.json$/, "")))
    .filter((d) => readBundleCheckConfig(d) !== undefined);
}

/** Run each package's bundle check and print the result; true when every one passes. */
function runChecks(dirs: string[], json: boolean): { ok: boolean; results: (BundleCheckResult & { dir: string })[] } {
  const results = dirs.map((dir) => ({ dir, ...checkBundle(dir, readBundleCheckConfig(dir)!) }));
  if (!json) {
    for (const r of results) {
      if (r.ok) console.error(`  bundle-check: ${r.summary}`);
      else console.error(`bundle-check: ${r.dir}\n  ${r.problems.join("\n  ")}`);
    }
  }
  return { ok: results.every((r) => r.ok), results };
}

/** The product's build, as one shell command in its root. */
function runBuild(command: string, cwd: string): boolean {
  console.error(`chant dev local: ${command}`);
  const r = spawnSync("sh", ["-c", command], { cwd, stdio: "inherit" });
  return r.status === 0;
}

/**
 * `chant dev local <chant-dir>`: pack the checkout and install it into the
 * product in the current directory (`installLocalChant`), run `--build`, then
 * the bundle check of every package that declares `chantBundleCheck`.
 * `--reset` goes back to the lock's pins the same way. Exit 1 when a step
 * fails, 2 for a usage error.
 */
export async function runDevLocal(ctx: CommandContext): Promise<number> {
  const productDir = process.cwd();
  const reset = ctx.args.reset === true;
  const chantDir = ctx.args.extraPositional;
  if (reset === (chantDir !== undefined)) {
    console.error(formatError({ message: reset ? "--reset takes no chant directory" : "chant dev local needs a chant checkout", hint: LOCAL_USAGE }));
    return 2;
  }
  let installed: LocalChantResult | undefined;
  try {
    if (reset) resetLocalChant({ productDir });
    else installed = installLocalChant({ productDir, chantDir: resolve(chantDir!), with: ctx.args.withPackages });
  } catch (err) {
    if (!(err instanceof LocalChantError)) throw err;
    console.error(formatError({ message: err.message }));
    return 1;
  }
  if (ctx.args.buildCommand && !runBuild(ctx.args.buildCommand, productDir)) {
    console.error(formatError({ message: `the build failed: ${ctx.args.buildCommand}` }));
    return 1;
  }
  const dirs = checkedPackages(productDir);
  if (!dirs.length) console.error("chant dev local: no package declares chantBundleCheck, so no bundle was checked");
  const { ok, results } = runChecks(dirs, ctx.args.json === true);
  if (ctx.args.json) {
    console.log(JSON.stringify({ reset, local: installed ? { commit: installed.mark.commit, dir: installed.mark.dir, packed: installed.packed.map((p) => ({ name: p.name, version: p.version })), marked: installed.marked } : undefined, checks: results }, null, 2));
  } else if (installed) {
    console.log(`chant commit: ${installed.mark.commit}`);
    console.log(`chant version: ${installed.packed[0]?.version ?? "none"} (local build)`);
  }
  return ok ? 0 : 1;
}

/**
 * `chant dev bundle-check [<package-dir>]`: check one package's bundle against
 * its `chantBundleCheck`, or, with no directory, every package of the product
 * in the current directory that declares one.
 */
export async function runDevBundleCheck(ctx: CommandContext): Promise<number> {
  const dir = ctx.args.extraPositional;
  let dirs: string[];
  if (dir !== undefined) {
    if (readBundleCheckConfig(resolve(dir)) === undefined) {
      console.error(formatError({ message: `${join(dir, "package.json")} has no chantBundleCheck`, hint: CHECK_USAGE }));
      return 2;
    }
    dirs = [resolve(dir)];
  } else {
    dirs = checkedPackages(process.cwd());
    if (!dirs.length) {
      console.error(formatError({ message: "no package here declares chantBundleCheck", hint: CHECK_USAGE }));
      return 2;
    }
  }
  const { ok, results } = runChecks(dirs, ctx.args.json === true);
  if (ctx.args.json) console.log(JSON.stringify(results, null, 2));
  return ok ? 0 : 1;
}

/**
 * `chant dev local-image [--with <package>]... [-- <docker build arguments>]`
 * (#4909): build a product's image with the chant the product has installed.
 * With no docker arguments it prints the chant version the image would
 * install (the pin, or `local-<commit>`), for a label that rebuilds the image
 * when it changes; `--json` prints the version, the mark and the arguments.
 * With them it runs `docker build` with `--build-arg CHANT_VERSION=<version>`
 * and, for a `chant dev local` build, `--build-context
 * chant-local=<product>/.chant-local` first. `--with` names a package the
 * image installs from the tarballs besides core. Exit 1 when the local build's
 * tarballs are missing or docker fails, 2 for a usage error.
 */
export async function runDevLocalImage(ctx: CommandContext): Promise<number> {
  const docker = (ctx.args.positionals ?? []).slice(1);
  let image;
  try {
    image = localChantImage(process.cwd(), { with: ctx.args.withPackages });
  } catch (err) {
    if (!(err instanceof LocalChantError)) throw err;
    console.error(formatError({ message: err.message, hint: IMAGE_USAGE }));
    return 1;
  }
  if (docker.length === 0) {
    if (ctx.args.json) console.log(JSON.stringify(image, null, 2));
    else console.log(image.version);
    return 0;
  }
  console.error(`chant dev local-image: docker build with chant ${image.version}`);
  const r = spawnSync("docker", ["build", ...image.args, ...docker], { cwd: process.cwd(), stdio: "inherit" });
  if (r.error) {
    console.error(formatError({ message: `docker build: ${r.error.message}` }));
    return 1;
  }
  return r.status === 0 ? 0 : 1;
}
