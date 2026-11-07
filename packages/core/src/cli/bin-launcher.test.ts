/**
 * `bin/chant`, the launcher npm links as the `chant` command, is a node script
 * so npm's Windows shim can start it (#4734). Each test copies it into a
 * scratch directory shaped like one of the two layouts it handles, with a
 * stand-in CLI that reports what it was started with:
 *
 * - an installed package (dist/cli/main.js, no tsconfig.build.json), where
 *   the CLI runs in the launcher's own process (#3878);
 * - a source checkout (tsconfig.build.json), where the CLI is src/cli/main.ts
 *   in a second node under tsx's loader and `--conditions=development`
 *   (#3981, #2481).
 */
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const LAUNCHER = resolve(import.meta.dirname, "..", "..", "bin", "chant");

/** A stand-in CLI: prints what it saw as JSON, then exits with the code its first argument names. */
const REPORTER = `
const report = {
  pid: process.pid,
  argv1: process.argv[1],
  args: process.argv.slice(2),
  execArgv: process.execArgv,
  loader: globalThis.__fakeTsxLoader === true,
};
process.stdout.write(JSON.stringify(report));
process.exitCode = Number(process.argv[2] ?? 0);
`;

/** A stand-in CLI that waits for SIGTERM, says it is ready, and exits 3 when the signal comes. */
const WAITER = `
process.on("SIGTERM", () => { process.stdout.write("got SIGTERM"); process.exit(3); });
process.stdout.write("ready\\n");
setInterval(() => {}, 1000);
`;

/** A stand-in CLI that ends itself with SIGTERM. */
const SELF_KILLER = `process.kill(process.pid, "SIGTERM"); setInterval(() => {}, 1000);`;

/**
 * A stand-in for tsx's loader: loads a .ts file as the JavaScript it is (the
 * stand-in CLIs here have no types), where node itself would refuse a .ts
 * file under node_modules, and marks that it ran.
 */
const FAKE_TSX_LOADER = `
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
globalThis.__fakeTsxLoader = true;
registerHooks({
  load(url, context, next) {
    if (url.endsWith(".ts")) return { format: "module", source: readFileSync(fileURLToPath(url), "utf-8"), shortCircuit: true };
    return next(url, context);
  },
});
`;

interface Report {
  pid: number;
  argv1: string;
  args: string[];
  execArgv: string[];
  loader: boolean;
}

let scratch: string | undefined;

afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** A package directory with the launcher at bin/chant. */
function makePackage(pkg: string): string {
  write(join(pkg, "package.json"), JSON.stringify({ name: "@intentius/chant", type: "module", bin: { chant: "./bin/chant" } }));
  mkdirSync(join(pkg, "bin"), { recursive: true });
  copyFileSync(LAUNCHER, join(pkg, "bin", "chant"));
  return join(pkg, "bin", "chant");
}

/** The published layout: compiled main.js, no tsconfig.build.json. */
function installed(cli = REPORTER): { bin: string; main: string } {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "chant-bin-")));
  const pkg = join(scratch, "node_modules", "@intentius", "chant");
  const bin = makePackage(pkg);
  const main = join(pkg, "dist", "cli", "main.js");
  write(main, cli);
  return { bin, main };
}

/**
 * A source checkout: src/cli/main.ts and tsconfig.build.json, with a dist/
 * left over from a build that must not run. `tsx` is "nested" (the
 * package's own node_modules), "hoisted" (the node_modules the package sits
 * in), or absent.
 */
function source(cli = REPORTER, tsx: "nested" | "hoisted" = "nested"): { bin: string; main: string; loader: string } {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "chant-bin-")));
  const pkg = join(scratch, "node_modules", "@intentius", "chant");
  const bin = makePackage(pkg);
  write(join(pkg, "tsconfig.build.json"), "{}");
  write(join(pkg, "dist", "cli", "main.js"), `process.stdout.write("stale dist"); process.exit(99);`);
  const main = join(pkg, "src", "cli", "main.ts");
  write(main, cli);
  const loader =
    tsx === "nested" ? join(pkg, "node_modules", "tsx", "dist", "loader.mjs") : join(scratch, "node_modules", "tsx", "dist", "loader.mjs");
  write(loader, FAKE_TSX_LOADER);
  return { bin, main, loader };
}

function launch(bin: string, args: string[]) {
  const r = spawnSync(process.execPath, [bin, ...args], { encoding: "utf-8" });
  return { ...r, report: r.stdout.startsWith("{") ? (JSON.parse(r.stdout) as Report) : undefined };
}

describe("bin/chant, installed package", () => {
  test("runs dist/cli/main.js in its own process, with argv[1] naming main.js", () => {
    const { bin, main } = installed();
    const r = launch(bin, ["0", "ci", "quarantine filter", "--phase", "a b"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.report).toEqual({ pid: r.pid, argv1: main, args: ["0", "ci", "quarantine filter", "--phase", "a b"], execArgv: [], loader: false });
  });

  test("exits with the CLI's code", () => {
    const { bin } = installed();
    expect(launch(bin, ["7"]).status).toBe(7);
  });

  test("started through a symlink, as npm's .bin link starts it, finds the package it lives in", () => {
    const { bin, main } = installed();
    const link = join(scratch!, "node_modules", ".bin", "chant");
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(join("..", "@intentius", "chant", "bin", "chant"), link);
    const r = launch(link, ["0", "--version"]);
    expect(r.status).toBe(0);
    expect(r.report?.argv1).toBe(main);
    expect(r.report?.args).toEqual(["0", "--version"]);
  });
});

describe("bin/chant, source checkout", () => {
  test("runs src/cli/main.ts in a second node under tsx's loader and the development condition", () => {
    const { bin, main, loader } = source();
    const r = launch(bin, ["0", "with space", "--flag=a b"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.report?.pid).not.toBe(r.pid);
    expect(r.report?.argv1).toBe(main);
    expect(r.report?.args).toEqual(["0", "with space", "--flag=a b"]);
    expect(r.report?.execArgv).toEqual(["--conditions=development", "--import", pathToFileURL(loader).href]);
    expect(r.report?.loader).toBe(true);
  });

  test("finds a tsx hoisted into the node_modules the package is installed in", () => {
    const { bin, loader } = source(REPORTER, "hoisted");
    const r = launch(bin, ["0"]);
    expect(r.status).toBe(0);
    expect(r.report?.execArgv).toEqual(["--conditions=development", "--import", pathToFileURL(loader).href]);
  });

  test("exits with the CLI's code", () => {
    const { bin } = source();
    expect(launch(bin, ["5"]).status).toBe(5);
  });

  test.skipIf(process.platform === "win32")("ends with the signal that ended the CLI", () => {
    const { bin } = source(SELF_KILLER);
    const r = launch(bin, []);
    expect(r.status).toBeNull();
    expect(r.signal).toBe("SIGTERM");
  });

  test.skipIf(process.platform === "win32")("passes a signal sent to it on to the CLI, and exits with the CLI's code", async () => {
    const { bin } = source(WAITER);
    const child = spawn(process.execPath, [bin], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.setEncoding("utf-8");
    await new Promise<void>((done) =>
      child.stdout.on("data", (chunk: string) => {
        out += chunk;
        if (out.includes("ready")) done();
      }),
    );
    child.kill("SIGTERM");
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((done) => child.on("exit", (c, s) => done([c, s])));
    child.stdout.removeAllListeners("data");
    expect(signal).toBeNull();
    expect(code).toBe(3);
  });
});
