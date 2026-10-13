import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
// @ts-expect-error: a plain .mjs script with no type declarations
import { draftFromRow, readTable, renderFile, splitRow, takeRevision, toYaml } from "./import-decisions.mjs";

const SCRIPT = join(import.meta.dirname, "import-decisions.mjs");

const BODY = `# Design

## Decisions

Chosen by one maintainer.

| Topic | Chosen | Rejected |
|---|---|---|
| Joins | exact declared, core \`joinKey()\` | tool matchers; exact or folded everywhere |
| Root shrink (v8) | fail unless \`--root-only\` | accept and show (v6); no exclusion |

| Audit extensions | lexicons only | plugin \`auditChecks()\` |

After the table.
`;

describe("readTable", () => {
  test("reads every row, across a blank line inside the table", () => {
    const rows = readTable(BODY, "Decisions");
    expect(rows.map((r: { topic: string }) => r.topic)).toEqual(["Joins", "Root shrink (v8)", "Audit extensions"]);
  });

  test("keeps pipes inside backticks in one cell", () => {
    expect(splitRow("| a | `x | y` | c |")).toEqual(["a", "`x | y`", "c"]);
  });

  test("fails loudly when the heading is missing", () => {
    expect(() => readTable(BODY, "Choices")).toThrow(/no heading/);
  });
});

describe("draftFromRow", () => {
  const opts = { id: "ws-002", issue: "INTENTIUS/chant#2524", state: "decided", decidedBy: "lex00", decidedOn: "2026-09-23" };

  test("an earlier choice becomes a rejected option that the draft supersedes", () => {
    const [, row] = readTable(BODY, "Decisions");
    const d = draftFromRow(row, opts);
    expect(d.title).toBe("Root shrink");
    expect(d.source).toEqual({ issue: "INTENTIUS/chant#2524", row: "Root shrink (v8)", revision: "v8" });
    expect(d.options.map((o: { label: string }) => o.label)).toEqual(["fail unless `--root-only`", "accept and show", "no exclusion"]);
    expect(d.options[1].chosen_in).toBe("v6");
    expect(d.supersedes).toEqual([{ revision: "v6", option: "b" }]);
    expect(d.rejected).toEqual([
      { option: "b", why: null },
      { option: "c", why: null },
    ]);
  });

  test("takeRevision leaves unmarked text alone", () => {
    expect(takeRevision("per file")).toEqual({ text: "per file", revision: null });
  });
});

describe("toYaml", () => {
  test("round-trips through YAML's JSON schema with every string quoted", () => {
    const value = { a: "no", b: "2026-09-23", c: null, d: 1, e: [], f: [{ g: "x: y", h: ["#1"] }], i: { j: true } };
    const text = toYaml(value);
    expect(yaml.load(text, { schema: yaml.JSON_SCHEMA })).toEqual(value);
    expect(text).toContain('a: "no"');
  });
});

describe("the CLI", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "decisions-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

  test("imports drafts that --check then rejects until they are written up", () => {
    const body = join(dir, "body.md");
    writeFileSync(body, BODY);
    const out = join(dir, "out");
    const imported = run("--body", body, "--issue", "INTENTIUS/chant#2524", "--prefix", "ws", "--dir", out);
    expect(imported.status).toBe(0);
    expect(readdirSync(out).sort()).toEqual(["ws-001-joins.md", "ws-002-root-shrink.md", "ws-003-audit-extensions.md"]);
    expect(readFileSync(join(out, "ws-002-root-shrink.md"), "utf8")).toBe(
      renderFile(draftFromRow(readTable(BODY, "Decisions")[1], { id: "ws-002", issue: "INTENTIUS/chant#2524", state: "decided" })),
    );

    const again = run("--body", body, "--issue", "INTENTIUS/chant#2524", "--prefix", "ws", "--dir", out);
    expect(again.stdout).toContain("3 skipped");

    const checked = run("--check", "--dir", out);
    expect(checked.status).toBe(1);
    expect(checked.stderr).toContain("ws-001-joins.md");
  });

  test("the committed decision files pass --check", () => {
    const checked = run("--check");
    expect(checked.stderr).toBe("");
    expect(checked.status).toBe(0);
  });
});
