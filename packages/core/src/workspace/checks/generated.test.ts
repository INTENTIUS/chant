import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { readDeclaration } from "../declaration";
import { workingTree } from "../tree";
import {
  checkGenerated,
  gatherGeneratedFacts,
  regenerate,
  splitCommandLine,
  spawnGenerator,
  WSP_GENERATED_DRIFT,
  WSP_GENERATED_HAND_WRITTEN,
  WSP_GENERATED_MISSING,
  WSP_GENERATED_NOT_COMPARED,
  WSP_GENERATED_SOURCE_MISSING,
  WSP_GENERATOR_FAILED,
  type GatherOptions,
  type RenderSkills,
} from "./generated";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

function workspace(files: Record<string, string>, opts: { git?: boolean } = {}): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-generated-")));
  scratch.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  if (opts.git) {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  }
  return root;
}

async function findings(root: string, options: GatherOptions = {}) {
  const declaration = readDeclaration(workingTree(root));
  return checkGenerated(await gatherGeneratedFacts(root, declaration, options));
}

/** A generator that writes `text` to its `-o` path, or in place to `file` without one. */
const WRITER = `
const i = process.argv.indexOf("-o");
const out = i >= 0 ? process.argv[i + 1] : process.argv[2];
require("node:fs").writeFileSync(out, process.argv[process.argv.length - 1] === "--stale" ? "old\\n" : "fresh\\n");
`;

const noSkills: RenderSkills = async () => ({ status: "rendered", files: new Map() });

/**
 * The fixture: member `app` has a drifted file, a current one, a hand-written
 * one and a missing one; member `svc` is a chant project with a lexicon skill.
 */
function fixture(): string {
  return workspace(
    {
      "chant.workspace.json": JSON.stringify({
        name: "acme",
        schema: 1,
        members: [
          {
            name: "app",
            dir: "app",
            kind: "other",
            because: "a generator fixture",
            generated: [
              { path: "out/drifted.txt", generator: "node ../gen.cjs -o out/drifted.txt", sources: ["gen.cjs"] },
              { path: "out/current.txt", generator: "node ../gen.cjs -o out/current.txt" },
              { path: "out/by-hand.txt", generator: "node ../gen.cjs -o out/by-hand.txt", handWritten: { because: "the generator can't express the footer yet" } },
              { path: "out/missing.txt", generator: "node ../gen.cjs -o out/missing.txt", sources: ["no-such-source.ts"] },
            ],
          },
          { name: "svc", dir: "svc", kind: "chant" },
        ],
      }),
      "gen.cjs": WRITER,
      "app/out/drifted.txt": "edited by hand\n",
      "app/out/current.txt": "fresh\n",
      "app/out/by-hand.txt": "kept by hand\n",
      "svc/chant.config.json": JSON.stringify({ lexicons: ["aws"] }),
      "svc/skills/chant-aws/SKILL.md": "an old skill\n",
      "svc/skills/chant-aws-deploy/SKILL.md": "the current skill\n",
    },
    { git: true },
  );
}

const skills: RenderSkills = async () => ({
  status: "rendered",
  files: new Map([
    ["skills/chant-aws/SKILL.md", "the new skill\n"],
    ["skills/chant-aws-deploy/SKILL.md", "the current skill\n"],
    ["skills/chant-aws-never-written/SKILL.md", "not in the tree\n"],
  ]),
});

describe("generated-file checks (#2541)", () => {
  test("by default: missing files and sources fail, hand-written is info, and generators are not run", async () => {
    const root = fixture();
    const f = await findings(root, { renderSkills: skills });
    const summary = f.map((x) => [x.id, x.severity, x.path]);
    expect(summary).toEqual([
      [WSP_GENERATED_NOT_COMPARED, "info", "app/out/drifted.txt"],
      [WSP_GENERATED_NOT_COMPARED, "info", "app/out/current.txt"],
      [WSP_GENERATED_HAND_WRITTEN, "info", "app/out/by-hand.txt"],
      [WSP_GENERATED_SOURCE_MISSING, "error", "app/out/missing.txt"],
      [WSP_GENERATED_MISSING, "error", "app/out/missing.txt"],
      [WSP_GENERATED_DRIFT, "error", "svc/skills/chant-aws/SKILL.md"],
    ]);
    expect(f.find((x) => x.id === WSP_GENERATED_HAND_WRITTEN)!.message).toContain("the generator can't express the footer yet");
    expect(f.find((x) => x.id === WSP_GENERATED_MISSING)!.message).toContain("run `node ../gen.cjs -o out/missing.txt` in app");
    expect(f.find((x) => x.id === WSP_GENERATED_DRIFT)!.message).toContain("run `chant update` in svc");
    expect(f.find((x) => x.id === WSP_GENERATED_DRIFT)!.pointer).toBe("/members/1");
    expect(f.find((x) => x.id === WSP_GENERATED_MISSING)!.pointer).toBe("/members/0/generated/3");
  });

  test("with generators run, a file that differs from its generator's output fails and a current one passes", async () => {
    const root = fixture();
    const f = await findings(root, { runGenerators: true, renderSkills: noSkills });
    const drift = f.filter((x) => x.id === WSP_GENERATED_DRIFT);
    expect(drift.map((x) => x.path)).toEqual(["app/out/drifted.txt"]);
    expect(drift[0].message).toContain("differs from what `node ../gen.cjs -o out/drifted.txt` writes");
    expect(f.some((x) => x.path === "app/out/current.txt")).toBe(false);
    // The -o flag pointed at a temporary file: the tree is untouched.
    expect(readFileSync(join(root, "app/out/drifted.txt"), "utf-8")).toBe("edited by hand\n");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf-8" })).toBe("");
  });

  test("a hand-written SKILL.md listed in the member's entries is reported with its reason, not as drift", async () => {
    const root = fixture();
    const decl = JSON.parse(readFileSync(join(root, "chant.workspace.json"), "utf-8"));
    decl.members[1].generated = [{ path: "skills/chant-aws/SKILL.md", generator: "chant update", handWritten: { because: "we trimmed the skill for this repo" } }];
    writeFileSync(join(root, "chant.workspace.json"), JSON.stringify(decl));
    const f = (await findings(root, { renderSkills: skills })).filter((x) => x.member === "svc");
    expect(f.map((x) => [x.id, x.path])).toEqual([[WSP_GENERATED_HAND_WRITTEN, "svc/skills/chant-aws/SKILL.md"]]);
    expect(f[0].message).toContain("we trimmed the skill for this repo");
  });

  test("skills that can't be rendered without running the config are reported as not compared", async () => {
    const root = workspace({
      "chant.workspace.json": JSON.stringify({ name: "acme", schema: 1, members: [{ name: "svc", dir: "svc", kind: "chant" }] }),
      "svc/chant.config.ts": `import { lexicons } from "./elsewhere";\nexport default { lexicons };\n`,
    });
    const f = await findings(root);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ id: WSP_GENERATED_NOT_COMPARED, severity: "info", path: "svc/skills/*/SKILL.md" });
    expect(f[0].message).toContain("can't be read without running it");
  });

  test("a member with no config lexicons has no implicit skills to compare", async () => {
    const root = workspace({
      "chant.workspace.json": JSON.stringify({ name: "acme", schema: 1, members: [{ name: "svc", dir: "svc", kind: "chant" }] }),
      "svc/chant.config.json": JSON.stringify({}),
    });
    expect(await findings(root)).toEqual([]);
  });

  test("a generator that fails is WSP103 with the end of its output", async () => {
    const root = workspace({
      "chant.workspace.json": JSON.stringify({
        name: "acme",
        schema: 1,
        members: [{ name: "app", dir: "app", kind: "other", because: "x", generated: [{ path: "a.txt", generator: "node -e \"console.error('boom'); process.exit(3)\" -- -o a.txt" }] }],
      }),
      "app/a.txt": "x\n",
    });
    const f = await findings(root, { runGenerators: true });
    expect(f).toHaveLength(1);
    expect(f[0].id).toBe(WSP_GENERATOR_FAILED);
    expect(f[0].message).toContain("exited with 3");
    expect(f[0].message).toContain("boom");
  });

  test("a generator with shell syntax is refused, not run", async () => {
    const root = workspace({
      "chant.workspace.json": JSON.stringify({
        name: "acme",
        schema: 1,
        members: [{ name: "app", dir: "app", kind: "other", because: "x", generated: [{ path: "a.txt", generator: "node gen.cjs > a.txt" }] }],
      }),
      "app/a.txt": "x\n",
    });
    let ran = false;
    const f = await findings(root, { runGenerators: true, runGenerator: () => ((ran = true), { ok: true }) });
    expect(ran).toBe(false);
    expect(f[0].id).toBe(WSP_GENERATOR_FAILED);
    expect(f[0].message).toContain("not a single command");
  });
});

describe("in-place generators", () => {
  test("run in the git tree, and the tree is put back afterwards, including other files they touch", async () => {
    const inPlace = `
const fs = require("node:fs");
fs.writeFileSync("out.txt", "fresh\\n");
fs.writeFileSync("../other/touched.txt", "rewritten\\n");
fs.writeFileSync("new-file.txt", "created\\n");
`;
    const root = workspace(
      {
        "chant.workspace.json": JSON.stringify({
          name: "acme",
          schema: 1,
          members: [{ name: "app", dir: "app", kind: "other", because: "x", generated: [{ path: "out.txt", generator: "node ../gen.cjs" }] }],
        }),
        "gen.cjs": inPlace,
        "app/out.txt": "stale\n",
        "other/touched.txt": "original\n",
        "other/dirty.txt": "committed\n",
      },
      { git: true },
    );
    // A change the user has not committed survives the run.
    writeFileSync(join(root, "other/dirty.txt"), "uncommitted\n");
    const f = await findings(root, { runGenerators: true });
    expect(f.map((x) => [x.id, x.path])).toEqual([[WSP_GENERATED_DRIFT, "app/out.txt"]]);
    expect(readFileSync(join(root, "app/out.txt"), "utf-8")).toBe("stale\n");
    expect(readFileSync(join(root, "other/touched.txt"), "utf-8")).toBe("original\n");
    expect(readFileSync(join(root, "other/dirty.txt"), "utf-8")).toBe("uncommitted\n");
    expect(existsSync(join(root, "app/new-file.txt"))).toBe(false);
  });

  test("outside a git checkout an in-place generator is not run", () => {
    const root = workspace({ "app/out.txt": "x" });
    let ran = false;
    const out = regenerate(root, join(root, "app"), join(root, "app/out.txt"), "node gen.cjs", () => ((ran = true), { ok: true }));
    expect(ran).toBe(false);
    expect(out).toMatchObject({ status: "failed" });
  });

  test("--output=<path> is redirected as well as -o <path>", () => {
    const root = workspace({ "app/out.txt": "x" });
    const seen: string[][] = [];
    regenerate(root, join(root, "app"), join(root, "app/out.txt"), "chant build ci --output=out.txt", ({ argv }) => (seen.push(argv), { ok: true }));
    expect(seen[0].slice(0, 3)).toEqual(["chant", "build", "ci"]);
    expect(seen[0][3]).toMatch(/^--output=.*chant-generated-.*\/out\.txt$/);
  });

  test("the member's own node_modules/.bin comes first on PATH, so `chant` is its own", () => {
    const root = workspace({ "app/node_modules/.bin/.keep": "", "app/out.txt": "x" });
    let path = "";
    regenerate(root, join(root, "app"), join(root, "app/out.txt"), "chant build -o out.txt", ({ env }) => ((path = env.PATH ?? ""), { ok: true }));
    expect(path.split(":")[0]).toBe(join(root, "app/node_modules/.bin"));
  });
});

describe("splitCommandLine", () => {
  test("splits words and honours quotes", () => {
    expect(splitCommandLine(`chant build ci --lexicon github -o .github/workflows/ci.yml`)).toEqual(["chant", "build", "ci", "--lexicon", "github", "-o", ".github/workflows/ci.yml"]);
    expect(splitCommandLine(`node -e "console.log('a b')"`)).toEqual(["node", "-e", "console.log('a b')"]);
    expect(splitCommandLine(`echo 'x  y' z\\ w`)).toEqual(["echo", "x  y", "z w"]);
  });
  test("refuses shell syntax and unbalanced quotes", () => {
    for (const bad of ["a | b", "a > f", "a; b", "a && b", "echo $HOME", "echo `x`", 'echo "$HOME"', "echo 'x", "ls *.ts", ""]) {
      expect(splitCommandLine(bad), bad).toBeUndefined();
    }
  });
});

describe("spawnGenerator", () => {
  test("reports a command that can't be found", () => {
    const r = spawnGenerator({ cwd: tmpdir(), argv: ["chant-no-such-command-2541"], env: process.env });
    expect(r.ok).toBe(false);
  });
});

describe("the chant repository's own declaration (#2557)", () => {
  test("lists the files its scripts regenerate, and they and their sources exist", async () => {
    const root = join(dirname(new URL(import.meta.url).pathname), "../../../../..");
    const declaration = readDeclaration(workingTree(root));
    const listed = declaration.members.flatMap((m) => m.generated.map((g) => (m.dir === "." ? g.path : `${m.dir}/${g.path}`)));
    expect(listed).toContain("docs/src/content/docs/lint-rules/audit-rules.mdx");
    expect(listed).toContain("lexicons/aws/src/lint/post-synth/index.ts");
    const f = await findings(root);
    expect(f.filter((x) => x.severity === "error")).toEqual([]);
    expect(new Set(f.map((x) => x.id))).toEqual(new Set([WSP_GENERATED_NOT_COMPARED]));
  });
});
