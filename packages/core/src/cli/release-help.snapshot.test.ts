/**
 * #5196: the `release` usage line and the Releases section of `chant
 * --help`, byte for byte. Both are
 * built from the per-subcommand entries in ./release-commands; a change to an
 * entry updates these files with `npx vitest run -u`.
 */
import { describe, expect, test } from "vitest";
import { join } from "node:path";
import { helpText } from "./main";
import { USAGE } from "./handlers/release";

const SNAPSHOTS = join(__dirname, "__snapshots__");

describe("release usage and help (#5196)", () => {
  test("the release usage line", async () => {
    await expect(`${USAGE}\n`).toMatchFileSnapshot(join(SNAPSHOTS, "release-usage.txt.snap"));
  });

  test("the Releases section of chant --help", async () => {
    const help = helpText();
    const start = help.indexOf("\nReleases:\n");
    const end = help.indexOf("\nChange sets:\n", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    await expect(help.slice(start + 1, end + 1)).toMatchFileSnapshot(join(SNAPSHOTS, "release-help.txt.snap"));
  });
});
