import type { ReleaseCommandDoc } from "./types";

/** `chant release compose`: its entry in `chant --help` and the `release` usage line. */
export const composeCommand: ReleaseCommandDoc = {
  name: "compose",
  helpOrder: 20,
  help: [
    "  release compose <name> [--base <label|sha>] (--pr <n> | --work <id>)...",
    "                  [--yes] [--json]",
    "                        Cherry-pick the chosen trunk changes, in trunk order,",
    "                        onto the base, each with a Chant-Composed-From",
    "                        trailer, on chant/compose/<name>. Appends to a branch",
    "                        that exists; stops on a conflict, naming the change",
    "                        and files, and writes nothing. A dry run unless --yes,",
    "                        which moves the branch and pushes it.",
  ],
  usage: { order: 100, text: "release compose <name> [--base <label|sha>] (--pr <n> | --work <id>)... [--yes] [--json]" },
};
