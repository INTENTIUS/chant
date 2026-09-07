/**
 * Cron tests (#2120) — the validator ported from TMP010, and the matcher
 * `chant operator` ticks on.
 */

import { describe, test, expect } from "vitest";
import { isValidCronExpression, cronSyntaxMessage, cronMatches, cronDueBetween } from "./cron";

/** Local-time date literal, so a matcher reading `getHours()` sees what the test wrote. */
function at(y: number, m: number, d: number, h: number, min: number): Date {
  return new Date(y, m - 1, d, h, min, 0, 0);
}

describe("isValidCronExpression — the shared parser", () => {
  test("accepts 5- and 6-field expressions", () => {
    expect(isValidCronExpression("*/10 * * * *")).toBe(true);
    expect(isValidCronExpression("0 6 * * 1")).toBe(true);
    expect(isValidCronExpression("0 0 6 * * *")).toBe(true);
  });

  test("rejects the wrong field count", () => {
    expect(isValidCronExpression("* * * *")).toBe(false);
    expect(isValidCronExpression("* * * * * * *")).toBe(false);
  });

  test("rejects prose and named fields", () => {
    expect(isValidCronExpression("every ten minutes")).toBe(false);
    expect(isValidCronExpression("0 6 * * MON")).toBe(false);
  });

  test("tolerates surrounding whitespace and repeated separators", () => {
    expect(isValidCronExpression("  0   6 * * *  ")).toBe(true);
  });

  test("the message names the expression, so the Op refusal and a lexicon's cron check read alike", () => {
    expect(cronSyntaxMessage("nope")).toBe(
      'cron expression "nope" does not look like valid 5- or 6-field cron syntax',
    );
  });
});

describe("cronMatches", () => {
  test("every minute", () => {
    expect(cronMatches("* * * * *", at(2026, 9, 6, 13, 37))).toBe(true);
  });

  test("a step fires on the multiples and nothing else", () => {
    expect(cronMatches("*/10 * * * *", at(2026, 9, 6, 13, 30))).toBe(true);
    expect(cronMatches("*/10 * * * *", at(2026, 9, 6, 13, 31))).toBe(false);
  });

  test("a list fires on each member", () => {
    for (const m of [0, 15, 30, 45]) {
      expect(cronMatches("0,15,30,45 * * * *", at(2026, 9, 6, 1, m))).toBe(true);
    }
    expect(cronMatches("0,15,30,45 * * * *", at(2026, 9, 6, 1, 16))).toBe(false);
  });

  test("a range fires inside it only", () => {
    expect(cronMatches("0 9-17 * * *", at(2026, 9, 6, 9, 0))).toBe(true);
    expect(cronMatches("0 9-17 * * *", at(2026, 9, 6, 17, 0))).toBe(true);
    expect(cronMatches("0 9-17 * * *", at(2026, 9, 6, 18, 0))).toBe(false);
  });

  test("a bare number in a field means only that value", () => {
    expect(cronMatches("0 6 * * *", at(2026, 9, 6, 6, 0))).toBe(true);
    expect(cronMatches("0 6 * * *", at(2026, 9, 6, 7, 0))).toBe(false);
  });

  test("day-of-week — 2026-09-07 is a Monday", () => {
    expect(cronMatches("0 6 * * 1", at(2026, 9, 7, 6, 0))).toBe(true);
    expect(cronMatches("0 6 * * 1", at(2026, 9, 8, 6, 0))).toBe(false);
  });

  test("day-of-week 7 is Sunday, like 0 — 2026-09-06 is a Sunday", () => {
    expect(cronMatches("0 6 * * 7", at(2026, 9, 6, 6, 0))).toBe(true);
    expect(cronMatches("0 6 * * 0", at(2026, 9, 6, 6, 0))).toBe(true);
  });

  test("dom and dow both restricted: either one matching is enough", () => {
    // The 1st of the month, or any Monday.
    expect(cronMatches("0 6 1 * 1", at(2026, 9, 1, 6, 0))).toBe(true);
    expect(cronMatches("0 6 1 * 1", at(2026, 9, 7, 6, 0))).toBe(true);
    expect(cronMatches("0 6 1 * 1", at(2026, 9, 8, 6, 0))).toBe(false);
  });

  test("a 6-field expression drops the seconds field", () => {
    expect(cronMatches("30 0 6 * * *", at(2026, 9, 6, 6, 0))).toBe(true);
  });

  test("a Quartz extension the evaluator cannot read matches everything rather than nothing", () => {
    expect(cronMatches("0 6 L * ?", at(2026, 9, 6, 6, 0))).toBe(true);
  });

  test("a malformed expression matches nothing", () => {
    expect(cronMatches("not a cron", at(2026, 9, 6, 6, 0))).toBe(false);
  });
});

describe("cronDueBetween", () => {
  test("a firing minute inside the window is due", () => {
    expect(cronDueBetween("*/10 * * * *", at(2026, 9, 6, 13, 22), at(2026, 9, 6, 13, 35))).toBe(true);
  });

  test("a window with no firing minute is not due", () => {
    expect(cronDueBetween("*/10 * * * *", at(2026, 9, 6, 13, 31), at(2026, 9, 6, 13, 39))).toBe(false);
  });

  test("the window is half-open: the `after` minute itself does not count again", () => {
    expect(cronDueBetween("*/10 * * * *", at(2026, 9, 6, 13, 30), at(2026, 9, 6, 13, 30))).toBe(false);
  });

  test("the upper bound counts", () => {
    expect(cronDueBetween("*/10 * * * *", at(2026, 9, 6, 13, 39), at(2026, 9, 6, 13, 40))).toBe(true);
  });

  test("several missed fires collapse into one due answer", () => {
    expect(cronDueBetween("* * * * *", at(2026, 9, 6, 13, 0), at(2026, 9, 6, 13, 30))).toBe(true);
  });

  test("a window longer than the scan cap is due without scanning", () => {
    expect(cronDueBetween("0 6 1 1 *", at(2020, 1, 1, 0, 0), at(2026, 9, 6, 0, 0))).toBe(true);
  });

  test("a backwards window is never due", () => {
    expect(cronDueBetween("* * * * *", at(2026, 9, 6, 13, 30), at(2026, 9, 6, 13, 0))).toBe(false);
  });
});
