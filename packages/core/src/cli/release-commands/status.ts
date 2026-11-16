import type { ReleaseCommandDoc } from "./types";

/** `chant release deprecate|yank|restore`: its entry in `chant --help` and the `release` usage line. */
export const statusCommand: ReleaseCommandDoc = {
  name: "deprecate|yank|restore",
  helpOrder: 170,
  help: [
    "  release deprecate|yank|restore <label|digest> [--yes] [--reason <text>]",
    "                        [--replacement <label>] [--forge-release prerelease|draft|delete]",
    "                        [--actor <name>] [--sign [<key file>]] [--json]",
    "                        Record a status for a published release and act on",
    "                        each target that can: deprecate warns npm users; yank",
    "                        also moves npm's dist-tag and the OCI moving tags back",
    "                        to the previous active release, withdraws the forge",
    "                        release and reverts a tap's formula; restore undoes",
    "                        it. A dry run unless --yes; resumes like publish.",
  ],
  usage: { order: 150, text: "release deprecate|yank|restore <label|digest> [--yes] [--reason <text>] [--replacement <label>] [--forge-release prerelease|draft|delete] [--actor <name>] [--sign [<key file>]] [--json]" },
};
