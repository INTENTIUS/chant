import { describe, test, expect } from "vitest";
import { microTime, isMicroTimeFormatted } from "./micro-time";

describe("microTime", () => {
  test("formats a Date with 6 fractional digits + Z", () => {
    const d = new Date("2026-05-11T21:25:36.495Z");
    expect(microTime(d)).toBe("2026-05-11T21:25:36.495000Z");
  });

  test("handles dates whose ms is zero", () => {
    const d = new Date("2026-01-01T00:00:00.000Z");
    expect(microTime(d)).toBe("2026-01-01T00:00:00.000000Z");
  });

  test("defaults to current time when called with no args", () => {
    const out = microTime();
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
  });

  test("output is accepted by isMicroTimeFormatted()", () => {
    expect(isMicroTimeFormatted(microTime(new Date()))).toBe(true);
  });
});

describe("isMicroTimeFormatted", () => {
  test("accepts canonical MicroTime strings", () => {
    expect(isMicroTimeFormatted("2026-05-11T21:25:36.495000Z")).toBe(true);
    expect(isMicroTimeFormatted("2026-05-11T21:25:36.000000Z")).toBe(true);
  });

  test("rejects nanosecond precision (the bug this helper avoids)", () => {
    // time.RFC3339Nano in Go: 9 fractional digits
    expect(isMicroTimeFormatted("2026-05-11T21:25:36.495095754Z")).toBe(false);
  });

  test("rejects millisecond precision (Date.toISOString() shape)", () => {
    expect(isMicroTimeFormatted("2026-05-11T21:25:36.495Z")).toBe(false);
  });

  test("rejects non-UTC offset", () => {
    expect(isMicroTimeFormatted("2026-05-11T21:25:36.495000-05:00")).toBe(false);
  });

  test("rejects garbage", () => {
    expect(isMicroTimeFormatted("yesterday")).toBe(false);
    expect(isMicroTimeFormatted("")).toBe(false);
  });
});
