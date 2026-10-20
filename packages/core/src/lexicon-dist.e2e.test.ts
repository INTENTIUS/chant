/**
 * #3981 — lexicons loaded from compiled JS, with plain node.
 *
 * Lexicon packages publish compiled `dist/*.js` as each export's `default`.
 * This compiles core and a set of real lexicons (aws and helm, which find
 * their lint rules by directory scan, and the lexicons they import) with tsc
 * into a scratch `node_modules`, with each lexicon's own package.json. A
 * plain node process with no
 * loader then loads each plugin through the compiled core, and must find the
 * same lint rules, post-synth checks, skills and generated data as the same
 * plugins loaded from source, without loading tsx or any TypeScript module.
 * A `chant build` and `chant lint` of a project against the compiled aws
 * lexicon must work and load none of the lexicon's TypeScript.
 *
 * End to end because it runs tsc and spawns node.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const coreRoot = resolve(import.meta.dirname, "..");
const repo = resolve(coreRoot, "..", "..");
const repoModules = join(repo, "node_modules");

/** Compiled and counted. aws and helm discover their lint rules from a directory; the rest are what they import. */
const LEXICONS = ["aws", "helm", "k8s", "grafana", "otel", "prometheus"];

let scratch: string;
let modules: string;
let coreDist: string;
let project: string;

/**
 * Loads each named plugin through core and prints what it found. argv[2] is a
 * JSON object: `core` (the URL of core's ts-loader and cli/plugins modules,
 * without extension), `ext` (`.js` or `.ts`), `names`, and `taggable` (the
 * URL of the aws lexicon's taggable module).
 */
const COUNT = `
import { registerHooks } from "node:module";
const seen = { tsx: 0, typeScript: [] };
registerHooks({
  load(url, context, next) {
    const path = url.replace(/[?#].*$/, "");
    if (path.includes("/node_modules/tsx/")) seen.tsx++;
    else if (/\\.[cm]?tsx?$/.test(path)) seen.typeScript.push(path);
    return next(url, context);
  },
});
const args = JSON.parse(process.argv[2]);
const { installCompiledCli } = await import(args.core + "/ts-loader" + args.ext);
installCompiledCli();
const { loadPlugin } = await import(args.core + "/cli/plugins" + args.ext);
const plugins = {};
for (const name of args.names) {
  const plugin = await loadPlugin(name);
  const catalogs = {};
  for (const resource of plugin.mcpResources?.() ?? []) {
    if (!resource.uri.endsWith(":resource-catalog")) continue;
    try { catalogs[resource.uri] = JSON.parse(await resource.handler()).length ?? 0; } catch (err) { catalogs[resource.uri] = String(err); }
  }
  plugins[name] = {
    catalogs,
    lintRules: (plugin.lintRules?.() ?? []).map((r) => r.id).sort(),
    postSynthChecks: (plugin.postSynthChecks?.() ?? []).map((c) => c.id).sort(),
    skills: (plugin.skills?.() ?? []).filter((s) => s.content.length > 0).map((s) => s.name).sort(),
  };
}
const { loadTaggableResources } = await import(args.taggable);
const compiled = globalThis[Symbol.for("chant.compiledCli")];
process.stdout.write(JSON.stringify({
  plugins,
  taggable: loadTaggableResources().size,
  tsxRegistered: compiled ? compiled.tsx : null,
  seen,
}));
`;

interface Counted {
  plugins: Record<string, { catalogs: Record<string, number | string>; lintRules: string[]; postSynthChecks: string[]; skills: string[] }>;
  taggable: number;
  tsxRegistered: boolean | null;
  seen: { tsx: number; typeScript: string[] };
}

function tsc(project: string, outDir: string): void {
  execFileSync(join(repo, "scripts", "tsc7.sh"), ["-p", project, "--outDir", outDir, "--sourceMap", "false", "--declaration", "false", "--declarationMap", "false"], {
    cwd: repo,
    stdio: ["ignore", "pipe", "pipe"],
  });
  execFileSync(process.execPath, [join(repoModules, "tsc-alias", "dist", "bin", "index.js"), "-p", project, "--outDir", outDir], {
    cwd: repo,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function count(script: string, args: object, nodeArgs: string[] = []): Counted {
  const r = spawnSync(process.execPath, [...nodeArgs, script, JSON.stringify(args)], { cwd: scratch, encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`count script failed (${r.status}):\n${r.stderr}`);
  return JSON.parse(r.stdout) as Counted;
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "chant-lexicon-dist-"));
  modules = join(scratch, "node_modules");
  mkdirSync(join(modules, "@intentius"), { recursive: true });
  for (const name of readdirSync(repoModules)) {
    if (name === "@intentius" || name === ".bin") continue;
    symlinkSync(join(repoModules, name), join(modules, name));
  }

  // Core as an install has it: its source (the package exports name it, and
  // the compiled CLI redirects each import of it to dist), and dist.
  const core = join(modules, "@intentius", "chant");
  mkdirSync(core);
  cpSync(join(coreRoot, "package.json"), join(core, "package.json"));
  cpSync(join(coreRoot, "src"), join(core, "src"), { recursive: true, filter: (p) => !/\.test\.ts$/.test(p) });
  coreDist = join(core, "dist");
  tsc(join(coreRoot, "tsconfig.build.json"), coreDist);
  mkdirSync(join(core, "scripts"));
  cpSync(join(coreRoot, "scripts", "copy-assets.mjs"), join(core, "scripts", "copy-assets.mjs"));
  execFileSync(process.execPath, [join(core, "scripts", "copy-assets.mjs")], { stdio: "ignore" });

  for (const name of LEXICONS) {
    const root = join(repo, "lexicons", name);
    const pkg = join(modules, "@intentius", `chant-lexicon-${name}`);
    mkdirSync(pkg);
    cpSync(join(root, "package.json"), join(pkg, "package.json"));
    // src/ is published beside dist/, and holds what a module reads beside itself.
    symlinkSync(join(root, "src"), join(pkg, "src"));
    if (existsSync(join(root, "node_modules"))) symlinkSync(join(root, "node_modules"), join(pkg, "node_modules"));
    // The bundle's dist/ (meta.json, manifest.json), then the compiled modules.
    if (existsSync(join(root, "dist"))) cpSync(join(root, "dist"), join(pkg, "dist"), { recursive: true });
    tsc(join(root, "tsconfig.build.json"), join(pkg, "dist"));
  }

  writeFileSync(join(scratch, "count.mjs"), COUNT);

  project = join(scratch, "project");
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "lexicon-dist-e2e", private: true, type: "module" }));
  writeFileSync(join(project, "chant.config.ts"), `export default { lexicons: ["aws"] };\n`);
  writeFileSync(
    join(project, "src", "infra.ts"),
    `import { Queue } from "@intentius/chant-lexicon-aws";\n` +
      `export const taskQueue = new Queue({ QueueName: "lexicon-dist-e2e", Tags: [{ Key: "suite", Value: "lexicon-dist" }], SqsManagedSseEnabled: true });\n`,
  );
}, 600_000);

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe("lexicons loaded from compiled JS (#3981)", () => {
  let fromSource: Counted;
  let fromDist: Counted;

  beforeAll(() => {
    const tsxLoader = pathToFileURL(join(repoModules, "tsx", "dist", "loader.mjs")).href;
    fromSource = count(
      join(scratch, "count.mjs"),
      {
        core: pathToFileURL(join(coreRoot, "src")).href,
        ext: ".ts",
        names: LEXICONS,
        taggable: pathToFileURL(join(repo, "lexicons", "aws", "src", "taggable.ts")).href,
      },
      // The repository's lexicons through their `development` export, src/*.ts, as bin/chant runs from source.
      ["--conditions=development", "--import", tsxLoader],
    );
    fromDist = count(join(scratch, "count.mjs"), {
      core: pathToFileURL(coreDist).href,
      ext: ".js",
      names: LEXICONS,
      taggable: "@intentius/chant-lexicon-aws/taggable",
    });
  }, 300_000);

  test("plain node loads every plugin with no tsx and no TypeScript module", () => {
    expect(fromDist.tsxRegistered).toBe(false);
    expect(fromDist.seen.tsx).toBe(0);
    expect(fromDist.seen.typeScript).toEqual([]);
    // The comparison run really loads the lexicons' source.
    expect(fromSource.seen.typeScript.some((path) => path.includes("/lexicons/aws/src/"))).toBe(true);
  });

  test("the compiled plugins find the same lint rules as the source", () => {
    for (const name of LEXICONS) {
      expect(fromDist.plugins[name]!.lintRules, name).toEqual(fromSource.plugins[name]!.lintRules);
    }
    // The two that scan a directory for their rules found some.
    expect(fromDist.plugins.aws!.lintRules.length).toBeGreaterThan(0);
    expect(fromDist.plugins.helm!.lintRules.length).toBeGreaterThan(0);
  });

  test("the compiled plugins find the same post-synth checks as the source", () => {
    for (const name of LEXICONS) {
      expect(fromDist.plugins[name]!.postSynthChecks, name).toEqual(fromSource.plugins[name]!.postSynthChecks);
    }
    expect(fromDist.plugins.aws!.postSynthChecks.length).toBeGreaterThan(0);
  });

  test("the compiled plugins read their skills from src/", () => {
    for (const name of LEXICONS) {
      expect(fromDist.plugins[name]!.skills, name).toEqual(fromSource.plugins[name]!.skills);
    }
    expect(fromDist.plugins.aws!.skills.length).toBeGreaterThan(0);
  });

  test("a compiled module reads the generated JSON under src/", () => {
    expect(fromSource.taggable).toBeGreaterThan(0);
    expect(fromDist.taggable).toBe(fromSource.taggable);
    for (const name of LEXICONS) {
      expect(fromDist.plugins[name]!.catalogs, name).toEqual(fromSource.plugins[name]!.catalogs);
      for (const size of Object.values(fromDist.plugins[name]!.catalogs)) expect(typeof size, `${name}: ${size}`).toBe("number");
    }
    expect(fromDist.plugins.aws!.catalogs["aws:resource-catalog"]).toBeGreaterThan(0);
  });

  test("build and lint run against the compiled aws lexicon and load none of its TypeScript", () => {
    const tracer = join(scratch, "trace.mjs");
    writeFileSync(
      tracer,
      `import { registerHooks } from "node:module";\nimport { appendFileSync } from "node:fs";\n` +
        `const seen = [];\n` +
        `registerHooks({ load(url, context, next) { if (/\\/(lexicons|chant-lexicon-[a-z0-9]+)\\/src\\/.*\\.ts$/.test(url)) seen.push(url); return next(url, context); } });\n` +
        `process.on("exit", () => appendFileSync(process.env.TRACE_OUT, JSON.stringify(seen) + "\\n"));\n`,
    );
    const main = join(coreDist, "cli", "main.js");
    const run = (args: string[]) => {
      const out = join(scratch, `trace-${args[0]}.jsonl`);
      const env: NodeJS.ProcessEnv = { ...process.env, TRACE_OUT: out };
      delete env.CHANT_ENV;
      const r = spawnSync(process.execPath, ["--import", pathToFileURL(tracer).href, main, ...args], { cwd: project, encoding: "utf-8", env });
      return { ...r, lexiconTypeScript: JSON.parse(readFileSync(out, "utf-8").trim().split("\n")[0]!) as string[] };
    };

    const built = run(["build", "src", "-o", "out/template.json"]);
    expect(built.status, built.stderr).toBe(0);
    const template = JSON.parse(readFileSync(join(project, "out", "template.json"), "utf-8")) as {
      Resources: Record<string, { Type: string; Properties: { QueueName?: string } }>;
    };
    expect(Object.values(template.Resources).map((r) => [r.Type, r.Properties.QueueName])).toEqual([["AWS::SQS::Queue", "lexicon-dist-e2e"]]);
    expect(built.lexiconTypeScript).toEqual([]);

    const linted = run(["lint", "src"]);
    expect(linted.status, linted.stdout + linted.stderr).toBe(0);
    expect(linted.lexiconTypeScript).toEqual([]);
  });
});
