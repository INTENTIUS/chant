import type { ReleaseCommandDoc } from "./types";

/** `chant release images`: its entry in `chant --help` and the `release` usage line. */
export const imagesCommand: ReleaseCommandDoc = {
  name: "images",
  helpOrder: 60,
  help: [
    "  release images <label|digest> [--no-build] [-o <file>] [--json]",
    "                        Build the images release.images declares again from",
    "                        the release's commit, refuse one whose digest is not",
    "                        the recorded one, and write the recorded digests to",
    "                        the file CHANT_RELEASE_DIGESTS names for the build.",
  ],
  usage: { order: 50, text: "release images <label|digest> [--no-build] [-o <file>] [--json]" },
};
