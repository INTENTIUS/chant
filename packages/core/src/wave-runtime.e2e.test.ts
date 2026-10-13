/**
 * The wave-job runtime runs alone (#3896). `dist/wave-runtime.mjs` is copied
 * into an empty directory, the way a product's CI image carries it, and run
 * with plain node, nothing installed beside it, through a gated wave's whole
 * life: `run wave` waits at a ledger gate, `approve` records the resolution,
 * `run resume --dry-run` finds it, `run wave` applies; then a wave whose gate
 * asks a decision point waits, `workspace points` lists the open question,
 * `workspace points answer` answers it, and `run wave` applies.
 *
 * End to end because it builds the bundle and spawns node for each command.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
// @ts-expect-error: a plain .mjs script with no type declarations
import { buildWaveRuntime } from "../scripts/build-wave-runtime.mjs";
import { REPO } from "./workspace/__fixtures__/decide-workspace";

const POINTS = {
  points: {
    "prod-apply": {
      title: "Apply this plan to prod",
      question: { type: "noul", instructions: "Should this plan be applied to prod?", criteria: { true: "Apply it.", false: "Do not apply it." } },
      inputs: { "gate.component": "the Op the gate belongs to", "gate.planDigest": "the plan the gate binds" },
      deciders: [{ kind: "quorum", count: 1 }],
    },
  },
};

const SPEC = {
  name: "smoke",
  op: "smoke",
  plan: ["node", "plan.mjs", "{target}", "{plan}"],
  apply: ["node", "apply.mjs", "{target}", "{plan}"],
  waves: [
    { name: "dev", runs: [{ target: "dev" }], gate: "always" },
    { name: "prod", runs: [{ target: "prod" }], gate: "always", point: "prod-apply" },
  ],
};

let scratch: string;
let runtimeDir: string;
let runtime: string;
let repo: string;

/** The job's environment: no CI variables, so nothing names a CI job to resume. */
function jobEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(CI|GITHUB_|GITLAB_|FORGEJO_|GITEA_|CHANT_|NODE_OPTIONS$|VITEST)/.test(k)) continue;
    env[k] = v;
  }
  return env;
}

function chant(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [runtime, ...args], { cwd: repo, env: jobEnv(), encoding: "utf-8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const git = (...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: repo, stdio: "ignore" });

beforeAll(async () => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "chant-wave-runtime-")));
  const built = join(scratch, "build", "wave-runtime.mjs");
  mkdirSync(dirname(built), { recursive: true });
  await buildWaveRuntime({ outfile: built });
  runtimeDir = join(scratch, "image");
  mkdirSync(runtimeDir);
  runtime = join(runtimeDir, "wave-runtime.mjs");
  copyFileSync(built, runtime);

  repo = join(scratch, "repo");
  const files: Record<string, string> = {
    "chant.workspace.json": JSON.stringify({
      name: "wave-runtime",
      schema: 1,
      members: [{ name: "app", dir: "app", kind: "other", because: "a plain Node server" }],
      records: [{ kind: "answers/answer.kind.mjs" }],
    }),
    "app/server.mjs": "export const port = 8080;\n",
    "decisions/points.json": JSON.stringify(POINTS),
    "plan.mjs": `import { writeFileSync } from "node:fs";\nwriteFileSync(process.argv[3], JSON.stringify({ planDigest: "sha256:" + (process.argv[2] === "dev" ? "a" : "b").repeat(64) }));\n`,
    "apply.mjs": `import { appendFileSync } from "node:fs";\nappendFileSync("applied.log", process.argv[2] + "\\n");\n`,
    "waves.json": JSON.stringify(SPEC),
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  cpSync(join(REPO, "reference-workspace", "answers", "answer.kind.mjs"), join(repo, "answers", "answer.kind.mjs"));
  cpSync(join(REPO, "reference-workspace", "answers", "answer.schema.json"), join(repo, "answers", "answer.schema.json"));
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-qm", "spec");
  // The gate policy is read at HEAD^1, so the spec needs a commit under the head.
  writeFileSync(join(repo, ".gitignore"), ".chant/\napplied.log\n");
  git("add", "-A");
  git("commit", "-qm", "ignore");
}, 120_000);

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe("the wave-job runtime, alone in a directory (#3896)", () => {
  test("is one file, with no package beside it to resolve", () => {
    expect(readdirSync(runtimeDir)).toEqual(["wave-runtime.mjs"]);
    const resolveBeside = createRequire(runtime).resolve;
    for (const pkg of ["@intentius/chant", "typescript", "esbuild", "tsx", "zod", "ajv"]) {
      expect(() => resolveBeside(pkg), pkg).toThrow();
    }
    const version = (JSON.parse(readFileSync(join(REPO, "packages", "core", "package.json"), "utf-8")) as { version: string }).version;
    expect(chant("--version").stdout.trim()).toBe(version);
    const other = chant("build");
    expect(other.status).toBe(1);
    expect(other.stderr).toContain("is not part of chant's wave-job runtime");
  });

  test("a ledger gate: run wave waits, approve, run resume --dry-run, run wave applies", () => {
    const waiting = chant("run", "wave", "--spec", "waves.json", "--wave", "1", "--json");
    expect(waiting.status, waiting.stderr).toBe(3);
    const decision = (JSON.parse(waiting.stdout) as { decision: { status: string; gate: string; digest: string } }).decision;
    expect(decision).toMatchObject({ status: "waiting", gate: "smoke-wave-1" });

    const approved = chant("approve", "smoke", "smoke-wave-1", "--actor", "alice");
    expect(approved.status, approved.stderr).toBe(0);
    expect(approved.stderr).toContain(`Gate "smoke-wave-1" on "smoke" resolved by alice`);
    expect(approved.stderr).toContain(`This approves the plan ${decision.digest}`);

    const resume = chant("run", "resume", "--dry-run");
    expect(resume.status, resume.stderr).toBe(0);
    expect(resume.stderr).toContain("smoke / smoke-wave-1, approved by alice");

    const applied = chant("run", "wave", "--spec", "waves.json", "--wave", "1");
    expect(applied.status, applied.stderr).toBe(0);
    expect(applied.stderr).toContain("approved by alice");
    expect(readFileSync(join(repo, "applied.log"), "utf-8")).toBe("dev\n");
  });

  test("a gate that asks a decision point: run wave waits, points lists and answers, run wave applies", () => {
    const waiting = chant("run", "wave", "--spec", "waves.json", "--wave", "2", "--json");
    expect(waiting.status, waiting.stderr).toBe(3);
    const id = (JSON.parse(waiting.stdout) as { decision: { point: { question: { id: string } } } }).decision.point.question.id;
    expect(id).toMatch(/^prod-apply-[0-9a-f]{12}$/);

    const open = chant("workspace", "points", "--open");
    expect(open.status, open.stderr).toBe(0);
    expect(open.stdout).toContain(`${id}  escalated`);

    const answered = chant("workspace", "points", "answer", id, "--answer", "true", "--by", "alice");
    expect(answered.status, answered.stderr).toBe(0);
    expect(readFileSync(join(repo, "answers", `${id}.md`), "utf-8")).toMatch(/state: "answered"\nanswer: true/);

    const applied = chant("run", "wave", "--spec", "waves.json", "--wave", "2");
    expect(applied.status, applied.stderr).toBe(0);
    expect(readFileSync(join(repo, "applied.log"), "utf-8")).toBe("dev\nprod\n");

    // The ledger the runtime wrote is the full CLI's: pending, resolution, pending citing the question, resolution citing the answer.
    const ledger = execFileSync("git", ["show", "chant/lifecycle:_gates/smoke.jsonl"], { cwd: repo, encoding: "utf-8" })
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { kind?: string; gate: string; resolvedBy?: string; answer?: { id: string } });
    expect(ledger.map((l) => [l.gate, l.kind ?? "resolution", l.resolvedBy ?? null])).toEqual([
      ["smoke-wave-1", "pending", null],
      ["smoke-wave-1", "resolution", "alice"],
      ["smoke-wave-2", "pending", null],
      ["smoke-wave-2", "resolution", "alice"],
    ]);
    expect(ledger[3]!.answer?.id).toBe(id);
  });
});
