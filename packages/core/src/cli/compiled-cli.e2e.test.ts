/**
 * The installed CLI runs compiled JS with plain node (#3878). This packs core
 * (its prepack builds dist/) and the render lexicon the way a release does,
 * installs both into a scratch project with npm, and runs the package's own
 * `bin/chant`.
 *
 * Each run is traced through a load hook that NODE_OPTIONS hands to the CLI's
 * node, so the test can say what loaded: none of chant's TypeScript source,
 * ever, and tsx only for a command that imports TypeScript (here the
 * lexicon and the project source). tsx's ESM hooks run on a thread of their
 * own, about 200 MB of the process (#3276), so a workspace read must not
 * register it either.
 *
 * End to end because it packs, installs from the registry and spawns the CLI.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const coreRoot = resolve(import.meta.dirname, "..", "..");
const renderRoot = resolve(coreRoot, "..", "..", "lexicons", "render");
const referenceDecisions = resolve(coreRoot, "..", "..", "reference-workspace", "decisions");
const version = (JSON.parse(readFileSync(join(coreRoot, "package.json"), "utf-8")) as { version: string }).version;

let scratch: string;
let project: string;
let cjsProject: string;
let waves: string;
let workspace: string;
let chant: string;
let tracer: string;

const TRACER = `
import { registerHooks } from "node:module";
import { appendFileSync } from "node:fs";
const out = process.env.CHANT_TRACE_OUT;
const seen = { chantSrc: 0, chantDist: 0, tsx: 0 };
registerHooks({
  load(url, context, next) {
    if (url.includes("/@intentius/chant/src/")) seen.chantSrc++;
    else if (url.includes("/@intentius/chant/dist/")) seen.chantDist++;
    else if (url.includes("/node_modules/tsx/")) seen.tsx++;
    return next(url, context);
  },
});
process.on("exit", () => { if (out) appendFileSync(out, JSON.stringify(seen) + "\\n"); });
`;

function pack(dir: string, ignoreScripts = false): string {
  const args = ["pack", "--json", "--pack-destination", scratch, ...(ignoreScripts ? ["--ignore-scripts"] : [])];
  const packed = JSON.parse(execFileSync("npm", args, { cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] })) as { filename: string }[];
  return join(scratch, packed[0].filename);
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  loaded: { chantSrc: number; chantDist: number; tsx: number };
}

function run(cwd: string, args: string[]): Run {
  const traceOut = join(scratch, `trace-${Math.random().toString(36).slice(2)}.jsonl`);
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: `--import ${tracer}`, CHANT_TRACE_OUT: traceOut };
  delete env.CHANT_ENV;
  const result = spawnSync(chant, args, { cwd, env, encoding: "utf-8" });
  const lines = readFileSync(traceOut, "utf-8").trim().split("\n");
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, loaded: JSON.parse(lines[0]!) as Run["loaded"] };
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "chant-compiled-cli-"));
  tracer = join(scratch, "trace.mjs");
  writeFileSync(tracer, TRACER);
  const core = pack(coreRoot);
  // The lexicon's prepack regenerates it from upstream specs; the checkout's
  // generated source and dist are what this test needs, so pack them as they are.
  const render = pack(renderRoot, true);

  project = join(scratch, "project");
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "compiled-cli-e2e", private: true, type: "module" }));
  execFileSync("npm", ["install", "--no-audit", "--no-fund", "--prefer-offline", core, render], { cwd: project, stdio: "ignore" });
  writeFileSync(join(project, "chant.config.ts"), `import type { ChantConfig } from "@intentius/chant";\nexport default { lexicons: ["render"] } satisfies ChantConfig;\n`);
  writeFileSync(
    join(project, "src", "infra.ts"),
    `import { Postgres, Render } from "@intentius/chant-lexicon-render";\n` +
      `export const db = new Postgres({ name: "e2e-db", plan: "free", version: "16", region: Render.Region });\n`,
  );
  chant = join(project, "node_modules", ".bin", "chant");

  // The same project with no package.json at all, so nothing above the config
  // says "type": "module" and tsx compiles chant.config.ts as CommonJS (#3897).
  cjsProject = join(scratch, "cjs-project");
  mkdirSync(join(cjsProject, "src"), { recursive: true });
  symlinkSync(join(project, "node_modules"), join(cjsProject, "node_modules"), "dir");
  writeFileSync(join(cjsProject, "chant.config.ts"), readFileSync(join(project, "chant.config.ts"), "utf-8"));
  // The source reaches the lexicon through a module outside src/, so the
  // fallback scan of src/ imports finds no lexicon: only the config names it.
  mkdirSync(join(cjsProject, "lib"));
  writeFileSync(join(cjsProject, "lib", "render.ts"), `export * from "@intentius/chant-lexicon-render";\n`);
  writeFileSync(
    join(cjsProject, "src", "infra.ts"),
    `import { Postgres, Render } from "../lib/render";\n` +
      `export const db = new Postgres({ name: "e2e-db", plan: "free", version: "16", region: Render.Region });\n`,
  );

  // A waves spec whose plan writes a fixed digest and whose apply does nothing,
  // in a repository with the history `run wave` reads its gate policy from.
  waves = join(scratch, "waves");
  mkdirSync(waves);
  writeFileSync(join(waves, "plan.mjs"), `import { writeFileSync } from "node:fs";\nwriteFileSync(process.argv[3], JSON.stringify({ planDigest: "sha256:" + "a".repeat(64) }));\n`);
  writeFileSync(
    join(waves, "waves.json"),
    JSON.stringify({
      name: "smoke",
      op: "smoke",
      plan: ["node", "plan.mjs", "{target}", "{plan}"],
      apply: ["node", "-e", "0", "{target}", "{plan}"],
      waves: [{ name: "dev", runs: [{ target: "dev" }], gate: "never" }],
    }),
  );
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=e2e@chant", "-c", "user.name=e2e", ...args], { cwd: waves, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-qm", "spec");
  writeFileSync(join(waves, ".gitignore"), ".chant/\n");
  git("add", "-A");
  git("commit", "-qm", "ignore");

  // A workspace whose declaration names a .mjs record kind, with a member
  // that has a chant.config.ts, for the workspace reads below (#3276).
  workspace = join(scratch, "workspace");
  mkdirSync(join(workspace, "decisions"), { recursive: true });
  mkdirSync(join(workspace, "app"));
  for (const file of ["decision.kind.mjs", "decision.schema.json", "ref-001-how-the-app-is-deployed.md"]) {
    writeFileSync(join(workspace, "decisions", file), readFileSync(join(referenceDecisions, file)));
  }
  writeFileSync(
    join(workspace, "chant.workspace.json"),
    JSON.stringify({
      name: "e2e",
      schema: 1,
      members: [{ name: "app", dir: "app", kind: "chant" }],
      records: [{ kind: "decisions/decision.kind.mjs" }],
    }),
  );
  writeFileSync(join(workspace, "app", "chant.config.ts"), `export default { lexicons: [] as string[] };\n`);
  symlinkSync(join(project, "node_modules"), join(workspace, "node_modules"), "dir");
  const wsGit = (...args: string[]) => execFileSync("git", ["-c", "user.email=e2e@chant", "-c", "user.name=e2e", ...args], { cwd: workspace, stdio: "ignore" });
  wsGit("init", "-q", "-b", "main");
  writeFileSync(join(workspace, ".gitignore"), "node_modules\n");
  wsGit("add", "-A");
  wsGit("commit", "-qm", "workspace");
}, 600_000);

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe("the installed chant CLI (#3878)", () => {
  test("--version runs compiled JS and loads no TypeScript loader", () => {
    const r = run(project, ["--version"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(version);
    expect(r.loaded.chantDist).toBeGreaterThan(0);
    expect(r.loaded).toMatchObject({ chantSrc: 0, tsx: 0 });
  });

  test("run wave plans and applies a wave without loading tsx", () => {
    const r = run(waves, ["run", "wave", "--spec", "waves.json", "--wave", "1", "--json"]);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ exitCode: 0 });
    expect(r.loaded).toMatchObject({ chantSrc: 0, tsx: 0 });
  });

  test("workspace ls reads a .mjs record kind from a member with a chant.config.ts without loading tsx", () => {
    const r = run(join(workspace, "app"), ["workspace", "ls", "--json"]);
    expect(r.status, r.stderr).toBe(0);
    const ls = JSON.parse(r.stdout) as { workspace: { records: Array<{ name: string; kind: string | null }> } };
    expect(ls.workspace.records.map((k) => k.kind)).toEqual(["decision"]);
    expect(r.loaded).toMatchObject({ chantSrc: 0, tsx: 0 });
  });

  test("workspace records reads the declared .mjs kind's records without loading tsx", () => {
    const r = run(join(workspace, "app"), ["workspace", "records", "--json"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("ref-001");
    expect(r.loaded).toMatchObject({ chantSrc: 0, tsx: 0 });
  });

  test("build loads the TypeScript lexicon and project through tsx, against the one compiled core", () => {
    const r = run(project, ["build", "src", "-o", "out/render.json"]);
    expect(r.status, r.stderr).toBe(0);
    const built = JSON.parse(readFileSync(join(project, "out", "render.json"), "utf-8")) as Record<string, { body?: { name?: string } }>;
    expect(built.db?.body?.name).toBe("e2e-db");
    expect(r.loaded.tsx).toBeGreaterThan(0);
    expect(r.loaded.chantSrc).toBe(0);
  });

  test("lint passes on the project", () => {
    const r = run(project, ["lint", "src"]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.loaded.chantSrc).toBe(0);
  });

  test("build --sandbox bundles chant's source for the sandboxed child", () => {
    writeFileSync(
      join(project, "src", "made.ts"),
      `import { Postgres, Render } from "@intentius/chant-lexicon-render";\n` +
        `function make(name: string) { const n = [1, 2].map((i) => i * 2).length; return new Postgres({ name: name + n, plan: "free", version: "16", region: Render.Region }); }\n` +
        `export const made = make("made");\n`,
    );
    try {
      const r = run(project, ["build", "src", "--sandbox", "-o", "out/sandbox.json"]);
      expect(r.status, r.stderr).toBe(0);
      const built = JSON.parse(readFileSync(join(project, "out", "sandbox.json"), "utf-8")) as Record<string, { body?: { name?: string } }>;
      expect(built.made?.body?.name).toBe("made2");
    } finally {
      rmSync(join(project, "src", "made.ts"));
    }
  });

  describe("a chant.config.ts tsx compiles as CommonJS (#3897)", () => {
    test("build reads the config's lexicons", () => {
      const r = run(cjsProject, ["build", "src", "-o", "out/render.json"]);
      expect(r.status, r.stderr).toBe(0);
      const built = JSON.parse(readFileSync(join(cjsProject, "out", "render.json"), "utf-8")) as Record<string, { body?: { name?: string } }>;
      expect(built.db?.body?.name).toBe("e2e-db");
    });

    test("build --sandbox reads the config's lexicons in the child", () => {
      const r = run(cjsProject, ["build", "src", "--sandbox", "-o", "out/sandbox.json"]);
      expect(r.status, r.stderr).toBe(0);
      const built = JSON.parse(readFileSync(join(cjsProject, "out", "sandbox.json"), "utf-8")) as Record<string, { body?: { name?: string } }>;
      expect(built.db?.body?.name).toBe("e2e-db");
    });

    test("graph --format ir finds the lexicon's entities", () => {
      const r = run(cjsProject, ["graph", "src", "--format", "ir"]);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).not.toMatch(/could not load the project's lexicons/);
      const ir = JSON.parse(r.stdout) as { nodes: Array<Record<string, unknown>> };
      expect(ir.nodes.length).toBeGreaterThan(0);
    });
  });
});
