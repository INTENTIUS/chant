/**
 * chant #2526 — the level-0 CLI goldens (rule 2 of #2525).
 *
 * A project with no `chant.workspace.json` gets today's chant. This suite runs
 * the real CLI over a handful of example projects and holds each command's
 * exit code, stdout, stderr and the files it left in the project against a
 * committed golden under `goldens/<example>/<command>.golden`. The workspace
 * work (#2524) is then checked against these on every PR: a change that
 * moves any of them must be on the level-0 exception list, and regenerates
 * the golden in the same PR so the diff shows exactly what moved.
 *
 * The same runs record every module the CLI process loaded, and the second
 * block below fails if any of them is a workspace module. That is the other
 * half of rule 2: level 0 does not pay for workspaces, not even in load time.
 *
 * The projects, and why each is here:
 *
 * - getting-started: k8s, ownership labels, five root-level Ops, and an
 *   `audit` that finds nothing (plain text even under `--format json`).
 * - local-op-quickstart: Ops only, five lexicons listed, an effect receipt
 *   with its digest. That digest was already real SHA-256 over
 *   `canonicalJson`, so #2514 left it unchanged.
 * - fan-out-estate: aws, multi-stack with fifteen `stacks[]` entries.
 * - adopt-alb-services: `audit --format json` with real findings (docker).
 * - terraform-carve-out: `audit --format json` with TF023 findings, which
 *   #2528 changes. Not a chant project; audit needs none.
 *
 * Harness, normalisation and the update mode: see ./harness.ts.
 *
 *   npx vitest run test/level0-goldens                    # compare
 *   UPDATE_GOLDENS=1 npx vitest run test/level0-goldens   # rewrite, then review the diff
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { cpus } from "node:os";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import {
  GOLDENS_DIR,
  REGENERATE_HINT,
  REPO_ROOT,
  UPDATE_GOLDENS,
  childTmp,
  copyExample,
  goldenPath,
  limiter,
  makeScratch,
  readOrUpdateGolden,
  renderGolden,
  runChant,
  slug,
  workspaceModules,
  type ChantRun,
} from "./harness";

interface Case {
  example: string;
  args: string[];
}

const CASES: Case[] = [
  { example: "getting-started", args: ["build"] },
  { example: "getting-started", args: ["graph"] },
  { example: "getting-started", args: ["graph", "--format", "ir"] },
  { example: "getting-started", args: ["lint", "--format", "json"] },
  { example: "getting-started", args: ["audit", "--format", "json"] },
  { example: "getting-started", args: ["run", "list"] },
  { example: "local-op-quickstart", args: ["build"] },
  { example: "local-op-quickstart", args: ["graph", "--format", "ir"] },
  { example: "local-op-quickstart", args: ["lint", "--format", "json"] },
  { example: "local-op-quickstart", args: ["run", "list"] },
  { example: "fan-out-estate", args: ["build"] },
  { example: "fan-out-estate", args: ["graph", "--stacks"] },
  { example: "fan-out-estate", args: ["graph", "--format", "ir"] },
  { example: "fan-out-estate", args: ["lint", "--format", "json"] },
  { example: "adopt-alb-services", args: ["audit", "--format", "json"] },
  { example: "terraform-carve-out", args: ["audit", "--format", "json"] },
];

const label = (c: Case) => `\`chant ${c.args.join(" ")}\` on examples/${c.example}`;

// Each command takes 7-19s on an idle machine, most of it loading lexicons.
// Half the cores, at most four, keeps CI's 4-core runner usable by the other
// test files running beside this one.
const run = limiter(Math.max(2, Math.min(4, Math.floor(cpus().length / 2))));
const RUN_TIMEOUT_MS = 240_000;
// A test waits for its own run, which may sit in the queue behind the others.
const TEST_TIMEOUT_MS = 600_000;

const scratch = makeScratch("goldens");
const runs = new Map<Case, Promise<ChantRun>>();

beforeAll(() => {
  for (const c of CASES) {
    const parent = join(scratch, slug(c.args));
    mkdirSync(parent, { recursive: true });
    const promise = run(() => runChant(copyExample(c.example, parent), c.args, { recordModules: true, timeoutMs: RUN_TIMEOUT_MS }));
    // Attach a handler now; each test awaits its own promise and reports it.
    promise.catch(() => undefined);
    runs.set(c, promise);
  }
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  rmSync(childTmp(), { recursive: true, force: true });
});

describe("chant #2526 — level-0 output matches the goldens", () => {
  for (const c of CASES) {
    test(label(c), async () => {
      const result = await runs.get(c)!;
      const file = goldenPath(c.example, c.args);
      const actual = renderGolden(c.example, c.args, result);
      const expected = readOrUpdateGolden(file, actual);
      expect(
        expected,
        `no golden for ${label(c)} at ${relative(REPO_ROOT, file)}. ` +
          "Create it with `UPDATE_GOLDENS=1 npx vitest run test/level0-goldens`.",
      ).toBeDefined();
      expect(
        actual,
        `level-0 output drifted: ${label(c)} no longer matches ${relative(REPO_ROOT, file)}. ${REGENERATE_HINT}`,
      ).toBe(expected);
    }, TEST_TIMEOUT_MS);
  }

  test("every golden on disk belongs to a case above", () => {
    // A golden whose case was removed would otherwise sit there looking like
    // coverage. In update mode the stale files are deleted instead.
    const wanted = new Set(CASES.map((c) => goldenPath(c.example, c.args)));
    const onDisk = existsSync(GOLDENS_DIR)
      ? readdirSync(GOLDENS_DIR, { recursive: true, encoding: "utf-8" })
          .filter((f) => f.endsWith(".golden"))
          .map((f) => join(GOLDENS_DIR, f))
      : [];
    const stale = onDisk.filter((f) => !wanted.has(f));
    if (UPDATE_GOLDENS) for (const f of stale) rmSync(f);
    else expect(stale.map((f) => relative(REPO_ROOT, f)), "goldens with no case in level0-goldens.test.ts").toEqual([]);
  });
});

describe("chant #2526 — no workspace module loads at level 0", () => {
  for (const c of CASES) {
    test(label(c), async () => {
      const result = await runs.get(c)!;
      // Non-vacuous: the recorder saw the CLI itself load.
      expect(result.modules, `${label(c)}: the module recorder saw nothing`).toContain(
        pathToFileURL(join(REPO_ROOT, "packages/core/src/cli/main.ts")).href,
      );
      expect(workspaceModules(result.modules), `${label(c)} loaded workspace modules`).toEqual([]);
    }, TEST_TIMEOUT_MS);
  }

  test("the rule matches core's workspace directory and workspace-named chant modules, not project files", () => {
    const f = (path: string) => pathToFileURL(path).href;
    const hits = workspaceModules([
      f(join(REPO_ROOT, "packages/core/src/workspace/index.ts")),
      f(join(REPO_ROOT, "packages/core/src/workspace-root.ts")),
      f(join(REPO_ROOT, "lexicons/k8s/src/workspace-kinds.ts")),
      f("/srv/app/node_modules/@intentius/chant/dist/workspace/read.js"),
      f("/srv/app/node_modules/@intentius/chant-lexicon-aws/dist/workspace-kinds.js"),
      // Not workspace modules:
      f(join(REPO_ROOT, "packages/core/src/build.ts")),
      f(join(REPO_ROOT, "lexicons/terraform/src/spec/workspace.json")),
      f("/srv/app/src/workspace.ts"),
      f(join(REPO_ROOT, "node_modules/some-dep/workspace.js")),
    ]);
    expect(hits).toEqual(
      [
        join(REPO_ROOT, "lexicons/k8s/src/workspace-kinds.ts"),
        join(REPO_ROOT, "packages/core/src/workspace-root.ts"),
        join(REPO_ROOT, "packages/core/src/workspace/index.ts"),
        "/srv/app/node_modules/@intentius/chant-lexicon-aws/dist/workspace-kinds.js",
        "/srv/app/node_modules/@intentius/chant/dist/workspace/read.js",
      ].sort(),
    );
  });

  test(
    "a planted workspace import during a real build is caught",
    async () => {
      // No workspace module exists yet, so plant two where one would live in
      // an installed chant, and have the project's config import them. The
      // build then loads both through the same recorder the runs above use.
      const plant = join(scratch, "plant", "node_modules", "@intentius");
      const planted = [
        join(plant, "chant", "src", "workspace", "index.js"),
        join(plant, "chant-lexicon-planted", "dist", "workspace-kinds.js"),
      ];
      for (const file of planted) {
        mkdirSync(join(file, ".."), { recursive: true });
        writeFileSync(file, "export const planted = true;\n");
      }
      const parent = join(scratch, "plant-project");
      mkdirSync(parent, { recursive: true });
      const project = copyExample("local-op-quickstart", parent);
      const config = join(project, "chant.config.ts");
      writeFileSync(
        config,
        planted.map((file) => `import ${JSON.stringify(pathToFileURL(file).href)};\n`).join("") +
          readFileSync(config, "utf-8"),
      );

      const result = await run(() => runChant(project, ["build"], { recordModules: true, timeoutMs: RUN_TIMEOUT_MS }));
      expect(result.exit, result.stderr).toBe(0);
      expect(workspaceModules(result.modules)).toEqual([...planted].sort());
    },
    TEST_TIMEOUT_MS,
  );
});
