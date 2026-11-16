/** #5236: the command a dry run suggests next is the same command with --yes, without --json or --dry-run. */
import { describe, expect, test } from "vitest";
import { sameWithYes } from "./release";

describe("sameWithYes", () => {
  test("drops --dry-run and --json, adds --yes once, and quotes what the shell would split", () => {
    expect(sameWithYes(["release", "cut", "auto", "--dry-run", "--build", "npm run build"])).toBe("chant release cut auto --build 'npm run build' --yes");
    expect(sameWithYes(["release", "cut", "v1", "--json", "--yes"])).toBe("chant release cut v1 --yes");
  });
});
