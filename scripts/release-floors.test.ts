/**
 * The floors check against origin's tag list, which lacks chant-v0.81.0
 * (#4503). MEMBER_LEDGER_FLOOR and READ_CONTRACT_FLOOR name 0.81.0, which npm
 * lists, so the check passes only when it asks npm, and the publish path
 * (scripts/release-pack.sh) and `just release` must ask it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { releasedVersions, unreleasedFloors } from "./release-floors";

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
