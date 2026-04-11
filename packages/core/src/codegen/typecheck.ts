/**
 * Type-check generated .d.ts files by spawning tsc.
 */
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createRequire } from "module";
import { getRuntime } from "../runtime-adapter";

// Resolve tsc binary path — works regardless of cwd when spawning.
function resolveTsc(): string {
  try {
    const req = createRequire(import.meta.url);
    const tscPkg = req.resolve("typescript/bin/tsc");
    return tscPkg;
  } catch {
    return "tsc";
  }
}

/**
 * Minimal TypeScript lib stub — declares just enough built-in types for
 * validating generated .d.ts files without needing the full standard library.
 * This avoids transient failures from corrupted bunx TypeScript caches.
 */
const MINIMAL_LIB = `
interface Array<T> { length: number; [n: number]: T; }
interface ReadonlyArray<T> { length: number; readonly [n: number]: T; }
interface String { length: number; }
interface Boolean {}
interface Number {}
interface Function {}
interface CallableFunction extends Function {}
interface NewableFunction extends Function {}
interface Object {}
interface RegExp {}
interface IArguments {}
interface Symbol {}
type Record<K extends string | number | symbol, V> = { [P in K]: V; };
type Partial<T> = { [P in keyof T]?: T[P]; };
type Required<T> = { [P in keyof T]-?: T[P]; };
type Readonly<T> = { readonly [P in keyof T]: T[P]; };
type Pick<T, K extends keyof T> = { [P in K]: T[P]; };
type Omit<T, K extends string | number | symbol> = Pick<T, Exclude<keyof T, K>>;
type Exclude<T, U> = T extends U ? never : T;
type Extract<T, U> = T extends U ? T : never;
type NonNullable<T> = T extends null | undefined ? never : T;
type ReturnType<T extends (...args: any) => any> = T extends (...args: any) => infer R ? R : any;
type InstanceType<T extends abstract new (...args: any) => any> = T extends abstract new (...args: any) => infer R ? R : any;
type Promise<T> = { then<TResult>(onfulfilled?: (value: T) => TResult): Promise<TResult>; };
interface TemplateStringsArray extends ReadonlyArray<string> { readonly raw: readonly string[]; }
`;

export interface TypeCheckResult {
  ok: boolean;
  diagnostics: string[];
  fileCount: number;
}

/**
 * Type-check a .d.ts content string by writing to a temp file and running tsc.
 */
export async function typecheckDTS(content: string): Promise<TypeCheckResult> {
  // Create temp directory
  const dir = join(tmpdir(), `chant-typecheck-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });

  try {
    // Write the .d.ts file
    const dtsPath = join(dir, "index.d.ts");
    writeFileSync(dtsPath, content);

    // Write a minimal lib stub so tsc doesn't depend on a full TypeScript
    // standard library installation (avoids bunx cache corruption issues).
    writeFileSync(
      join(dir, "lib.d.ts"),
      MINIMAL_LIB,
    );

    // Write stubs for @intentius/chant sub-path imports used in generated .d.ts files.
    // tsc runs in a temp dir with no node_modules, so these must be declared manually.
    const chantDeclarableDir = join(dir, "node_modules", "@intentius", "chant", "declarable");
    mkdirSync(chantDeclarableDir, { recursive: true });
    writeFileSync(
      join(chantDeclarableDir, "index.d.ts"),
      `export interface Declarable<TProps = Record<string, unknown>> { props: TProps; }\n`,
    );
    writeFileSync(
      join(chantDeclarableDir, "package.json"),
      JSON.stringify({ name: "@intentius/chant/declarable", main: "index.d.ts", types: "index.d.ts" }),
    );

    // Write a minimal tsconfig — noLib: true prevents tsc from looking for
    // standard lib files; our lib.d.ts is included via the include array.
    const tsconfig = {
      compilerOptions: {
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        noLib: true,
        target: "ES2022",
        module: "ES2022",
        moduleResolution: "bundler",
      },
      include: ["lib.d.ts", "index.d.ts"],
    };
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));

    // Run tsc using absolute path to avoid npx/cwd resolution issues
    const rt = getRuntime();
    const tscBin = resolveTsc();
    const cmd = tscBin === "tsc"
      ? [rt.commands.exec, "tsc", "--noEmit", "--project", "tsconfig.json"]
      : [rt.commands.runner, tscBin, "--noEmit", "--project", "tsconfig.json"];
    const { stdout, stderr, exitCode } = await rt.spawn(cmd, { cwd: dir });

    // Parse diagnostics from stdout (tsc writes errors to stdout)
    const output = stdout + stderr;
    const diagnostics = output
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .filter((line) => /error TS\d+/.test(line) || /:\d+:\d+/.test(line));

    return {
      ok: exitCode === 0,
      diagnostics,
      fileCount: 1,
    };
  } finally {
    // Cleanup
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  }
}
