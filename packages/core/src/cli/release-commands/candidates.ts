import type { ReleaseCommandDoc } from "./types";

/** `chant release candidates`: its entry in `chant --help` and the `release` usage line. */
export const candidatesCommand: ReleaseCommandDoc = {
  name: "candidates",
  helpOrder: 30,
  help: [
    "  release candidates [--env <env>] [--lane <name>] [--forge-issues] [--json]",
    "                        The green commits of trunk a release can be cut from,",
    "                        newest first, each with the commits, work items, pull",
    "                        requests and flags it would ship, and what each",
    "                        environment runs. --lane reads a lane's green tags,",
    "                        as release cut --lane checks them. --forge-issues asks",
    "                        the forge which issues each pull request closes, once",
    "                        per pull request",
  ],
  usage: { order: 90, text: "release candidates [--env <env>] [--lane <name>] [--forge-issues] [--json]" },
};
