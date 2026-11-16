import type { ReleaseCommandDoc } from "./types";

/** `chant release list`: its entry in `chant --help` and the `release` usage line. */
export const listCommand: ReleaseCommandDoc = {
  name: "list",
  helpOrder: 150,
  help: [
    "  release list [--json]  Every release of this member with its targets, its",
    "                        cuts and the environments that run it.",
  ],
  usage: { order: 110, text: "release list [--json]" },
};
