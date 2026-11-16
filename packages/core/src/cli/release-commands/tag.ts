import type { ReleaseCommandDoc } from "./types";

/** `chant release tag`: its entry in `chant --help` and the `release` usage line. */
export const tagCommand: ReleaseCommandDoc = {
  name: "tag",
  helpOrder: 100,
  help: [
    "  release tag <label|digest|tag> [--json]",
    "                        The tag release.tag gives a release of this member",
    "                        (default release/<label>), found by its label, its",
    "                        digest or the tag itself, with its floating tag.",
  ],
  usage: { order: 130, text: "release tag <label|digest|tag> [--json]" },
};
