import type { ReleaseCommandDoc } from "./types";

/** `chant release stamp`: its entry in `chant --help`; the `release` usage line leaves it out. */
export const stampCommand: ReleaseCommandDoc = {
  name: "stamp",
  helpOrder: 90,
  help: [
    "  release stamp <label> [--train <id|digest>] [--json]",
    "                        Write the label as the version of each package.json",
    "                        release.version names, and the lockfile's entries for",
    "                        them, as the cut does before its build. The publish",
    "                        job runs it before its build. With ranges set in",
    "                        release.version, each workspace dependency's range",
    "                        takes the label its package has; --train gives the",
    "                        labels of the other members' packages from a train.",
  ],
};
