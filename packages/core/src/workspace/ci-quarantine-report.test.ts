/**
 * #4677 — the quarantine's scheduled run: each quarantined test's outcome
 * from JUnit XML, and ci.quarantine-passed for each one that passed.
 */

import { describe, expect, test, vi } from "vitest";
import Ajv2020 from "ajv/dist/2020";
import notifySchema from "../notify.schema.json" with { type: "json" };
import { notifyHeadline, type NotifyEvent } from "../notify";
import { NEXT_RELEASE } from "../release-floors";
import { CI_QUARANTINE_NOTIFY_FLOOR, formatQuarantineReport, parseJUnit, quarantineReport } from "./ci-quarantine-report";
import { parseDeclaration, type CiGreen } from "./declaration";

const SHA = "0123456789abcdef0123456789abcdef01234567";

const NEXTEST = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="nextest-run" tests="4" failures="1" errors="0">
  <testsuite name="arugulad::integration" tests="3" disabled="0" errors="0" failures="1">
    <testcase name="ssh::ssh_installs_runs" classname="arugulad::integration" timestamp="2026-11-01T07:47:00Z" time="12.1">
      <system-out><![CDATA[ok <not a tag> </testcase> ]]></system-out>
    </testcase>
    <testcase name="reboot::comes_back" classname="arugulad::integration" time="3.0">
      <flakyFailure message="code=101" type="test failure"><![CDATA[thread panicked]]></flakyFailure>
    </testcase>
    <testcase name="reboot::keeps_state" classname="arugulad::integration" time="3.0">
      <failure message="code=101" type="test failure">assert &lt;left&gt; == right</failure>
      <rerunFailure message="code=101" type="test failure"/>
    </testcase>
  </testsuite>
  <testsuite name="arugula-platform" tests="1">
    <testcase name="triggers::fires_once" classname="arugula-platform" time="0.2"/>
  </testsuite>
</testsuites>`;

const PLAYWRIGHT = `<testsuites id="" name="" tests="3" failures="0" skipped="1">
<testsuite name="chat-control.spec.ts" timestamp="2026-11-01T07:50:00" hostname="chromium" tests="2" failures="0" skipped="1" time="4.2" errors="0">
<testcase name="composer › polish: edits the last message (and Esc cancels)" classname="chat-control.spec.ts" time="2.1">
</testcase>
<testcase name="opens the menu" classname="chat-control.spec.ts" time="0">
<skipped>
</skipped>
</testcase>
</testsuite>
<testsuite name="chat-control.spec.ts" hostname="webkit" tests="1">
<testcase name="composer › polish: edits the last message (and Esc cancels)" classname="chat-control.spec.ts" time="2.4"></testcase>
</testsuite>
</testsuites>`;

const entry = (test: string, extra: Record<string, string> = {}) => ({ test, issue: "1234", until: "2026-11-10", why: "Flaky.", ...extra });

function greenOf(notify?: unknown): CiGreen {
  const ws = {
    name: "acme",
    schema: 1,
    members: [],
    ci: {
      green: {
        branch: "main",
        phases: { test: ["test (*)"], e2e: ["e2e"] },
        require: ["test", "e2e"],
        ...(notify !== undefined ? { notify } : {}),
        quarantine: {
          phases: {
            test: [entry("arugulad::integration ssh::ssh_installs_runs"), entry("arugulad::integration reboot::comes_back"), entry("reboot::keeps_state"), entry("triggers::fires_once"), entry("other::gone")],
            e2e: [entry("polish: edits the last message (and Esc cancels)", { file: "chat-control.spec.ts", issue: "https://github.com/acme/app/issues/1235" }), entry("opens the menu", { file: "chat-control.spec.ts" })],
          },
        },
      },
    },
  };
  return parseDeclaration(JSON.stringify(ws), "chant.workspace.json").ci!.green!;
}

const NOTIFY = { webhook: "HOOK", key: "HOOK_KEY" };

describe("ci quarantine report (#4677)", () => {
  test("its floor is the next release", () => {
    expect(CI_QUARANTINE_NOTIFY_FLOOR).toBe(NEXT_RELEASE);
  });

  test("reads nextest's and Playwright's JUnit, CDATA and entities included", () => {
    expect(parseJUnit(NEXTEST).map((c) => [c.suite, c.name, c.outcome])).toEqual([
      ["arugulad::integration", "ssh::ssh_installs_runs", "passed"],
      ["arugulad::integration", "reboot::comes_back", "flaky"],
      ["arugulad::integration", "reboot::keeps_state", "failed"],
      ["arugula-platform", "triggers::fires_once", "passed"],
    ]);
    expect(parseJUnit(PLAYWRIGHT).map((c) => c.outcome)).toEqual(["passed", "skipped", "passed"]);
    expect(() => parseJUnit("<html></html>")).toThrow(/not JUnit XML/);
  });

  test("each entry's outcome; a test that passed only on a retry is flaky, not passed", async () => {
    const send = vi.fn(async () => [{ target: "webhook" as const, ok: true, detail: "delivered" }]);
    const r = await quarantineReport({ green: greenOf(NOTIFY), phase: "test", junit: [NEXTEST], commit: SHA, env: { HOOK: "https://hooks.example/x", HOOK_KEY: "k" }, sendNotify: send });
    expect(r.results.map((x) => [x.entry.test, x.outcome, x.cases])).toEqual([
      ["arugulad::integration ssh::ssh_installs_runs", "passed", 1],
      ["arugulad::integration reboot::comes_back", "flaky", 1],
      ["reboot::keeps_state", "failed", 1],
      ["triggers::fires_once", "passed", 1],
      ["other::gone", "not-run", 0],
    ]);
    expect(r.told).toEqual([
      { name: "arugulad::integration ssh::ssh_installs_runs", sent: true },
      { name: "triggers::fires_once", sent: true },
    ]);
    expect(send).toHaveBeenCalledTimes(2);
    const event = (send.mock.calls[0] as unknown as [unknown, NotifyEvent])[1];
    expect(event).toMatchObject({
      event: "ci.quarantine-passed",
      source: "chant",
      targets: ["arugulad::integration ssh::ssh_installs_runs"],
      ci: { branch: "main", commit: SHA, phase: "test", quarantine: { test: "arugulad::integration ssh::ssh_installs_runs", issue: "1234", until: "2026-11-10" } },
      run: { commit: SHA },
    });
    const second = (send.mock.calls[1] as unknown as [unknown, NotifyEvent])[1];
    expect(second.id).not.toBe(event.id);
    const ajv = new Ajv2020({ strict: false });
    expect(ajv.validate(notifySchema, event)).toBe(true);
    expect(notifyHeadline(event)).toContain("quarantined arugulad::integration ssh::ssh_installs_runs passed in phase test's scheduled run at 0123456789ab");
  });

  test("a Playwright test passes when every project's case passed, and its describes may be left out", async () => {
    const r = await quarantineReport({ green: greenOf(), phase: "e2e", junit: [PLAYWRIGHT], commit: SHA });
    expect(r.results.map((x) => [x.entry.test, x.outcome, x.cases])).toEqual([
      ["polish: edits the last message (and Esc cancels)", "passed", 2],
      ["opens the menu", "skipped", 1],
    ]);
    expect(r.told).toEqual([]);
    expect(formatQuarantineReport(r, greenOf())).toBe(
      [
        `quarantine of phase e2e at 0123456789ab: 2 tests`,
        `  passed   chat-control.spec.ts › polish: edits the last message (and Esc cancels) (https://github.com/acme/app/issues/1235, until 2026-11-10): it may be fixed; take it out once the issue says so`,
        `  skipped  chat-control.spec.ts › opens the menu (1234, until 2026-11-10)`,
        `  ci.green.notify is not set, so no ci.quarantine-passed was sent`,
      ].join("\n"),
    );
  });

  test("a dry run tells nothing, and events can be filtered out", async () => {
    const send = vi.fn(async () => []);
    const dry = await quarantineReport({ green: greenOf(NOTIFY), phase: "test", junit: [NEXTEST], commit: SHA, dryRun: true, sendNotify: send });
    expect(send).not.toHaveBeenCalled();
    expect(formatQuarantineReport(dry, greenOf(NOTIFY))).toContain("would tell ci.quarantine-passed: triggers::fires_once");
    expect(() => parseDeclaration(JSON.stringify({ name: "a", schema: 1, members: [], ci: { green: { branch: "main", phases: { t: ["t"] }, require: ["t"], notify: { ...NOTIFY, events: ["ci.red", "ci.quarantine-passed"] } } } }), "chant.workspace.json")).not.toThrow();
  });
});
