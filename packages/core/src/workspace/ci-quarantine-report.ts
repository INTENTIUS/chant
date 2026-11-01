/**
 * The quarantine's scheduled run (#4677): what became of each quarantined
 * test, read from the run's JUnit XML, and `ci.quarantine-passed` through
 * `ci.green.notify` for each one that passed, so someone can take it out.
 *
 *   ci quarantine report --phase <name> --junit <file>... [--commit <sha>] [--dry-run] [--json]
 *
 * nextest (`[profile.<p>.junit]`), Playwright (`--reporter=junit`) and most
 * other runners write JUnit XML. A test counts as passed only when every
 * case of it passed on its first try: one nextest marks flaky (it failed,
 * then passed on a retry) is still flaky. The report gates nothing: it exits
 * 0 whatever the tests did, and 1 only when it can't read what it was given.
 *
 * The event is sent on every scheduled run the test passes in, with an id
 * made from the test and the commit, so a re-run of the same commit sends
 * the same id and a receiver can drop it.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatError } from "../cli/format";
import type { CommandContext } from "../cli/registry";
import { makeNotifyEvent, sendNotify as realSendNotify, type NotifyDelivery, type NotifyEvent } from "../notify";
import { NEXT_RELEASE } from "../release-floors";
import { quarantineName } from "./ci-quarantine";
import { locateWorkspace } from "./which-chant";
import { readDeclaration, WorkspaceReadError, type CiGreen, type CiQuarantineEntry } from "./declaration";

/** The first chant that sends `ci.quarantine-passed` (#4677). */
export const CI_QUARANTINE_NOTIFY_FLOOR = NEXT_RELEASE;

/** One `<testcase>`: its suite's name, its classname and name, and how it ended. */
export interface JUnitCase {
  suite: string;
  classname: string;
  name: string;
  outcome: "passed" | "flaky" | "failed" | "skipped";
}

const ENTITY: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const decode = (s: string) => s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (all, e: string) => (e[0] === "#" ? String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENTITY[e] ?? all)));

function attributes(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]!] = decode(m[2] ?? m[3] ?? "");
  return out;
}

/**
 * The test cases of a JUnit XML document. Only the elements a test's
 * outcome needs are read: `testsuite`, `testcase` and its `failure`,
 * `error`, `skipped`, and nextest's `flakyFailure` and `flakyError`.
 */
export function parseJUnit(xml: string): JUnitCase[] {
  // CDATA, comments and declarations can hold anything, `<` included.
  const text = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/<[?!][\s\S]*?>/g, "");
  if (!/<testsuites?[\s>/]/.test(text)) throw new Error("not JUnit XML: no <testsuites> or <testsuite>");
  const out: JUnitCase[] = [];
  const suites: string[] = [];
  let open: (JUnitCase & { marks: Set<string> }) | null = null;
  const close = () => {
    if (!open) return;
    const m = open.marks;
    open.outcome = m.has("failure") || m.has("error") ? "failed" : m.has("flakyFailure") || m.has("flakyError") ? "flaky" : m.has("skipped") ? "skipped" : "passed";
    const { marks: _m, ...c } = open;
    out.push(c);
    open = null;
  };
  for (const m of text.matchAll(/<(\/?)([A-Za-z][\w:.-]*)((?:\s+[^\s=>/]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g)) {
    const [, end, tag, attrs, selfClosing] = m;
    if (tag === "testsuite") {
      if (end) suites.pop();
      else if (!selfClosing) suites.push(attributes(attrs!).name ?? "");
    } else if (tag === "testcase") {
      if (end) close();
      else {
        close();
        const a = attributes(attrs!);
        open = { suite: suites.at(-1) ?? "", classname: a.classname ?? "", name: a.name ?? "", outcome: "passed", marks: new Set() };
        if (selfClosing) close();
      }
    } else if (open && !end) open.marks.add(tag!);
  }
  close();
  return out;
}

/** Whether a case is the entry's test. See {@link quarantineResults}. */
function matches(e: CiQuarantineEntry, c: JUnitCase): boolean {
  // Playwright joins a case's describes and title with " › "; the entry, like its grep, may give them with spaces.
  const name = c.name.replace(/ › /g, " ");
  if (e.file !== undefined) return (c.classname === e.file || c.suite === e.file) && (name === e.test || name.endsWith(` ${e.test}`));
  if (c.name === e.test) return true;
  const at = e.test.indexOf(" ");
  return at > 0 && (c.suite === e.test.slice(0, at) || c.classname === e.test.slice(0, at)) && c.name === e.test.slice(at + 1);
}

export type QuarantineOutcome = JUnitCase["outcome"] | "not-run";

export interface QuarantineResult {
  entry: CiQuarantineEntry;
  outcome: QuarantineOutcome;
  /** How many cases matched: a Playwright test runs once per project. */
  cases: number;
}

/**
 * Each entry of `phase` with how its cases ended. An entry with a `file`
 * matches a case whose classname or suite is the file and whose name (`›`
 * read as a space) is its test or ends with it, as Playwright writes them.
 * One without matches a case named its test, or, for `<binary> <name>` as
 * nextest gives it, a case named `<name>` in the suite (or classname)
 * `<binary>`. Any failed case makes the entry failed, then any flaky, then
 * any passed; all skipped is skipped, and none is not run.
 */
export function quarantineResults(green: CiGreen, phase: string, cases: readonly JUnitCase[]): QuarantineResult[] {
  return (green.quarantine?.entries ?? [])
    .filter((e) => e.phase === phase)
    .map((entry) => {
      const mine = cases.filter((c) => matches(entry, c));
      const has = (o: JUnitCase["outcome"]) => mine.some((c) => c.outcome === o);
      const outcome: QuarantineOutcome = mine.length === 0 ? "not-run" : has("failed") ? "failed" : has("flaky") ? "flaky" : has("passed") ? "passed" : "skipped";
      return { entry, outcome, cases: mine.length };
    });
}

/** `ci.quarantine-passed` for one entry that passed at `commit`. */
export function quarantinePassedEvent(green: CiGreen, entry: CiQuarantineEntry, commit: string, env: NodeJS.ProcessEnv = process.env): NotifyEvent {
  const name = quarantineName(entry);
  const run = { commit };
  return makeNotifyEvent(
    {
      id: createHash("sha256").update(JSON.stringify(["chant", "ci.quarantine-passed", entry.phase, entry.file ?? null, entry.test, commit])).digest("hex"),
      source: "chant",
      event: "ci.quarantine-passed",
      summary: `quarantined ${name} passed in phase ${entry.phase}'s scheduled run at ${commit.slice(0, 12)}: take it out of ci.green.quarantine if ${entry.issue} is fixed`,
      targets: [name],
      ci: { branch: green.branch, commit, phase: entry.phase, quarantine: { test: entry.test, ...(entry.file !== undefined ? { file: entry.file } : {}), issue: entry.issue, until: entry.until } },
      run,
    },
    { env },
  );
}

export interface QuarantineReport {
  phase: string;
  commit: string;
  results: QuarantineResult[];
  /** The tests told about, or that would be with `dryRun`; `sent` when a delivery went through. */
  told: { name: string; sent: boolean }[];
  dryRun: boolean;
}

/** Read the run's JUnit files, match them to `phase`'s entries, and send `ci.quarantine-passed` for each that passed. */
export async function quarantineReport(req: {
  green: CiGreen;
  phase: string;
  junit: readonly string[];
  commit: string;
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
  sendNotify?: typeof realSendNotify;
}): Promise<QuarantineReport> {
  const { green, phase } = req;
  if (!green.phases.some((p) => p.name === phase)) {
    throw new WorkspaceReadError("declaration-invalid", `ci.green declares no phase ${JSON.stringify(phase)}; it declares ${green.phases.map((p) => p.name).join(", ")}`);
  }
  const cases = req.junit.flatMap((xml) => parseJUnit(xml));
  const results = quarantineResults(green, phase, cases);
  const dryRun = req.dryRun === true;
  const send = req.sendNotify ?? realSendNotify;
  const told: QuarantineReport["told"] = [];
  for (const r of results.filter((x) => x.outcome === "passed")) {
    const name = quarantineName(r.entry);
    if (!green.notify) continue;
    if (dryRun) {
      told.push({ name, sent: false });
      continue;
    }
    const deliveries: NotifyDelivery[] = await send(green.notify, quarantinePassedEvent(green, r.entry, req.commit, req.env ?? process.env), { env: req.env ?? process.env });
    told.push({ name, sent: deliveries.some((d) => d.ok) });
  }
  return { phase, commit: req.commit, results, told, dryRun };
}

const LABEL: Record<QuarantineOutcome, string> = { passed: "passed", flaky: "flaky", failed: "failed", skipped: "skipped", "not-run": "not run" };

/** The report as text: a line per entry, then what was told. */
export function formatQuarantineReport(r: QuarantineReport, green: CiGreen): string {
  const lines = [`quarantine of phase ${r.phase} at ${r.commit.slice(0, 12)}: ${r.results.length} test${r.results.length === 1 ? "" : "s"}`];
  for (const x of r.results) {
    const hint = x.outcome === "passed" ? ": it may be fixed; take it out once the issue says so" : "";
    lines.push(`  ${LABEL[x.outcome].padEnd(8)} ${quarantineName(x.entry)} (${x.entry.issue}, until ${x.entry.until})${hint}`);
  }
  const passed = r.results.filter((x) => x.outcome === "passed").length;
  if (passed > 0 && !green.notify) lines.push("  ci.green.notify is not set, so no ci.quarantine-passed was sent");
  for (const t of r.told) lines.push(`  ${r.dryRun ? "would tell" : t.sent ? "told" : "noted (no notify variable set, or every delivery failed)"} ci.quarantine-passed: ${t.name}`);
  return lines.join("\n");
}

const USAGE = "chant ci quarantine report --phase <name> --junit <file>... [--commit <sha>] [--dry-run] [--json]";

const describe = (err: unknown) => (err instanceof WorkspaceReadError ? err.describe() : err instanceof Error ? err.message : String(err));

/** `chant ci quarantine report` (#4677). */
export async function runCiQuarantineReport(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  try {
    if (!args.phase) throw new Error("--phase names the ci.green phase whose quarantined tests the run ran");
    const files = args.quarantineJunit ?? [];
    if (files.length === 0) throw new Error("--junit names the JUnit XML the run wrote; repeat it for several");
    const declaration = readDeclaration(locateWorkspace(process.cwd()).tree);
    const green = declaration.ci?.green;
    if (!green) throw new WorkspaceReadError("declaration-invalid", `${declaration.file} declares no ci.green, so it has no quarantine`);
    const junit = files.map((f) => {
      try {
        return readFileSync(resolve(f), "utf8");
      } catch (err) {
        throw new Error(`could not read --junit ${f}: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    const commit = args.commit ?? process.env.GITHUB_SHA ?? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
    const report = await quarantineReport({ green, phase: args.phase, junit, commit, dryRun: args.dryRun === true });
    if (args.json) {
      const { results, ...rest } = report;
      console.log(JSON.stringify({ ...rest, results: results.map((x) => ({ test: x.entry.test, ...(x.entry.file !== undefined ? { file: x.entry.file } : {}), issue: x.entry.issue, until: x.entry.until, outcome: x.outcome, cases: x.cases })) }, null, 2));
    } else console.log(formatQuarantineReport(report, green));
    return 0;
  } catch (err) {
    console.error(formatError({ message: `chant ci quarantine report: ${describe(err)}`, hint: USAGE }));
    return 1;
  }
}
