/**
 * The floors check against origin's tag list, which lacks chant-v0.81.0
 * (#4503). MEMBER_LEDGER_FLOOR and READ_CONTRACT_FLOOR name 0.81.0, which npm
 * lists, so the check passes only when it asks npm, and the publish path
 * (scripts/release-pack.sh) and `just release` must ask it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { freezeFloorSource, freezeTextList, nextPatch, releasedVersions, shippedSymbolic, unreleasedFloors } from "./release-floors";

const root = join(import.meta.dirname, "..");

/** `git ls-remote origin 'refs/tags/chant-v0.8*'` on 2026-10-26: 0.80.0 then 0.82.0. */
const ORIGIN_TAGS = ["chant-v0.79.0", "chant-v0.80.0", "chant-v0.82.0", "release/npm/0.124.52"];
const NPM_VERSIONS = ["0.79.0", "0.80.0", "0.81.0", "0.82.0", "0.124.52"];

const FLOORS = [
  { name: "MEMBER_LEDGER_FLOOR", file: "packages/core/src/lifecycle/member-ledger.ts", version: "0.81.0" },
  { name: "READ_CONTRACT_FLOOR", file: "packages/core/src/workspace/reason-codes.ts", version: "0.81.0" },
  { name: "OTHER_FLOOR", file: "packages/core/src/x.ts", version: "0.82.0" },
];

describe("release floors (#4503)", () => {
  it("fails the 0.81.0 floors on a tag list lacking chant-v0.81.0", () => {
    const problems = unreleasedFloors(FLOORS, releasedVersions(ORIGIN_TAGS), false);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("MEMBER_LEDGER_FLOOR names 0.81.0");
    expect(problems[1]).toContain("READ_CONTRACT_FLOOR names 0.81.0");
  });

  it("passes them when npm's published versions are read too", () => {
    expect(unreleasedFloors(FLOORS, releasedVersions(ORIGIN_TAGS, NPM_VERSIONS), true)).toEqual([]);
  });

  it("still fails a floor that neither tags nor npm know", () => {
    const problems = unreleasedFloors(
      [{ name: "NEXT_RELEASE", file: "packages/core/src/release-floors.ts", version: "0.124.53" }],
      releasedVersions(ORIGIN_TAGS, NPM_VERSIONS),
      true,
    );
    expect(problems).toEqual([
      "packages/core/src/release-floors.ts: NEXT_RELEASE names 0.124.53, which has no release tag or npm version and no local build stamp",
    ]);
  });

  it("reads both tag forms and ignores other tags", () => {
    expect([...releasedVersions(["release/npm/1.2.3", "chant-v4.5.6", "ci/abc", "release/npm/x", ""])].sort()).toEqual(["1.2.3", "4.5.6"]);
  });

  it("release-pack.sh and just release run the check with --npm", () => {
    expect(readFileSync(join(root, "scripts/release-pack.sh"), "utf8")).toMatch(/^npx tsx scripts\/release-floors\.ts --npm\b/m);
    expect(readFileSync(join(root, "justfile"), "utf8")).toMatch(/npx tsx scripts\/release-floors\.ts --npm --rev "\$sha" --release "\$next"/);
  });
});

describe("release floors --freeze (#4501)", () => {
  const SRC = [
    'import { other } from "./other";',
    'import { NEXT_RELEASE } from "./release-floors";',
    "",
    'export const OLD_FLOOR = "0.124.30";',
    "export const GROUP_FLOOR = NEXT_RELEASE;",
    "export const PLACEHOLDERS_FLOOR = NEXT_RELEASE;",
    "",
  ].join("\n");

  it("writes the shipped version in place of NEXT_RELEASE and drops the unused import", () => {
    const out = freezeFloorSource(SRC, "0.124.53");
    expect(out).toContain('export const GROUP_FLOOR = "0.124.53";');
    expect(out).toContain('export const PLACEHOLDERS_FLOOR = "0.124.53";');
    expect(out).toContain('export const OLD_FLOOR = "0.124.30";');
    expect(out).toContain('import { other } from "./other";');
    expect(out).not.toMatch(/NEXT_RELEASE/);
  });

  it("keeps the import when the file still names NEXT_RELEASE elsewhere", () => {
    const out = freezeFloorSource(`${SRC}const shown = \`chant \${NEXT_RELEASE}\`;\n`, "0.124.53");
    expect(out).toContain('import { NEXT_RELEASE } from "./release-floors";');
    expect(out).toContain('export const GROUP_FLOOR = "0.124.53";');
  });

  it("leaves a file with no symbolic floor as it is", () => {
    const src = 'export const OLD_FLOOR = "0.124.30";\n';
    expect(freezeFloorSource(src, "0.124.53")).toBe(src);
  });

  it("freezes every symbolic floor in core's sources", () => {
    for (const file of ["packages/core/src/change-set.ts", "packages/core/src/pr-loop.ts", "packages/core/src/lifecycle/query.ts"]) {
      const out = freezeFloorSource(readFileSync(join(root, file), "utf8"), "0.124.53");
      expect(out, file).not.toMatch(/_FLOOR = NEXT_RELEASE;/);
    }
  });

  it("empties NEXT_RELEASE_TEXT in the script and keeps the rest", () => {
    const src = readFileSync(join(root, "scripts/release-floors.ts"), "utf8");
    const out = freezeTextList(src);
    const list = out.slice(out.indexOf("const NEXT_RELEASE_TEXT:"), out.indexOf("\n];\n", out.indexOf("const NEXT_RELEASE_TEXT:")) + 4);
    // The declaration line carries the type `{ file: string; ... }`; only entry lines must go.
    expect(list).not.toMatch(/^\s*\{ file: /m);
    expect(list).toMatch(/= \[\n[\s\S]*\n\];\n$/);
    expect(out.length).toBeLessThan(src.length);
    expect(out.slice(out.indexOf("interface Args"))).toBe(src.slice(src.indexOf("interface Args")));
    expect(freezeTextList(out)).toBe(out);
  });

  it("moves NEXT_RELEASE to the next patch by default", () => {
    expect(nextPatch("0.124.53")).toBe("0.124.54");
    expect(nextPatch("1.9.99")).toBe("1.9.100");
  });

  it("fails while a floor is still NEXT_RELEASE after its version shipped", () => {
    const named = [
      { name: "NEXT_RELEASE", file: "packages/core/src/release-floors.ts", version: "0.124.53" },
      { name: "GROUP_FLOOR", file: "packages/core/src/change-set.ts", version: "0.124.53", symbolic: true },
      { name: "OLD_FLOOR", file: "packages/core/src/x.ts", version: "0.124.53" },
    ];
    expect(shippedSymbolic("0.124.53", named, releasedVersions([], ["0.124.52"]))).toEqual([]);
    expect(shippedSymbolic("0.124.53", named, releasedVersions(["release/npm/0.124.53"]))).toEqual([
      "packages/core/src/change-set.ts: GROUP_FLOOR is NEXT_RELEASE, and 0.124.53 has shipped; run `just release-floors --freeze 0.124.53`",
    ]);
  });
});
