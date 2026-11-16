import type { ReleaseCommandDoc } from "./types";

/** `chant release changed`: its entry in `chant --help` and the `release` usage line. */
export const changedCommand: ReleaseCommandDoc = {
  name: "changed",
  helpOrder: 140,
  help: [
    "  release changed [--at <sha>] [--bump-member <member>=<level>]... [--json]",
    "                        The members to release at a commit, in publish order,",
    "                        each with why: changed, needed-by <member>,",
    "                        range-broken-by <member> or intent-pending, and the",
    "                        bump the commits and intent files give, unless",
    "                        --bump-member sets it. Reads local refs only",
  ],
  usage: { order: 80, text: "release changed [--at <sha>] [--bump-member <member>=<level>]... [--json]" },
};
