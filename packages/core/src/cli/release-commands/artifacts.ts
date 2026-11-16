import type { ReleaseCommandDoc } from "./types";

/** `chant release artifacts`: its entry in `chant --help` and the `release` usage line. */
export const artifactsCommand: ReleaseCommandDoc = {
  name: "artifacts",
  helpOrder: 80,
  help: [
    "  release artifacts <label|digest> [--no-build] [--from <dir>] [-o <dir>] [--json]",
    "                        Build the files release.artifacts declares again from",
    "                        the release's commit, or check those on disk",
    "                        (--no-build) or copied from <dir> (--from), and",
    "                        refuse one whose digest is not the recorded one. -o",
    "                        stages the checked files in <dir> for the next job.",
  ],
  usage: { order: 60, text: "release artifacts <label|digest> [--no-build] [--from <dir>] [-o <dir>] [--json]" },
};
