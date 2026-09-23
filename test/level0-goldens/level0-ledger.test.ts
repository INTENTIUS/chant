/**
 * chant #2526 — ledger paths and ownership markers for a project with no
 * workspace file (rule 2 of #2525).
 *
 * #2524 D7 moves a workspace member's ledgers under `_members/<member>/` on
 * the `chant/lifecycle` branch and keeps member `.` on today's flat layout,
 * byte for byte. That flat layout is what a level-0 project writes, and this
 * fixture pins it: a git repo holding a copy of examples/getting-started plus
 * two fixture Ops (./fixtures/ledger-ops), one ungated and one that stops at
 * its gate. Both run locally with no cluster and no remote, and the exact
 * path list on the branch is asserted afterwards. The same copy's build is
 * checked for the three ownership labels, since D7 also promises no marker
 * change.
 *
 * Unlike the goldens, the expectations here are inline. They are short, and a
 * change to either is a change to what an existing estate reads back, which
 * should be edited by hand with the issue that allows it, not regenerated.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseYAML } from "@intentius/chant/yaml";
import { childTmp, copyExample, git, makeScratch, runChant, type ChantRun } from "./harness";

const FIXTURE_OPS = join(import.meta.dirname, "fixtures", "ledger-ops");
const TIMEOUT_MS = 300_000;

const scratch = makeScratch("ledger");
let project: string;
let build: ChantRun;
let hello: ChantRun;
let hold: ChantRun;

beforeAll(async () => {
  // The fixtures are stored as `<name>.ts`, not `<name>.op.ts`: repo-wide Op
  // discovery (op/discover.test.ts, generate-pipeline.test.ts) walks this
  // checkout and would find them as Ops of its own. They become Ops only
  // inside the copy.
  const ops = Object.fromEntries(
    readdirSync(FIXTURE_OPS).map((file) => [
      join("ops", file.replace(/\.ts$/, ".op.ts")),
      readFileSync(join(FIXTURE_OPS, file), "utf-8"),
    ]),
  );
  project = copyExample("getting-started", scratch, ops);
  // The two runs write the same branch, so they go one after the other. The
  // build writes nothing to the ledger and runs beside them.
  [build] = await Promise.all([
    runChant(project, ["build"], { timeoutMs: TIMEOUT_MS }),
    (async () => {
      hello = await runChant(project, ["run", "hello"], { timeoutMs: TIMEOUT_MS });
      hold = await runChant(project, ["run", "hold"], { timeoutMs: TIMEOUT_MS });
    })(),
  ]);
}, TIMEOUT_MS);

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  rmSync(childTmp(), { recursive: true, force: true });
});

describe("chant #2526 — a project with no workspace file", () => {
  test("the fixture is level 0: no chant.workspace.json anywhere in it", () => {
    for (const name of ["chant.workspace.json", "chant.workspace.jsonc"]) {
      expect(existsSync(join(project, name)), name).toBe(false);
    }
    expect(git(project, ["ls-files"]).split("\n")).not.toContain("chant.workspace.json");
  });

  test("the runs end the way the fixture Ops say: completed, then gated", () => {
    expect(hello.exit, hello.stderr).toBe(0);
    expect(hold.exit, `${hold.stdout}\n${hold.stderr}`).toBe(3);
  });

  test("ledger paths on chant/lifecycle stay flat: <env>/<file> and _gates/<op>.jsonl", () => {
    const paths = git(project, ["ls-tree", "-r", "--name-only", "chant/lifecycle"]).split("\n").filter(Boolean);
    expect(
      paths,
      "level-0 ledger paths moved. #2524 D7 keeps member `.` on this layout; a change here needs an entry " +
        "on the level-0 exception list (#2525) before it ships.",
    ).toEqual(["_gates/hold.jsonl", "local/runs__hello.jsonl", "local/runs__hold.jsonl"]);
    expect(paths.filter((p) => p.startsWith("_members/"))).toEqual([]);
  });

  test("ledger commits carry the pinned identity and today's subjects", () => {
    const log = git(project, ["log", "--format=%an <%ae> | %s", "chant/lifecycle"]).split("\n").filter(Boolean);
    expect(log).toEqual([
      "chant-level0 <level0@chant.invalid> | Op run record: hold",
      "chant-level0 <level0@chant.invalid> | Pending gate record",
      "chant-level0 <level0@chant.invalid> | Op run record: hello",
    ]);
  });

  test("build output stamps the three ownership labels on every resource", () => {
    expect(build.exit, build.stderr).toBe(0);
    const docs = build.stdout
      .split(/^---\s*$/m)
      .map((doc) => doc.trim())
      .filter(Boolean)
      .map((doc) => parseYAML(doc) as { kind?: string; metadata?: { labels?: Record<string, string> } });
    expect(docs.map((d) => d.kind)).toEqual(["Deployment", "PodDisruptionBudget", "Service"]);
    for (const doc of docs) {
      expect(doc.metadata?.labels, `${doc.kind} labels`).toMatchObject({
        "app.kubernetes.io/managed-by": "chant",
        "chant.intentius.io/stack": "getting-started",
        "chant.intentius.io/env": "local",
      });
    }
  });
});
