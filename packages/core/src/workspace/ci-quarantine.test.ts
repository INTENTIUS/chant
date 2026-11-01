/**
 * #4677 — the quarantine: ci.green.quarantine read and checked, and each
 * runner's filter from `chant ci quarantine filter`.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { parseArgs } from "../cli/parse-args";
import { NEXT_RELEASE } from "../release-floors";
import { CI_QUARANTINE_FLOOR, PLAYWRIGHT_NOTHING, quarantineFilter, quarantineProblems, runCiQuarantine, utcToday } from "./ci-quarantine";
import { parseDeclaration, WorkspaceReadError, type CiGreen } from "./declaration";

const TODAY = "2026-11-01";

const RUST = { test: "arugulad::integration ssh::ssh_installs_runs", issue: "1234", until: "2026-11-10", why: "Fails twice on unrelated commits." };
const BARE = { test: "triggers::fires_once", issue: "https://github.com/acme/app/issues/7", until: "2026-11-01", why: "Times out under load." };
const SPEC = { file: "chat-control.spec.ts", test: "polish: ↑ edits the last message (and Esc cancels) [1.2]?", issue: "#1235", until: "2026-11-15", why: "Races the composer." };

function ws(quarantine: unknown): Record<string, unknown> {
  return { name: "acme", schema: 1, members: [], ci: { green: { branch: "main", phases: { test: ["test (*)"], e2e: ["e2e"], lint: ["lint"] }, require: ["test", "e2e", "lint"], ...(quarantine !== undefined ? { quarantine } : {}) } } };
}

const greenOf = (quarantine: unknown): CiGreen => parseDeclaration(JSON.stringify(ws(quarantine), null, 2), "chant.workspace.json").ci!.green!;

const invalid = (quarantine: unknown): WorkspaceReadError => {
  try {
    greenOf(quarantine);
  } catch (err) {
    return err as WorkspaceReadError;
  }
  throw new Error("read without an error");
};

describe("ci.green.quarantine (#4677)", () => {
  test("is read phase by phase, with maxDays 14 by default and each entry located", () => {
    const q = greenOf({ phases: { test: [RUST, BARE], e2e: [SPEC] } }).quarantine!;
    expect(q.maxDays).toBe(14);
    expect(q.entries.map((e) => [e.phase, e.test, e.file ?? null, e.pointer])).toEqual([
      ["test", RUST.test, null, "/ci/green/quarantine/phases/test/0"],
      ["test", BARE.test, null, "/ci/green/quarantine/phases/test/1"],
      ["e2e", SPEC.test, SPEC.file, "/ci/green/quarantine/phases/e2e/0"],
    ]);
    expect(q.entries[0]!.location).toMatchObject({ file: "chant.workspace.json", line: expect.any(Number) });
    expect(greenOf(undefined).quarantine).toBeUndefined();
  });

  test("refuses an undeclared phase, a day that isn't one, a test listed twice and an entry without an issue", () => {
    expect(invalid({ phases: { unit: [RUST] } }).message).toContain('names the phase "unit", which ci.green.phases does not declare');
    expect(invalid({ phases: { test: [{ ...RUST, until: "2026-02-30" }] } }).message).toContain("until is not a day");
    expect(invalid({ phases: { test: [RUST, RUST] } }).message).toContain("lists");
    const { issue: _issue, ...noIssue } = RUST;
    expect(invalid({ phases: { test: [noIssue] } }).code).toBe("declaration-invalid");
    expect(invalid({ maxDays: 0, phases: { test: [RUST] } }).code).toBe("declaration-invalid");
  });

  test("an entry past its until, or further out than maxDays, is a problem; the last day and the 14th day out are not", () => {
    const green = greenOf({ phases: { test: [RUST, BARE, { ...RUST, test: "x::y", until: "2026-10-31" }, { ...RUST, test: "x::z", until: "2026-11-16" }] } });
    expect(quarantineProblems(green, TODAY).map((p) => p.message)).toEqual([
      "ci.green.quarantine: test: x::y (1234) expired on 2026-10-31: fix the test and delete the entry, or delete the test",
      "ci.green.quarantine: test: x::z (1234) stays out until 2026-11-16, more than 14 days from 2026-11-01 (ci.green.quarantine.maxDays)",
    ]);
    expect(quarantineProblems(greenOf({ maxDays: 30, phases: { test: [{ ...RUST, until: "2026-11-16" }] } }), TODAY)).toEqual([]);
  });
});

describe("ci quarantine filter (#4677)", () => {
  const green = greenOf({ phases: { test: [RUST, BARE], e2e: [SPEC, { file: "nav/menu.spec.ts", test: "opens", issue: "9", until: "2026-11-02", why: "w" }] } });

  test("nextest: a filterset leaving the phase's tests out, or with --only selecting them", () => {
    const set = "(binary_id(=arugulad::integration) & test(=ssh::ssh_installs_runs)) | test(=triggers::fires_once)";
    expect(quarantineFilter(green, { phase: "test", runner: "nextest", today: TODAY }).filter).toBe(`not (${set})`);
    expect(quarantineFilter(green, { phase: "test", runner: "nextest", only: true, today: TODAY }).filter).toBe(set);
    expect(quarantineFilter(green, { phase: "lint", runner: "nextest", today: TODAY }).filter).toBe("all()");
    expect(quarantineFilter(green, { phase: "lint", runner: "nextest", only: true, today: TODAY }).filter).toBe("none()");
  });

  test("playwright: one pattern matching each quarantined test's title path and no other", () => {
    const { filter, entries } = quarantineFilter(green, { phase: "e2e", runner: "playwright", today: TODAY });
    expect(entries).toHaveLength(2);
    // As Playwright's CLI builds a --grep-invert from a string.
    const re = new RegExp(filter, "i");
    expect(re.test(` chromium chat-control.spec.ts ${SPEC.test}`)).toBe(true);
    expect(re.test(` chromium chat-control.spec.ts composer ${SPEC.test} @slow`)).toBe(true);
    expect(re.test(`  nav/menu.spec.ts opens`)).toBe(true);
    expect(re.test(` chromium chat-control.spec.ts polish: x edits the last message (and Esc cancels) [1.2]?`)).toBe(false);
    expect(re.test(` chromium chat-control.spec.ts ${SPEC.test} too`)).toBe(false);
    expect(re.test(` chromium other.spec.ts ${SPEC.test}`)).toBe(false);
    expect(re.test(`  nav/menu.spec.ts opens later`)).toBe(false);
    expect(quarantineFilter(green, { phase: "test", runner: "playwright", today: TODAY }).filter).toBe(PLAYWRIGHT_NOTHING);
    expect(new RegExp(PLAYWRIGHT_NOTHING, "gi").test(" chromium a.spec.ts a")).toBe(false);
  });

  test("list: every entry of the phase, a line each, file and test split by a tab", () => {
    expect(quarantineFilter(green, { phase: "e2e", runner: "list", today: TODAY }).filter).toBe(`chat-control.spec.ts\t${SPEC.test}\nnav/menu.spec.ts\topens`);
    expect(quarantineFilter(green, { phase: "lint", runner: "list", today: TODAY }).filter).toBe("");
  });

  test("refuses the phase's expired entry, but --only and other phases don't", () => {
    const later = "2026-11-03";
    expect(() => quarantineFilter(green, { phase: "e2e", runner: "playwright", today: later })).toThrow(/nav\/menu.spec.ts › opens \(9\) expired on 2026-11-02/);
    expect(quarantineFilter(green, { phase: "e2e", runner: "playwright", only: true, today: later }).entries).toHaveLength(2);
    expect(() => quarantineFilter(green, { phase: "test", runner: "nextest", today: later })).toThrow(/expired on 2026-11-01/);
    expect(quarantineFilter(green, { phase: "lint", runner: "nextest", today: later }).filter).toBe("all()");
  });

  test("refuses a nextest name its matchers can't hold, and an undeclared phase", () => {
    const odd = greenOf({ phases: { test: [{ ...RUST, test: "a b c" }] } });
    expect(() => quarantineFilter(odd, { phase: "test", runner: "nextest", today: TODAY })).toThrow(/isn't a nextest test/);
    expect(() => quarantineFilter(green, { phase: "unit", runner: "nextest", today: TODAY })).toThrow(/declares no phase "unit"/);
  });
});

describe("chant ci quarantine (#4677)", () => {
  const scratch: string[] = [];
  afterAll(() => {
    for (const d of scratch) rmSync(d, { recursive: true, force: true });
  });
  afterEach(() => vi.restoreAllMocks());

  function run(quarantine: unknown, args: Record<string, unknown>): Promise<{ code: number; out: string; err: string }> {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-quarantine-")));
    scratch.push(root);
    execFileSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, "chant.workspace.json"), JSON.stringify(ws(quarantine), null, 2));
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...m: unknown[]) => void out.push(m.map(String).join(" ")));
    vi.spyOn(console, "error").mockImplementation((...m: unknown[]) => void err.push(m.map(String).join(" ")));
    return runCiQuarantine({ args: { command: "ci", path: "quarantine", ...args }, plugins: [] } as never).then((code) => ({ code, out: out.join("\n"), err: err.join("\n") }));
  }

  const day = (offset: number) => utcToday(new Date(Date.now() + offset * 86_400_000));

  test("check passes on current entries and fails at an expired one's line", async () => {
    const ok = await run({ phases: { test: [{ ...RUST, until: day(3) }] } }, { extraPositional: "check" });
    expect(ok).toMatchObject({ code: 0, out: expect.stringContaining("1 test quarantined, every one current") });
    const expired = await run({ phases: { test: [{ ...RUST, until: day(-1) }] } }, { extraPositional: "check" });
    expect(expired.code).toBe(1);
    expect(expired.err).toMatch(/^chant\.workspace\.json:\d+:\d+: ci\.green\.quarantine: test: .* expired on /);
  });

  test("its floor is the next release", () => {
    expect(CI_QUARANTINE_FLOOR).toBe(NEXT_RELEASE);
  });

  test("parses --phase, --runner and --only", () => {
    expect(parseArgs(["ci", "quarantine", "filter", "--phase", "test", "--runner", "nextest", "--only"])).toMatchObject({ command: "ci", path: "quarantine", extraPositional: "filter", phase: "test", quarantineRunner: "nextest", quarantineOnly: true });
  });

  test("filter prints the runner's filter, and --runner is checked", async () => {
    const q = { phases: { test: [{ ...RUST, until: day(3) }] } };
    expect(await run(q, { extraPositional: "filter", phase: "test", quarantineRunner: "nextest" })).toMatchObject({ code: 0, out: "not ((binary_id(=arugulad::integration) & test(=ssh::ssh_installs_runs)))" });
    const json = await run(q, { extraPositional: "filter", phase: "test", quarantineRunner: "list", json: true });
    expect(JSON.parse(json.out)).toMatchObject({ phase: "test", runner: "list", only: false, filter: RUST.test, entries: [{ phase: "test", test: RUST.test, issue: "1234" }] });
    expect(await run(q, { extraPositional: "filter", phase: "test", quarantineRunner: "jest" })).toMatchObject({ code: 1, err: expect.stringContaining('--runner takes nextest, playwright, list, not "jest"') });
  });
});
