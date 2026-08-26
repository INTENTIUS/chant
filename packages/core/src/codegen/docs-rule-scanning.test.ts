import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { scanRules } from "./docs-rule-scanning";

// #1938: a post-synth check's `description` string containing a
// backslash-escaped quote used to truncate at the first embedded `"`,
// garbling the generated docs table entry.
describe("scanRules — post-synth description extraction (#1938)", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "docs-rule-scanning-"));
    mkdirSync(join(dir, "lint", "post-synth"), { recursive: true });
    writeFileSync(
      join(dir, "lint", "post-synth", "wk8505.ts"),
      [
        "export const wk8505 = {",
        '  id: "WK8505",',
        '  description: "A rule\'s \\"why\\" must be non-empty, and a backslash like C:\\\\path must survive intact",',
        "  check() { return []; },",
        "};",
        "",
      ].join("\n"),
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("extracts the full description past an escaped quote and a backslash", () => {
    const rules = scanRules(dir);
    const rule = rules.find((r) => r.id === "WK8505");

    expect(rule).toBeDefined();
    expect(rule?.description).toBe(
      'A rule\'s "why" must be non-empty, and a backslash like C:\\path must survive intact',
    );
  });
});
