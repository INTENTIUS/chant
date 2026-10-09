import { describe, expect, test } from "vitest";
import { detectDrift } from "./lifecycle";

const BOLD = "\u001b[1m";
const RESET = "\u001b[0m";

// Renders as `chant lifecycle diff <env> --live` printed them against the sql
// emulator (#3642), bold headers included: the activity reads them off a
// child process, colour and all.
const HEAD = `${BOLD}sql${RESET} — environment: watch\n`;
const CLEAN = `${HEAD}0 missing, 0 orphan, 0 disappeared, 0 newly observed, 0 drifted, 3 unchanged\n${"-".repeat(80)}\n\u001b[32mNo drift detected across 1 lexicon(s)${RESET}`;
const PROPERTY = `${HEAD}0 missing, 0 orphan, 0 disappeared, 0 newly observed, 0 drifted, 3 unchanged\n${"-".repeat(80)}\n\n${BOLD}sql (properties)${RESET}\n1 property drift across 1 resource(s), 0 accepted, 2 unchanged\n${"-".repeat(80)}\n${BOLD}\nPROPERTY DRIFT (declared vs live; baseline shown where one exists):${RESET}\n  - events (ClickHouse::Table)\n      ttl: ts + INTERVAL 180 DAY → ts + toIntervalDay(30) [from: authored]`;
const MISSING = `${HEAD}1 missing, 0 orphan, 0 disappeared, 0 newly observed, 0 drifted, 2 unchanged\n${"-".repeat(80)}\n${BOLD}\nMISSING (declared, provider reports not in cloud):${RESET}\n  - byKind [queried http://127.0.0.1:8123 yodel_3642.by_kind]`;

describe("detectDrift", () => {
  test("a clean render is not drift", () => {
    expect(detectDrift(CLEAN)).toBe(false);
  });

  test("an owned object's property changed out of band is drift (PROPERTY DRIFT)", () => {
    expect(detectDrift(PROPERTY)).toBe(true);
  });

  test("a declared object gone from the server is drift (MISSING)", () => {
    expect(detectDrift(MISSING)).toBe(true);
  });

  test("the counts line alone, lower case, is not drift", () => {
    expect(detectDrift("1 property drift across 1 resource(s)")).toBe(false);
  });
});
