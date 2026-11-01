/**
 * The quarantine (#4677): known-flaky tests a phase's runner leaves out
 * until they are fixed, declared in `ci.green.quarantine`.
 *
 *   ci quarantine check                 every entry is current: none is past its
 *                                       `until`, and none is more than maxDays out
 *   ci quarantine filter --phase <name> --runner nextest|playwright|list [--only] [--json]
 *                                       what the phase's runner leaves out, or with
 *                                       --only what the scheduled run runs
 *
 * The tick judges a phase by its check runs, whole, so a quarantined test is
 * kept out of the verdict by its runner never running it there: nextest gets
 * a filterset (`-E`), Playwright a `--grep-invert` pattern, and any other
 * runner a list. A scheduled run of the quarantined tests alone, under a job
 * no phase's patterns match, tells whether one is fixed.
 *
 * Whether an entry has expired depends on the day, so the declaration's
 * reader doesn't judge it: an expired quarantine would otherwise stop every
 * chant command, the tick among them. `check` and `filter` do, and fail
 * with `declaration-invalid` at the entry, so the phase whose job asks for
 * its filter goes red until someone fixes the test or the entry. `filter
 * --only` doesn't refuse, so the scheduled run still says whether an expired
 * test passes.
 */

import { formatError } from "../cli/format";
import type { CommandContext } from "../cli/registry";
import { NEXT_RELEASE } from "../release-floors";
import { locateWorkspace } from "./which-chant";
import { quarantineDay, readDeclaration, WorkspaceReadError, type CiGreen, type CiQuarantineEntry } from "./declaration";

/** The first chant that reads `ci.green.quarantine` and runs `chant ci quarantine` (#4677). */
export const CI_QUARANTINE_FLOOR = NEXT_RELEASE;

export const QUARANTINE_RUNNERS = ["nextest", "playwright", "list"] as const;
export type QuarantineRunner = (typeof QUARANTINE_RUNNERS)[number];

const USAGE = "chant ci quarantine check | ci quarantine filter --phase <name> --runner nextest|playwright|list [--only] [--json]";

/** Today, YYYY-MM-DD in UTC. */
export const utcToday = (now: Date = new Date()): string => now.toISOString().slice(0, 10);

/** An entry as a person reads it: `file › test`, or the test. */
export const quarantineName = (e: Pick<CiQuarantineEntry, "test" | "file">): string => (e.file !== undefined ? `${e.file} › ${e.test}` : e.test);

/** What is wrong with an entry on `today`: past its `until`, or `until` further out than `maxDays`. */
export interface QuarantineProblem {
  entry: CiQuarantineEntry;
  message: string;
}

/** The quarantine's entries that are expired or too far out on `today`, of `phase` when given. */
export function quarantineProblems(green: CiGreen, today: string, phase?: string): QuarantineProblem[] {
  const q = green.quarantine;
  if (!q) return [];
  const now = quarantineDay(today);
  if (now === null) throw new Error(`today isn't a day: ${today}`);
  const out: QuarantineProblem[] = [];
  for (const e of q.entries) {
    if (phase !== undefined && e.phase !== phase) continue;
    const until = quarantineDay(e.until)!;
    const what = `ci.green.quarantine: ${e.phase}: ${quarantineName(e)} (${e.issue})`;
    if (until < now) out.push({ entry: e, message: `${what} expired on ${e.until}: fix the test and delete the entry, or delete the test` });
    else if (until - now > q.maxDays) out.push({ entry: e, message: `${what} stays out until ${e.until}, more than ${q.maxDays} days from ${today} (ci.green.quarantine.maxDays)` });
  }
  return out;
}

/** A problem as the reader's own `declaration-invalid` error, located at its entry. */
function problemError(p: QuarantineProblem): WorkspaceReadError {
  return new WorkspaceReadError("declaration-invalid", p.message, p.entry.location);
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A Rust binary id and test name use none of the characters nextest's
// matchers would need escaped, so a name that does is refused, not escaped.
const NEXTEST_PART = /^[A-Za-z0-9_:/.-]+$/;

/** One entry as a nextest filterset: `binary_id(=B) & test(=T)`, or `test(=T)` for a name alone. */
function nextestSet(e: CiQuarantineEntry): string {
  const parts = e.test.split(" ");
  if (parts.length > 2 || !parts.every((p) => NEXTEST_PART.test(p))) {
    throw new WorkspaceReadError("declaration-invalid", `ci.green.quarantine: ${e.phase}: ${JSON.stringify(e.test)} isn't a nextest test: give the binary id and the test's name as nextest prints them ("my-crate::integration module::test_name"), or the name alone`, e.location);
  }
  return parts.length === 2 ? `(binary_id(=${parts[0]}) & test(=${parts[1]}))` : `test(=${parts[0]})`;
}

/**
 * One entry as a pattern for Playwright's `grep`, which it matches against
 * a test's title path joined by spaces (project, spec file from testDir,
 * describe titles, title) with its tags after: the file, then the title at
 * the end, any describe titles between.
 */
function playwrightPattern(e: CiQuarantineEntry): string {
  return `(?:^| )${escapeRegExp(e.file!)} (?:.* )?${escapeRegExp(e.test)}(?: @\\S+)*$`;
}

/** A regex that matches nothing, for a `--grep-invert` that leaves nothing out. */
export const PLAYWRIGHT_NOTHING = "(?!)";

export interface QuarantineFilter {
  phase: string;
  runner: QuarantineRunner;
  only: boolean;
  /** What the runner takes: a filterset, a pattern, or lines. */
  filter: string;
  /** The entries it covers. */
  entries: CiQuarantineEntry[];
}

/**
 * What `phase`'s runner takes (#4677). nextest covers the entries that
 * name no file, and Playwright the ones that do; `list` covers every one, a
 * line each, `file<TAB>test` for an entry with a file. Without `only` it
 * leaves the quarantined tests out, as a phase's run does, and refuses when
 * an entry of the phase is expired or too far out on `today`; with `only` it
 * selects them, for the scheduled run.
 */
export function quarantineFilter(green: CiGreen, req: { phase: string; runner: QuarantineRunner; only?: boolean; today: string }): QuarantineFilter {
  if (!green.phases.some((p) => p.name === req.phase)) {
    throw new WorkspaceReadError("declaration-invalid", `ci.green declares no phase ${JSON.stringify(req.phase)}; it declares ${green.phases.map((p) => p.name).join(", ")}`);
  }
  const only = req.only === true;
  if (!only) {
    const [problem] = quarantineProblems(green, req.today, req.phase);
    if (problem) throw problemError(problem);
  }
  const all = (green.quarantine?.entries ?? []).filter((e) => e.phase === req.phase);
  const entries = req.runner === "nextest" ? all.filter((e) => e.file === undefined) : req.runner === "playwright" ? all.filter((e) => e.file !== undefined) : all;
  let filter: string;
  if (req.runner === "nextest") {
    const set = entries.map(nextestSet).join(" | ");
    filter = only ? set || "none()" : set ? `not (${set})` : "all()";
  } else if (req.runner === "playwright") {
    filter = entries.map(playwrightPattern).join("|") || PLAYWRIGHT_NOTHING;
  } else {
    filter = entries.map((e) => (e.file !== undefined ? `${e.file}\t${e.test}` : e.test)).join("\n");
  }
  return { phase: req.phase, runner: req.runner, only, filter, entries };
}

function readGreenOnly(cwd: string): CiGreen {
  const declaration = readDeclaration(locateWorkspace(cwd).tree);
  const green = declaration.ci?.green;
  if (!green) throw new WorkspaceReadError("declaration-invalid", `${declaration.file} declares no ci.green, so it has no phases to quarantine tests of`);
  return green;
}

const describe = (err: unknown) => (err instanceof WorkspaceReadError ? err.describe() : err instanceof Error ? err.message : String(err));

/** `chant ci quarantine check|filter` (#4677). */
export async function runCiQuarantine(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const action = args.extraPositional;
  try {
    const today = utcToday();
    if (action === "check") {
      const green = readGreenOnly(process.cwd());
      const problems = quarantineProblems(green, today);
      for (const p of problems) console.error(problemError(p).describe());
      if (problems.length > 0) return 1;
      const n = green.quarantine?.entries.length ?? 0;
      console.log(`${n} test${n === 1 ? "" : "s"} quarantined, every one current on ${today}`);
      return 0;
    }
    if (action === "filter") {
      if (!args.phase) throw new Error("--phase names the ci.green phase whose runner takes the filter");
      const runner = args.quarantineRunner;
      if (!runner || !(QUARANTINE_RUNNERS as readonly string[]).includes(runner)) throw new Error(`--runner takes ${QUARANTINE_RUNNERS.join(", ")}${runner ? `, not ${JSON.stringify(runner)}` : ""}`);
      const out = quarantineFilter(readGreenOnly(process.cwd()), { phase: args.phase, runner: runner as QuarantineRunner, only: args.quarantineOnly === true, today });
      if (args.json) {
        const { entries, ...rest } = out;
        console.log(JSON.stringify({ ...rest, entries: entries.map(({ pointer: _p, location: _l, ...e }) => e) }, null, 2));
      } else if (out.filter !== "") console.log(out.filter);
      return 0;
    }
    console.error(formatError({ message: action ? `chant ci quarantine: no ${action}` : "chant ci quarantine needs check or filter", hint: USAGE }));
    return 1;
  } catch (err) {
    console.error(formatError({ message: `chant ci quarantine: ${describe(err)}`, hint: USAGE }));
    return 1;
  }
}
