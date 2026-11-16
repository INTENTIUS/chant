import type { ReleaseCommandDoc } from "./types";

/** `chant release export`: its entry in `chant --help` and the `release` usage line. */
export const exportCommand: ReleaseCommandDoc = {
  name: "export",
  helpOrder: 160,
  help: [
    "  release export <label|digest> --env <env> [-o <dir>] [--json]",
    "                        Write the files the release recorded for <env>, each",
    "                        checked against its digest, at their recorded paths",
    "                        under <dir> (default: here), for a deploy to read.",
  ],
  usage: { order: 140, text: "release export <label|digest> --env <env> [-o <dir>] [--json]" },
};
