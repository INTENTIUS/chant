/**
 * chant #3089: every example's own tsconfig, and every `chant init` scaffold,
 * passes `tsc --noEmit`.
 *
 * Nothing ran `tsc` on these before. `scripts/typecheck.ts` checks examples
 * through `tsconfig.typecheck.json`, which uses `bundler` resolution, while the
 * examples' own tsconfigs and the one `chant init` wrote used NodeNext. NodeNext
 * rejects the extensionless relative imports chant resolves (TS2835), so a new
 * project failed `tsc`, and so did the examples, unseen.
 *
 * The test has two parts. The first holds each example tsconfig to the module
 * settings a scaffold gets, so the two cannot drift apart. The second runs
 * `tsc`. One `tsc` per project took about 6s each, because `@intentius/chant`
 * resolves to core's source in the repo, and 130 projects would cost minutes.
 * So projects whose compiler options match (ignoring `rootDir` and `outDir`,
 * which are per directory) are checked as one program: a generated tsconfig
 * lists every file their own tsconfigs include. Each file still resolves its
 * imports from its own directory. What a combined program could miss is a
 * global declaration in one project that hides an error in another. When this
 * was written, one `tsc -p` per project, under 5.9 and 7.0, agreed with it.
 *
 * Scaffolds are written to a temp directory with a `node_modules` symlink to
 * the repo's, so lexicon packages resolve to their built `dist/` types.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import ts from "typescript";
import { initCommand } from "../packages/core/src/cli/commands/init";

const run = promisify(execFile);
// Real paths, so they compare equal to the paths tsc reports.
const repoRoot = realpathSync(dirname(dirname(fileURLToPath(import.meta.url))));

/**
 * The TypeScript versions every project must pass under: 5.9, the root
 * `typescript` package, and 7 through scripts/tsc7.sh (#3088).
 */
const COMPILERS = [
  { name: "5.9", command: [process.execPath, join(repoRoot, "node_modules", "typescript", "bin", "tsc")] },
  { name: "7", command: ["sh", join(repoRoot, "scripts", "tsc7.sh")] },
];

/**
 * Steps a lexicon's scaffold README says to run before the project compiles.
 * cedar's policies import classes `chant cedar generate` writes from the
 * project's schema (lexicons/cedar/src/init-templates.ts).
 */
const SETUP: Record<string, string[][]> = { cedar: [["cedar", "generate"]] };

interface Project {
  /** Repo-relative example path, or `init --lexicon <x>`. */
  readonly label: string;
  readonly dir: string;
  readonly tsconfig: string;
}

function exampleProjects(): Project[] {
  // examples/*/ and lexicons/*/examples/*/, each with its own tsconfig.json.
  const parents = [join(repoRoot, "examples"), ...readdirSync(join(repoRoot, "lexicons")).map((l) => join(repoRoot, "lexicons", l, "examples"))];
  const dirs = parents.filter((p) => existsSync(p)).flatMap((p) => readdirSync(p).map((name) => join(p, name)));
  return dirs
    .filter((dir) => existsSync(join(dir, "tsconfig.json")))
    .sort()
    .map((dir) => ({ label: relative(repoRoot, dir), dir, tsconfig: join(dir, "tsconfig.json") }));
}

function readTsconfig(path: string): { raw: { compilerOptions: Record<string, unknown> }; files: string[] } {
  const read = ts.readConfigFile(path, ts.sys.readFile);
  if (read.error) throw new Error(`${path}: ${ts.flattenDiagnosticMessageText(read.error.messageText, "\n")}`);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(path));
  return { raw: read.config, files: parsed.fileNames };
}

let scratch: string;
const scaffolds: Project[] = [];

beforeAll(async () => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "chant-3089-")));
  symlinkSync(join(repoRoot, "node_modules"), join(scratch, "node_modules"), "dir");
  for (const lexicon of readdirSync(join(repoRoot, "lexicons")).sort()) {
    if (!existsSync(join(repoRoot, "lexicons", lexicon, "package.json"))) continue;
    const dir = join(scratch, lexicon);
    mkdirSync(dir);
    const result = await initCommand({ path: dir, lexicon, skipMcp: true, skipInstall: true });
    expect(result.success, `init --lexicon ${lexicon}: ${result.error}`).toBe(true);
    // A lexicon without init templates scaffolds an empty src/, which is
    // nothing for tsc to check.
    if (!result.createdFiles.some((f) => f.startsWith("src/"))) continue;
    for (const args of SETUP[lexicon] ?? []) {
      const cli = [join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"), join(repoRoot, "packages", "core", "src", "cli", "main.ts")];
      await run(process.execPath, [...cli, ...args], { cwd: dir });
    }
    scaffolds.push({ label: `init --lexicon ${lexicon}`, dir, tsconfig: join(dir, "tsconfig.json") });
  }
}, 120_000);

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe("example and scaffold tsconfigs (#3089)", () => {
  test("every lexicon with init templates scaffolds a project", () => {
    expect(scaffolds.length).toBeGreaterThan(10);
  });

  test("every example uses the module settings chant init writes", () => {
    const scaffold = readTsconfig(scaffolds[0].tsconfig).raw.compilerOptions;
    const pick = (o: Record<string, unknown>) => ({ module: o.module, moduleResolution: o.moduleResolution, types: o.types });
    const expected = pick(scaffold);
    expect(expected).toEqual({ module: "esnext", moduleResolution: "bundler", types: ["node"] });
    const examples = exampleProjects();
    expect(examples.length).toBeGreaterThan(100);
    const drifted = examples
      .map((p) => ({ label: p.label, got: pick(readTsconfig(p.tsconfig).raw.compilerOptions) }))
      .filter((e) => JSON.stringify(e.got) !== JSON.stringify(expected));
    expect(drifted).toEqual([]);
  });

  for (const compiler of COMPILERS) {
    test(`tsc ${compiler.name} --noEmit passes over every example and scaffold`, async () => {
      // Group projects whose options agree, apart from the per-directory ones.
      const groups = new Map<string, { options: Record<string, unknown>; files: string[]; projects: Project[] }>();
      for (const project of [...exampleProjects(), ...scaffolds]) {
        const { raw, files } = readTsconfig(project.tsconfig);
        const { rootDir: _rootDir, outDir: _outDir, ...options } = raw.compilerOptions;
        const key = JSON.stringify(options);
        const group = groups.get(key) ?? { options, files: [], projects: [] };
        group.files.push(...files);
        group.projects.push(project);
        groups.set(key, group);
      }

      const failures = await Promise.all(
        [...groups.values()].map(async (group, i) => {
          const config = join(scratch, `group-${compiler.name}-${i}.json`);
          // The generated tsconfig sits outside the repo, so name the repo's
          // @types directory: `types: ["node"]` resolves through it.
          const compilerOptions = { ...group.options, noEmit: true, typeRoots: [join(repoRoot, "node_modules", "@types")] };
          writeFileSync(config, JSON.stringify({ compilerOptions, files: group.files }, null, 2));
          try {
            await run(compiler.command[0], [...compiler.command.slice(1), "-p", config, "--pretty", "false"], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 });
            return [];
          } catch (error) {
            const e = error as { stdout?: string; stderr?: string; message: string };
            const out = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() || e.message;
            return out.split("\n").map((line) => attribute(line, group.projects));
          }
        }),
      );
      expect(failures.flat()).toEqual([]);
    }, 300_000);
  }
});

/** Prefix a tsc error line with the project its file belongs to. */
function attribute(line: string, projects: Project[]): string {
  const match = /^(.+?)\(\d+,\d+\): /.exec(line);
  if (!match) return line;
  const file = resolve(repoRoot, match[1]);
  const owner = projects.find((p) => file.startsWith(p.dir + sep));
  return owner ? `[${owner.label}] ${relative(owner.dir, file)}${line.slice(match[1].length)}` : line;
}
