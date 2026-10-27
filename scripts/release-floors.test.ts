/**
 * The floors check against origin's tag list, which lacks chant-v0.81.0
 * (#4503). MEMBER_LEDGER_FLOOR and READ_CONTRACT_FLOOR name 0.81.0, which npm
 * lists, so the check passes only when it asks npm, and the publish path
 * (scripts/release-pack.sh) and `just release` must ask it.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { freezeFloorSource, freezeTextList, nextPatch, releasedVersions, shippedSymbolic, splitFreeze, staleFloorTests, unreleasedFloors } from "./release-floors";

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
    // The live list holds whatever floors were added since the last release,
    // so start from it emptied, seed it with entries, and freezing must give
    // back the emptied script.
    const live = freezeTextList(readFileSync(join(root, "scripts/release-floors.ts"), "utf8"));
    const marker = "  // --freeze empties this list after a release ships (#4501); each entry is one line.\n";
    expect(live).toContain(marker);
    const src = live.replace(
      marker,
      marker +
        '  { file: "packages/core/src/workspace/change-set.schema.json", text: "by #4440, written by chant {v} and newer", count: 1, floor: "CHANGE_SET_GROUP_FLOOR" },\n' +
        '  { file: "docs/src/content/docs/reference/capabilities.mdx", text: "templates are written by chant `{v}` and newer", count: 1, floor: "CAPABILITY_TEMPLATES_FLOOR" },\n',
    );
    const out = freezeTextList(src);
    expect(freezeTextList(live)).toBe(live);
    const list = out.slice(out.indexOf("const NEXT_RELEASE_TEXT:"), out.indexOf("\n];\n", out.indexOf("const NEXT_RELEASE_TEXT:")) + 4);
    // The declaration line carries the type `{ file: string; ... }`; only entry lines must go.
    expect(list).not.toMatch(/^\s*\{ file: /m);
    expect(list).toMatch(/= \[\n[\s\S]*\n\];\n$/);
    expect(out.length).toBeLessThan(src.length);
    expect(out.slice(out.indexOf("interface Args"))).toBe(src.slice(src.indexOf("interface Args")));
    expect(freezeTextList(out)).toBe(out);
    expect(out).toBe(live);
  });

  it("keeps the entries of a floor that stays NEXT_RELEASE (#4540)", () => {
    const live = freezeTextList(readFileSync(join(root, "scripts/release-floors.ts"), "utf8"));
    const marker = "  // --freeze empties this list after a release ships (#4501); each entry is one line.\n";
    const shipped = '  { file: "a.json", text: "chant {v}", count: 1, floor: "SHIPPED_FLOOR" },\n';
    const later = '  { file: "b.mdx", text: "chant {v} or newer", count: 1, floor: "LATER_FLOOR" },\n';
    const out = freezeTextList(live.replace(marker, marker + shipped + later), new Set(["LATER_FLOOR"]));
    expect(out).toBe(live.replace(marker, marker + later));
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
    // release-pack.sh stamps the tree with the version it packs; that pack is
    // the release, so its own tag doesn't make its floors "shipped" yet.
    expect(shippedSymbolic("0.124.53", named, releasedVersions(["release/npm/0.124.53"]), "0.124.53")).toEqual([]);
    // A stamp for some other version doesn't excuse a shipped NEXT_RELEASE.
    expect(shippedSymbolic("0.124.53", named, releasedVersions(["release/npm/0.124.53"]), "0.124.54").length).toBeGreaterThan(0);
  });
});

describe("release floors --freeze, scoped to the release commit (#4540)", () => {
  it("freezes only the named floors and keeps the import the others still need", () => {
    const src = ['import { NEXT_RELEASE } from "./release-floors";', "export const SHIPPED_FLOOR = NEXT_RELEASE;", "export const LATER_FLOOR = NEXT_RELEASE;", ""].join("\n");
    const out = freezeFloorSource(src, "0.124.54", new Set(["SHIPPED_FLOOR"]));
    expect(out).toBe(['import { NEXT_RELEASE } from "./release-floors";', 'export const SHIPPED_FLOOR = "0.124.54";', "export const LATER_FLOOR = NEXT_RELEASE;", ""].join("\n"));
    expect(freezeFloorSource(src, "0.124.54", new Set())).toBe(src);
  });

  it("a floor that appears after the release commit stays NEXT_RELEASE", () => {
    const atRelease = [
      { name: "SHIPPED_FLOOR", file: "packages/core/src/a.ts", version: "0.124.54", symbolic: true },
      { name: "OLD_FLOOR", file: "packages/core/src/a.ts", version: "0.124.30" },
    ];
    const now = [
      ...atRelease,
      // DEPLOY_ADOPT_FLOOR's case: merged after the 0.124.54 cut, never shipped in it.
      { name: "DEPLOY_ADOPT_FLOOR", file: "packages/core/src/b.ts", version: "0.124.54", symbolic: true },
    ];
    expect(splitFreeze(atRelease, now)).toEqual({ freeze: ["SHIPPED_FLOOR"], keep: ["DEPLOY_ADOPT_FLOOR"] });
  });

  it("names the tests a freeze leaves stale", () => {
    const tests = [
      { file: "packages/core/src/a.test.ts", src: "expect(SHIPPED_FLOOR).toBe(NEXT_RELEASE);" },
      { file: "packages/core/src/b.test.ts", src: "expect(LATER_FLOOR).toBe(NEXT_RELEASE);" },
      { file: "packages/core/src/x-bundle.test.ts", src: '"packages/core/src/plan-summary.ts",\n"packages/core/src/release-floors.ts",' },
    ];
    expect(staleFloorTests(tests, new Set(["SHIPPED_FLOOR"]), true)).toEqual([
      "packages/core/src/a.test.ts: asserts toBe(NEXT_RELEASE) and names SHIPPED_FLOOR, which now hold the literal; assert the version",
      "packages/core/src/x-bundle.test.ts: lists packages/core/src/release-floors.ts in an expected module list; a frozen floor file no longer imports it, so check the bundle still does",
    ]);
    expect(staleFloorTests(tests, new Set(["SHIPPED_FLOOR"]), false)).toHaveLength(1);
  });

  it("freezes a repository's floors against its release tag, leaving one merged after it", () => {
    const repo = mkdtempSync(join(tmpdir(), "chant-release-floors-"));
    try {
      const write = (file: string, text: string) => {
        mkdirSync(dirname(join(repo, file)), { recursive: true });
        writeFileSync(join(repo, file), text);
      };
      const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd: repo, encoding: "utf-8" });
      git("init", "-q");
      write("scripts/release-floors.ts", readFileSync(join(root, "scripts/release-floors.ts"), "utf8"));
      write("packages/core/src/release-floors.ts", 'export const NEXT_RELEASE = "0.124.54";\n');
      write("packages/core/src/a.ts", 'import { NEXT_RELEASE } from "./release-floors";\nexport const SHIPPED_FLOOR = NEXT_RELEASE;\n');
      git("add", "-A");
      git("commit", "-q", "-m", "cut");
      git("tag", "release/npm/0.124.54");
      write("packages/core/src/b.ts", 'import { NEXT_RELEASE } from "./release-floors";\nexport const LATER_FLOOR = NEXT_RELEASE;\n');
      git("add", "-A");
      git("commit", "-q", "-m", "after the cut");
      const tsx = join(root, "node_modules", ".bin", "tsx");
      const printed = execFileSync(tsx, ["scripts/release-floors.ts", "--freeze", "0.124.54"], { cwd: repo, encoding: "utf-8" });
      expect(printed).toContain("left on NEXT_RELEASE, merged after 0.124.54's commit: LATER_FLOOR");
      expect(readFileSync(join(repo, "packages/core/src/a.ts"), "utf8")).toBe('export const SHIPPED_FLOOR = "0.124.54";\n');
      expect(readFileSync(join(repo, "packages/core/src/b.ts"), "utf8")).toContain("export const LATER_FLOOR = NEXT_RELEASE;");
      expect(readFileSync(join(repo, "packages/core/src/release-floors.ts"), "utf8")).toBe('export const NEXT_RELEASE = "0.124.55";\n');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("refuses with no release tag and no --rev", () => {
    const repo = mkdtempSync(join(tmpdir(), "chant-release-floors-"));
    try {
      mkdirSync(join(repo, "scripts"), { recursive: true });
      mkdirSync(join(repo, "packages/core/src"), { recursive: true });
      writeFileSync(join(repo, "scripts/release-floors.ts"), readFileSync(join(root, "scripts/release-floors.ts"), "utf8"));
      writeFileSync(join(repo, "packages/core/src/release-floors.ts"), 'export const NEXT_RELEASE = "0.124.54";\n');
      execFileSync("git", ["init", "-q"], { cwd: repo });
      const tsx = join(root, "node_modules", ".bin", "tsx");
      expect(() => execFileSync(tsx, ["scripts/release-floors.ts", "--freeze", "0.124.54"], { cwd: repo, encoding: "utf-8", stdio: "pipe" })).toThrow(/no release\/npm\/0\.124\.54 or chant-v0\.124\.54 tag.*--rev/s);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
