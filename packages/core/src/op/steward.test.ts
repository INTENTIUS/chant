/**
 * A steward's declaration and its local form (#2731): `declareSteward`'s
 * refusals, discovery beside the Ops, a local round that runs the steward's
 * scheduled Ops under its own lease, and the rule that a steward turn and a
 * coding agent share one checkout without colliding.
 */
import { describe, test, expect } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ActivityFn, ActivityProfile } from "./activity-registry";
import type { OpConfig } from "./types";
import { declareSteward, isStewardDeclaration, pickSteward, stewardFormFor, stewardLeaseName } from "./steward";
import { discoverOps, discoverStewards } from "./discover";
import { runOperatorRound, acquireStewardLease, formatRoundLine } from "./operator";
import { readLease } from "../lifecycle/lease";
import { readRunLedger } from "../lifecycle/run-ledger";

const PROFILES: Record<string, ActivityProfile> = {};

function op(name: string, cron?: string, fn = "fakeTurn"): OpConfig {
  return {
    name,
    overview: `${name} fixture`,
    phases: [{ name: "Run", steps: [{ kind: "activity", fn, args: {} }] }],
    ...(cron ? { schedule: { cron, overlap: "skip" as const } } : {}),
  };
}

function git(args: string[], cwd: string): { stdout: string; status: number } {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  return { stdout: r.stdout ?? "", status: r.status ?? -1 };
}

async function initRepo(dir: string): Promise<void> {
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "test@chant.dev"], dir);
  git(["config", "user.name", "Test"], dir);
  mkdirSync(join(dir, "app"), { recursive: true });
  writeFileSync(join(dir, "app", "index.ts"), "export const hello = 1;\n");
  git(["add", "app/index.ts"], dir);
  git(["commit", "-q", "-m", "init"], dir);
}

/** An `*.op.ts` file exporting a steward as a literal: the shape `declareSteward` returns, no imports. */
function writeStewardFile(dir: string, file: string, name: string, ops: OpConfig[], form: unknown = { default: "local", environments: {} }): void {
  mkdirSync(join(dir, "ops"), { recursive: true });
  writeFileSync(
    join(dir, "ops", file),
    `export const steward = ${JSON.stringify({ kind: "Chant::Steward", name, ops, form })};\n`,
  );
}

function turns(log: string[]): Map<string, ActivityFn> {
  return new Map<string, ActivityFn>([
    ["fakeTurn", async () => { log.push("turn"); return { ok: true }; }],
  ]);
}

describe("declareSteward", () => {
  test("normalises the form, local by default", () => {
    const s = declareSteward({ name: "box-steward", ops: [op("box-converge", "* * * * *")] });
    expect(isStewardDeclaration(s)).toBe(true);
    expect(s.form).toEqual({ default: "local", environments: {} });
    expect(stewardFormFor(s)).toBe("local");
  });

  test("chooses the form per environment", () => {
    const s = declareSteward({
      name: "box-steward",
      ops: [],
      form: { default: "local", environments: { "fountain-k3d": "fountain" } },
    });
    expect(stewardFormFor(s, "minimal")).toBe("local");
    expect(stewardFormFor(s, "fountain-k3d")).toBe("fountain");
  });

  test("reads an Op declaration through its props", () => {
    const s = declareSteward({ name: "box-steward", ops: [{ props: op("box-release") }] });
    expect(s.ops.map((o) => o.name)).toEqual(["box-release"]);
  });

  test("a brokered steward names its capabilities and holds no vault (#2726)", () => {
    const s = declareSteward({ name: "a", ops: [], capabilities: ["fountain", "inference", "fountain"] });
    expect(s.capabilities).toEqual(["fountain", "inference"]);
    expect(s.vault).toBeNull();
    expect(declareSteward({ name: "b", ops: [], vault: "creds" }).vault).toBe("creds");
    expect(() => declareSteward({ name: "c", ops: [], capabilities: ["fountain"], vault: "creds" })).toThrow(/holds no credential/);
  });

  test("refuses what would make two writers or a promise it can't keep", () => {
    expect(() => declareSteward({ name: "a", ops: [op("x"), op("x")] })).toThrow(/listed twice/);
    expect(() => declareSteward({ name: "a", ops: [{ ...op("x"), schedule: { cron: "* * * * *", overlap: "buffer" as never } }] })).toThrow(/overlap "buffer"/);
    expect(() => declareSteward({ name: "a", ops: [op("x", "not a cron")] })).toThrow(/Steward "a": op "x"/);
    expect(() => declareSteward({ name: "../a", ops: [] })).toThrow(/steward's name/);
    expect(() => declareSteward({ name: "a", ops: [], form: "cloud" as never })).toThrow(/"local" or "fountain"/);
    expect(() => declareSteward({ name: "a", ops: [], form: { default: "local", environments: { "a/b": "fountain" } } })).toThrow(/can't be an environment/);
  });
});

describe("discoverStewards", () => {
  test("finds a steward in an *.op.ts file, and discoverOps doesn't call that file an error", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      writeStewardFile(dir, "steward.op.ts", "box-steward", [op("box-converge", "* * * * *")]);
      const { stewards, errors } = await discoverStewards({ cwd: dir });
      expect(errors).toEqual([]);
      expect([...stewards.keys()]).toEqual(["box-steward"]);
      expect(stewards.get("box-steward")!.exportName).toBe("steward");
      expect((await discoverOps({ cwd: dir })).errors).toEqual([]);
    });
  });

  test("refuses one Op listed by two stewards", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      writeStewardFile(dir, "a.op.ts", "first", [op("box-converge", "* * * * *")]);
      writeStewardFile(dir, "b.op.ts", "second", [op("box-converge", "* * * * *")]);
      const { stewards, errors, conflicts } = await discoverStewards({ cwd: dir });
      expect([...stewards.keys()]).toEqual(["first"]);
      expect(errors).toEqual([]);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toMatch(/steward "second" lists op "box-converge", which steward "first" already runs/);
    });
  });

  test("pickSteward takes the only steward, or the named one, and refuses otherwise", () => {
    const one = new Map([["box-steward", { declaration: declareSteward({ name: "box-steward", ops: [] }) }]]);
    expect(pickSteward(one, "")).toMatchObject({ name: "box-steward" });
    expect(pickSteward(one, "other")).toMatch(/No steward "other"/);
    expect(pickSteward(new Map(), "")).toMatch(/No steward is declared/);
    const two = new Map([...one, ["b", { declaration: declareSteward({ name: "b", ops: [] }) }]]);
    expect(pickSteward(two, "")).toMatch(/2 stewards are declared/);
  });
});

describe("a local steward round", () => {
  test("runs only the scheduled Ops, each on its cron, and records each run", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      const steward = declareSteward({
        name: "box-steward",
        ops: [op("box-converge", "* * * * *"), op("box-dispatch", "*/5 * * * *"), op("box-release")],
      });
      const log: string[] = [];
      // 10:01 fires every minute, not every five.
      const now = () => new Date(2026, 8, 25, 10, 1, 0);
      const events = await runOperatorRound({ cwd: dir, holder: "h1", steward, activities: turns(log), profiles: PROFILES, now });
      expect(events.map((e) => [e.kind, e.op])).toEqual([
        ["ticked", "box-converge"],
        ["skipped-not-due", "box-dispatch"],
      ]);
      // box-release has no schedule: it runs when asked, never on a round.
      expect(log).toEqual(["turn"]);
      expect((await readRunLedger("local", "box-converge", { cwd: dir })).records).toHaveLength(1);
      expect((await readLease(stewardLeaseName("box-steward"), { cwd: dir })).record?.holder).toBe("h1");
    });
  });

  test("a second holder of the same steward ticks nothing", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      const steward = declareSteward({ name: "box-steward", ops: [op("box-converge", "* * * * *")] });
      expect((await acquireStewardLease("box-steward", "h1", { cwd: dir })).acquired).toBe(true);
      const log: string[] = [];
      const events = await runOperatorRound({ cwd: dir, holder: "h2", steward, activities: turns(log), profiles: PROFILES });
      expect(events).toEqual([{ kind: "steward-busy", op: "_stewards/box-steward", env: "-", steward: "box-steward", heldBy: "h1" }]);
      expect(formatRoundLine(events[0])).toBe("operator: steward box-steward skipped=1(steward-lease-held:h1)");
      expect(log).toEqual([]);
    });
  });

  test("a coding agent edits app/ and holds the index lock during a steward turn, and neither collides", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      const head = git(["rev-parse", "HEAD"], dir).stdout.trim();
      const steward = declareSteward({ name: "box-steward", ops: [op("box-converge", "* * * * *", "agentEditsMidTurn")] });
      const edited = "export const hello = 2; // the coding agent's edit\n";
      const lock = join(dir, ".git", "index.lock");
      const activities = new Map<string, ActivityFn>([
        [
          "agentEditsMidTurn",
          async () => {
            // The coding agent, mid-turn: an edit to the app, and a commit in
            // progress that holds git's index lock.
            writeFileSync(join(dir, "app", "index.ts"), edited);
            writeFileSync(lock, "");
            return { ok: true };
          },
        ],
      ]);

      const events = await runOperatorRound({ cwd: dir, holder: "h1", steward, activities, profiles: PROFILES });
      expect(events.map((e) => e.kind)).toEqual(["ticked"]);

      // The steward's writes landed where chant writes: the run ledger and the lease refs.
      expect((await readRunLedger("local", "box-converge", { cwd: dir })).records).toHaveLength(1);
      expect(git(["rev-parse", "--verify", "refs/heads/chant/lifecycle"], dir).status).toBe(0);

      // And none of them touched the checkout: the agent's edit is intact, its
      // lock is still its own, and HEAD and the index are where they were.
      expect(readFileSync(join(dir, "app", "index.ts"), "utf-8")).toBe(edited);
      expect(existsSync(lock)).toBe(true);
      rmSync(lock); // the agent's commit finishes; git status needs the lock gone

      expect(git(["rev-parse", "HEAD"], dir).stdout.trim()).toBe(head);
      expect(git(["status", "--porcelain"], dir).stdout).toBe(" M app/index.ts\n");
      expect(git(["diff", "--cached", "--name-only"], dir).stdout).toBe("");
    });
  });
});
