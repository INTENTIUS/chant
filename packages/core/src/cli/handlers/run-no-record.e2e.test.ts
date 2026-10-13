/**
 * #3955 — `chant run <op> --no-record` through the real CLI: the run executes,
 * says at its start and end that it recorded nothing, and leaves
 * `chant/lifecycle` where it was, both in the checkout and on origin. A plain
 * run beside it records, so the unchanged ref is the flag's doing.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { cleanScratch, commitAll, git, repo, REPO } from "../../workspace/__fixtures__/contract-repo";
import { pushLifecycleStatus, writeBlobToPath } from "../../lifecycle/git";

const MAIN = join(REPO, "packages/core/src/cli/main.ts");
const LOADER = pathToFileURL(join(REPO, "node_modules/tsx/dist/loader.mjs")).href;

/** An Op entity as `Op()` exports it, written as a literal so the fixture needs no import to resolve. */
function opModule(name: string, steps: unknown[]): string {
  return `export const op = ${JSON.stringify({ entityType: "Chant::Op", props: { name, overview: name, phases: [{ name: "Main", steps }] } })};\n`;
}

const SHELL = { kind: "activity", fn: "shellCmd", profile: "atMostOnce", args: { cmd: "echo ran" } };

let dir: string;
let remote: string;

beforeAll(async () => {
  remote = repo({}, false);
  git(remote, "config", "core.bare", "true");
  dir = repo(
    {
      "chant.config.ts": "export default { lexicons: [] };\n",
      "ops/hello.op.ts": opModule("hello", [SHELL]),
      "ops/gated.op.ts": opModule("gated", [{ kind: "gate", gate: "approve-prod" }, SHELL]),
    },
    false,
  );
  git(dir, "config", "user.name", "Run Test");
  git(dir, "config", "user.email", "run@example.com");
  commitAll(dir, "c0");
  git(dir, "remote", "add", "origin", join(remote, ".git"));
  await writeBlobToPath("seed", "seed.json", "{}\n", "seed", { cwd: dir });
  expect((await pushLifecycleStatus({ cwd: dir })).status).toBe("pushed");
});
afterAll(cleanScratch);

function chant(args: string[], env: Record<string, string> = {}): { status: number | null; stderr: string } {
  const r = spawnSync(process.execPath, ["--import", LOADER, MAIN, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", TSX_DISABLE_CACHE: "1", CHANT_NO_RECORD: "", ...env },
  });
  return { status: r.status, stderr: r.stderr };
}

function ledgerRefs(): { local: string; origin: string } {
  return { local: git(dir, "rev-parse", "refs/heads/chant/lifecycle"), origin: git(dir, "ls-remote", "origin", "refs/heads/chant/lifecycle").split(/\s/)[0]! };
}

describe("chant run --no-record (#3955)", () => {
  test("runs the Op, says so at the start and the end, and leaves the ledger ref unchanged here and on origin", () => {
    const before = ledgerRefs();
    const r = chant(["run", "hello", "--no-record"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("not recording (--no-record): nothing this run writes goes on chant/lifecycle");
    expect(r.stderr).toMatch(/not recorded \(--no-record\): nothing went on chant\/lifecycle and nothing was pushed; 1 ledger write was dropped \(1 file\)/);
    expect(ledgerRefs()).toEqual(before);
  });

  test("CHANT_NO_RECORD=1 fails a gate without writing a pending fact", () => {
    const before = ledgerRefs();
    const r = chant(["run", "gated"], { CHANT_NO_RECORD: "1" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('gate "approve-prod" of "gated" cannot be passed under --no-record');
    expect(r.stderr).toContain("not recorded (CHANT_NO_RECORD=1)");
    expect(ledgerRefs()).toEqual(before);
  });

  test("a plain run of the same Op records its run", () => {
    const before = ledgerRefs();
    const r = chant(["run", "hello"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toContain("not recording");
    // The run record moves the local branch; it is pushed by the next write that pushes.
    expect(ledgerRefs().local).not.toBe(before.local);
  });
});
