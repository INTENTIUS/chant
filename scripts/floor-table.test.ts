/**
 * The floor table (#4792) lists every floor chant core exports, at the
 * version its constant names, and scripts/floor-table.ts reads each floor's
 * comment, issue and subpaths the way the table says.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FLOOR_TABLE } from "../packages/core/src/floor-table";
import { NEXT_RELEASE } from "../packages/core/src/release-floors";
import { docBefore, firstSentence, floorRows, issueOf, renderTable, tableAgainst, TABLE_FILE } from "./floor-table";

const root = join(import.meta.dirname, "..");

describe("the floor table (#4792)", () => {
  it("is what scripts/floor-table.ts writes from the floors in the tree", () => {
    const { want, have } = tableAgainst(root);
    expect(have, `${TABLE_FILE} is stale; run npx tsx scripts/floor-table.ts`).toBe(want);
  });

  it("lists every exported floor under packages/core/src at the version its constant names", () => {
    const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "packages/core/src"], { cwd: root, encoding: "utf-8" })
      .split("\n")
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    const declared: { name: string; file: string; version: string }[] = [];
    for (const file of files) {
      const src = readFileSync(join(root, file), "utf-8");
      for (const m of src.matchAll(/export const ([A-Z0-9_]+_FLOOR) = (?:"(\d+\.\d+\.\d+)"|(NEXT_RELEASE));/g)) {
        declared.push({ name: m[1], file: file.slice("packages/core/src/".length), version: m[2] ?? NEXT_RELEASE });
      }
    }
    expect(declared.length).toBeGreaterThan(100);
    const listed = new Set(FLOOR_TABLE.map((r) => `${r.file}|${r.name}|${r.version}`));
    expect(declared.filter((d) => !listed.has(`${d.file}|${d.name}|${d.version}`))).toEqual([]);
  });
});

describe("scripts/floor-table.ts (#4792)", () => {
  const SRC = [
    "/** The first chant with `x.y` (`a.b`), and {@link thing}. More text (#4787). */",
    'export const A_FLOOR = "0.124.80";',
    "/** The first chant whose terraform `apply` takes `dir` (terragucci issue 1303). */",
    "export const B_FLOOR = NEXT_RELEASE;",
    "export const C_FLOOR = A_FLOOR;",
  ].join("\n");
  const files: Record<string, string> = {
    "packages/core/src/a.ts": SRC,
    "packages/core/src/index.ts": 'export * from "./a";\n',
    "packages/core/src/op/index.ts": 'export { B_FLOOR, other } from "../a";\n',
  };
  const read = (f: string) => files[f]!;

  it("reads the comment's first sentence and its issue", () => {
    const doc = docBefore(SRC, SRC.indexOf("export const A_FLOOR"));
    expect(firstSentence(doc)).toBe("The first chant with `x.y` (`a.b`), and thing.");
    expect(issueOf(doc)).toBe("#4787");
    expect(issueOf("The first chant (chant#4565, #4564) with a thing (terragucci issue 1303).")).toBe("terragucci issue 1303");
    expect(issueOf("no issue")).toBeUndefined();
  });

  it("names each subpath that serves a floor, keeps NEXT_RELEASE, and follows an alias", () => {
    const rows = floorRows(Object.keys(files), read, { ".": { default: "./src/index.ts" }, "./op": { default: "./src/op/index.ts" }, "./*": "./src/*.ts" });
    expect(rows.map((r) => [r.name, r.version, r.issue, r.modules])).toEqual([
      ["A_FLOOR", "0.124.80", "#4787", ["@intentius/chant", "@intentius/chant/a", "@intentius/chant/index"]],
      ["B_FLOOR", "NEXT_RELEASE", "terragucci issue 1303", ["@intentius/chant", "@intentius/chant/a", "@intentius/chant/index", "@intentius/chant/op", "@intentius/chant/op/index"]],
      ["C_FLOOR", "0.124.80", undefined, ["@intentius/chant", "@intentius/chant/a", "@intentius/chant/index"]],
    ]);
    const text = renderTable(rows);
    expect(text).toContain('{ name: "B_FLOOR", version: NEXT_RELEASE,');
    expect(text).toContain('{ name: "A_FLOOR", version: "0.124.80",');
  });
});
