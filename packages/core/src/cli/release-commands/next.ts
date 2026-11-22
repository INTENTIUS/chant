import type { ReleaseCommandDoc } from "./types";

/** `chant release next`: its entry in `chant --help` and the `release` usage line. */
export const nextCommand: ReleaseCommandDoc = {
  name: "next",
  helpOrder: 130,
  help: [
    "  release next [--at <sha>] [--pre <id>] [--first <version>] [--json]",
    "                        The label of this member's next release, from the",
    "                        conventional commits since its previous release and",
    "                        the .chant/release/*.md intent files no cut consumed.",
    "                        --pre <id> makes it a prerelease, <version>-<id>.<n>.",
    "                        --first <version> is the label when the member has",
    "                        no previous release in its ledger or its tags.",
  ],
  usage: { order: 70, text: "release next [--at <sha>] [--pre <id>] [--first <version>] [--json]" },
};
